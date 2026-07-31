#!/usr/bin/env python3
"""
EXP-0001.5 — Backend Numerical Consistency
═══════════════════════════════════════════════════════════════════════════════

Captures per-position logits across different dtypes and compares:
  - Top-1 / Top-5 / Top-10 overlap
  - KL divergence
  - Logit margin (top-1 − top-2)
  - Logit correlation (Pearson r)

Usage:
  # Single pair: PyTorch FP32 vs FP16
  python run_logit_compare.py --pair fp32_vs_fp16 --prompts ../golden/prompts.jsonl

  # All pairs
  python run_logit_compare.py --all --prompts prompts_extended.jsonl
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════

MODEL_ID = "Qwen/Qwen3-0.6B"
MAX_NEW_TOKENS = 32
TEMPERATURE = 0.0  # greedy

SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR / "output"
DEFAULT_PROMPTS = SCRIPT_DIR / "prompts_extended.jsonl"

DTYPE_MAP = {
    "fp32": torch.float32,
    "fp16": torch.float16,
    "bf16": torch.bfloat16,
}


# ═══════════════════════════════════════════════════════════════════════════════
# Inference with logit capture
# ═══════════════════════════════════════════════════════════════════════════════

def run_with_logits(
    model: AutoModelForCausalLM,
    tokenizer: AutoTokenizer,
    prompt: str,
    dtype: torch.dtype,
    device: torch.device,
    max_new_tokens: int = MAX_NEW_TOKENS,
) -> dict[str, Any]:
    """
    Generate tokens one-by-one, capturing full logit vectors at each position.
    Returns per-position data for analysis.
    """
    inputs = tokenizer(prompt, return_tensors="pt").to(device)
    input_ids = inputs["input_ids"]  # [1, seq_len]
    input_token_list: list[int] = input_ids[0].tolist()

    positions: list[dict[str, Any]] = []
    generated_ids: list[int] = []
    past_key_values = None
    current_input = input_ids

    t_start = time.time()

    for step in range(max_new_tokens):
        with torch.no_grad():
            if past_key_values is None:
                # Prefill: process all input tokens
                outputs = model(current_input, output_hidden_states=False)
            else:
                # Decode: single token
                outputs = model(
                    current_input,
                    past_key_values=past_key_values,
                    use_cache=True,
                    output_hidden_states=False,
                )

        logits = outputs.logits[0, -1, :]  # [vocab_size] — logits for next token
        past_key_values = outputs.past_key_values

        # Convert to float32 for consistent comparison
        logits_f32 = logits.to(torch.float32).cpu().numpy()

        # Greedy: pick argmax
        next_token_id = int(torch.argmax(logits, dim=-1).item())
        generated_ids.append(next_token_id)

        # Top-k analysis
        topk_values, topk_indices = torch.topk(logits, k=10, dim=-1)
        top10_ids = topk_indices.cpu().tolist()
        top10_probs = torch.softmax(topk_values, dim=-1).cpu().tolist()

        # Logit margin
        if len(topk_values) >= 2:
            margin = float(topk_values[0].item() - topk_values[1].item())
        else:
            margin = float("inf")

        # Per-position record
        positions.append({
            "pos": step,
            "token_id": next_token_id,
            "logits_f32": logits_f32.tolist(),  # full vocab logits in fp32
            "top10_ids": top10_ids,
            "top10_probs": [round(p, 6) for p in top10_probs],
            "logit_margin": round(margin, 6),
        })

        # Prepare next input
        current_input = torch.tensor([[next_token_id]], device=device)

    elapsed_ms = (time.time() - t_start) * 1000

    return {
        "prompt": prompt,
        "input_token_ids": input_token_list,
        "output_token_ids": generated_ids,
        "output_text": tokenizer.decode(generated_ids, skip_special_tokens=True),
        "dtype": str(dtype),
        "device": str(device),
        "elapsed_ms": round(elapsed_ms, 1),
        "positions": positions,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Comparison
# ═══════════════════════════════════════════════════════════════════════════════

def compare_positions(
    pos_a: dict[str, Any],
    pos_b: dict[str, Any],
) -> dict[str, Any]:
    """Compare two per-position logit records."""
    logits_a = np.array(pos_a["logits_f32"], dtype=np.float32)
    logits_b = np.array(pos_b["logits_f32"], dtype=np.float32)

    # Top-1 match
    top1_match = pos_a["token_id"] == pos_b["token_id"]

    # Top-5 / Top-10 overlap
    top5_a = set(pos_a["top10_ids"][:5])
    top5_b = set(pos_b["top10_ids"][:5])
    top10_a = set(pos_a["top10_ids"])
    top10_b = set(pos_b["top10_ids"])

    top5_overlap = len(top5_a & top5_b)
    top10_overlap = len(top10_a & top10_b)

    # KL divergence (from softmax distributions)
    prob_a = np.exp(logits_a - np.max(logits_a))
    prob_a /= prob_a.sum()
    prob_b = np.exp(logits_b - np.max(logits_b))
    prob_b /= prob_b.sum()

    # KL(P_A ‖ P_B) — add epsilon for stability
    eps = 1e-12
    kl = float(np.sum(prob_a * np.log((prob_a + eps) / (prob_b + eps))))

    # Logit correlation (Pearson r)
    logit_corr = float(np.corrcoef(logits_a, logits_b)[0, 1])

    # Logit margin comparison
    margin_a = pos_a["logit_margin"]
    margin_b = pos_b["logit_margin"]

    return {
        "pos": pos_a["pos"],
        "token_a": pos_a["token_id"],
        "token_b": pos_b["token_id"],
        "top1_match": top1_match,
        "top5_overlap": top5_overlap,
        "top10_overlap": top10_overlap,
        "kl_divergence": round(kl, 8),
        "logit_correlation": round(logit_corr, 6),
        "logit_margin_a": margin_a,
        "logit_margin_b": margin_b,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

PAIRS = {
    "fp32_vs_fp16": (torch.float32, torch.float16),
    "fp32_vs_bf16": (torch.float32, torch.bfloat16),
}


def main() -> None:
    parser = argparse.ArgumentParser(description="EXP-0001.5: Backend Numerical Consistency")
    parser.add_argument("--pair", default="fp32_vs_fp16",
                        choices=list(PAIRS.keys()),
                        help="Which dtype pair to compare")
    parser.add_argument("--prompts", default=str(DEFAULT_PROMPTS),
                        help="JSONL prompts file")
    parser.add_argument("--output", default=str(OUTPUT_DIR),
                        help="Output directory")
    parser.add_argument("--device", default="auto",
                        help="Device: auto/cpu/cuda/mps")
    parser.add_argument("--max-prompts", type=int, default=10,
                        help="Max prompts to process (default 10)")
    args = parser.parse_args()

    # ── Device ──────────────────────────────────────────────────────────────
    if args.device == "auto":
        if torch.cuda.is_available():
            device = torch.device("cuda")
        elif torch.backends.mps.is_available():
            device = torch.device("mps")
        else:
            device = torch.device("cpu")
    else:
        device = torch.device(args.device)

    print(f"Device: {device}")

    # ── Load prompts ───────────────────────────────────────────────────────
    prompts_path = Path(args.prompts)
    prompts = _load_prompts(prompts_path)[:args.max_prompts]
    print(f"Prompts: {len(prompts)} (from {prompts_path})")

    # ── Output ─────────────────────────────────────────────────────────────
    out_dir = Path(args.output)
    pair_dir = out_dir / args.pair
    pair_dir.mkdir(parents=True, exist_ok=True)
    per_pos_dir = pair_dir / "per_position"
    per_pos_dir.mkdir(parents=True, exist_ok=True)

    # ── Load tokenizer (shared) ────────────────────────────────────────────
    print(f"\nLoading tokenizer: {MODEL_ID} ...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)

    dtype_a, dtype_b = PAIRS[args.pair]
    dtype_a_name = _dtype_name(dtype_a)
    dtype_b_name = _dtype_name(dtype_b)

    # ── Run A ──────────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f" Running A: {dtype_a_name}")
    print(f"{'='*60}")
    model_a = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=dtype_a)
    model_a.to(device)
    model_a.eval()

    results_a: list[dict[str, Any]] = []
    for i, prompt in enumerate(prompts):
        print(f"  [{i:04d}] {prompt[:50]}...")
        r = run_with_logits(model_a, tokenizer, prompt, dtype_a, device)
        results_a.append(r)
        print(f"    → {len(r['output_token_ids'])} tokens, {r['elapsed_ms']:.0f}ms")
        # Save individual
        with open(per_pos_dir / f"{i:04d}_{dtype_a_name}.json", "w") as f:
            json.dump(r, f, ensure_ascii=False)

    # ── Run B ──────────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f" Running B: {dtype_b_name}")
    print(f"{'='*60}")
    model_b = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=dtype_b)
    model_b.to(device)
    model_b.eval()

    results_b: list[dict[str, Any]] = []
    for i, prompt in enumerate(prompts):
        print(f"  [{i:04d}] {prompt[:50]}...")
        r = run_with_logits(model_b, tokenizer, prompt, dtype_b, device)
        results_b.append(r)
        print(f"    → {len(r['output_token_ids'])} tokens, {r['elapsed_ms']:.0f}ms")
        with open(per_pos_dir / f"{i:04d}_{dtype_b_name}.json", "w") as f:
            json.dump(r, f, ensure_ascii=False)

    # ── Compare ────────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f" Comparing {dtype_a_name} vs {dtype_b_name}")
    print(f"{'='*60}")

    all_comparisons: list[dict[str, Any]] = []
    summary_stats = {
        "pair": args.pair,
        "dtype_a": dtype_a_name,
        "dtype_b": dtype_b_name,
        "num_prompts": len(prompts),
        "total_positions": 0,
        "top1_match_positions": 0,
        "first_divergence_mean": 0.0,
        "mean_kl": 0.0,
        "mean_top5_overlap": 0.0,
        "mean_logit_correlation": 0.0,
        "prompt_results": [],
    }

    for i in range(len(prompts)):
        pa = results_a[i]["positions"]
        pb = results_b[i]["positions"]
        min_len = min(len(pa), len(pb))

        pos_comparisons = []
        first_div = None
        for j in range(min_len):
            cmp = compare_positions(pa[j], pb[j])
            pos_comparisons.append(cmp)
            summary_stats["total_positions"] += 1
            if cmp["top1_match"]:
                summary_stats["top1_match_positions"] += 1
            if first_div is None and not cmp["top1_match"]:
                first_div = j

        # Save per-prompt comparison
        prompt_cmp = {
            "prompt_index": i,
            "prompt": prompts[i],
            "len_a": len(pa),
            "len_b": len(pb),
            "first_divergence": first_div,
            "positions": pos_comparisons,
        }
        with open(per_pos_dir / f"{i:04d}_comparison.json", "w") as f:
            json.dump(prompt_cmp, f, ensure_ascii=False, indent=2)

        all_comparisons.append(prompt_cmp)

        # Per-prompt stats
        mean_kl = np.mean([c["kl_divergence"] for c in pos_comparisons])
        mean_top5 = np.mean([c["top5_overlap"] for c in pos_comparisons])
        mean_corr = np.mean([c["logit_correlation"] for c in pos_comparisons])

        summary_stats["prompt_results"].append({
            "index": i,
            "prompt": prompts[i][:60],
            "first_divergence": first_div,
            "mean_kl": round(float(mean_kl), 6),
            "mean_top5_overlap": round(float(mean_top5), 1),
            "mean_logit_correlation": round(float(mean_corr), 6),
        })

        div_str = f"pos {first_div}" if first_div is not None else "NO DIVERGENCE"
        print(f"  [{i:04d}] first_div={div_str}, mean_KL={mean_kl:.6f}, "
              f"top5_overlap={mean_top5:.1f}/5, corr={mean_corr:.4f}")

    # ── Aggregate stats ────────────────────────────────────────────────────
    n = summary_stats["total_positions"]
    summary_stats["top1_match_rate"] = round(
        summary_stats["top1_match_positions"] / n, 4) if n > 0 else 0.0
    summary_stats["mean_kl"] = round(float(
        np.mean([c["kl_divergence"] for comp in all_comparisons
                 for c in comp["positions"]])), 6)
    summary_stats["mean_top5_overlap"] = round(float(
        np.mean([c["top5_overlap"] for comp in all_comparisons
                 for c in comp["positions"]])), 2)
    summary_stats["mean_logit_correlation"] = round(float(
        np.mean([c["logit_correlation"] for comp in all_comparisons
                 for c in comp["positions"]])), 6)

    first_divs = [pr["first_divergence"] for pr in all_comparisons
                  if pr["first_divergence"] is not None]
    summary_stats["first_divergence_mean"] = round(
        float(np.mean(first_divs)), 1) if first_divs else -1.0

    # ── Summary output ─────────────────────────────────────────────────────
    with open(pair_dir / "summary.json", "w") as f:
        json.dump(summary_stats, f, ensure_ascii=False, indent=2)

    # ── Manifest ───────────────────────────────────────────────────────────
    import transformers
    manifest = {
        "experiment": "EXP-0001.5",
        "pair": args.pair,
        "model_id": MODEL_ID,
        "transformers_version": transformers.__version__,
        "torch_version": torch.__version__,
        "device": str(device),
        "max_new_tokens": MAX_NEW_TOKENS,
        "temperature": TEMPERATURE,
        "num_prompts": len(prompts),
        "summary": summary_stats,
    }
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # ── Final report ───────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f" EXP-0001.5 Summary: {args.pair}")
    print(f"{'='*60}")
    print(f"  Total positions compared: {n}")
    print(f"  Top-1 match rate: {summary_stats['top1_match_rate']:.2%}")
    print(f"  Mean first divergence: {summary_stats['first_divergence_mean']:.1f}")
    print(f"  Mean KL: {summary_stats['mean_kl']:.6f}")
    print(f"  Mean top-5 overlap: {summary_stats['mean_top5_overlap']:.1f}/5")
    print(f"  Mean logit correlation: {summary_stats['mean_logit_correlation']:.4f}")
    print(f"\n  Output: {pair_dir}/")


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _dtype_name(dt: torch.dtype) -> str:
    return str(dt).split(".")[-1]


def _load_prompts(path: Path) -> list[str]:
    prompts: list[str] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                prompts.append(obj["prompt"])
            except (json.JSONDecodeError, KeyError):
                prompts.append(line)
    return prompts


if __name__ == "__main__":
    main()
