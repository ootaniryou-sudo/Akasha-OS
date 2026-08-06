#!/usr/bin/env python3
"""
EXP-0001.7 — Precision Ladder
═══════════════════════════════════════════════════════════════════════════════

Systematic comparison across precision levels:
  PyTorch: FP32, BF16, FP16
  ONNX:    FP32, FP16 (future)

Measures: top-1 match, top-5 overlap, KL, logit correlation, speed,
          precision_efficiency_ratio, divergence_rate.
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

MODEL_ID = "Qwen/Qwen3-0.6B"
MAX_NEW_TOKENS = 32
TEMPERATURE = 0.0

SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR / "output"


# ═══════════════════════════════════════════════════════════════════════════════
# Inference
# ═══════════════════════════════════════════════════════════════════════════════

def run_with_logits(
    model, tokenizer, prompt: str, dtype: torch.dtype,
    device: torch.device, max_new_tokens: int = MAX_NEW_TOKENS,
) -> dict[str, Any]:
    inputs = tokenizer(prompt, return_tensors="pt").to(device)
    input_ids = inputs["input_ids"]
    input_token_list: list[int] = input_ids[0].tolist()

    positions: list[dict[str, Any]] = []
    generated_ids: list[int] = []
    past_key_values = None
    current_input = input_ids

    t_start = time.time()
    for step in range(max_new_tokens):
        with torch.no_grad():
            if past_key_values is None:
                outputs = model(current_input, output_hidden_states=False)
            else:
                outputs = model(current_input, past_key_values=past_key_values,
                                use_cache=True, output_hidden_states=False)

        logits = outputs.logits[0, -1, :]
        past_key_values = outputs.past_key_values
        logits_f32 = logits.to(torch.float32).cpu().numpy()

        next_token_id = int(torch.argmax(logits, dim=-1).item())
        generated_ids.append(next_token_id)

        topk_values, topk_indices = torch.topk(logits, k=10, dim=-1)
        top10_ids = topk_indices.cpu().tolist()
        margin = float(topk_values[0].item() - topk_values[1].item()) if len(topk_values) >= 2 else float("inf")

        positions.append({
            "pos": step,
            "token_id": next_token_id,
            "logits_f32": logits_f32.tolist(),
            "top10_ids": top10_ids,
            "logit_margin": round(margin, 6),
        })
        current_input = torch.tensor([[next_token_id]], device=device)

    elapsed_ms = (time.time() - t_start) * 1000
    return {
        "prompt": prompt,
        "input_token_ids": input_token_list,
        "output_token_ids": generated_ids,
        "dtype": str(dtype),
        "elapsed_ms": round(elapsed_ms, 1),
        "positions": positions,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Pairwise comparison
# ═══════════════════════════════════════════════════════════════════════════════

def compare_pair(
    results_a: list[dict], results_b: list[dict],
    label_a: str, label_b: str,
    speed_a: float, speed_b: float,
) -> dict[str, Any]:
    """Compare two inference runs across all prompts."""
    n = len(results_a)
    all_top1 = 0
    all_positions = 0
    all_kl: list[float] = []
    all_top5: list[float] = []
    all_corr: list[float] = []
    first_divs: list[int] = []

    for i in range(n):
        pa = results_a[i]["positions"]
        pb = results_b[i]["positions"]
        min_len = min(len(pa), len(pb))

        first_div = None
        for j in range(min_len):
            logits_a = np.array(pa[j]["logits_f32"], dtype=np.float32)
            logits_b = np.array(pb[j]["logits_f32"], dtype=np.float32)

            top1_match = pa[j]["token_id"] == pb[j]["token_id"]
            if top1_match:
                all_top1 += 1
            if first_div is None and not top1_match:
                first_div = j

            top5_a = set(pa[j]["top10_ids"][:5])
            top5_b = set(pb[j]["top10_ids"][:5])
            all_top5.append(len(top5_a & top5_b))

            # KL
            prob_a = np.exp(logits_a - np.max(logits_a))
            prob_a /= prob_a.sum()
            prob_b = np.exp(logits_b - np.max(logits_b))
            prob_b /= prob_b.sum()
            eps = 1e-12
            kl = float(np.sum(prob_a * np.log((prob_a + eps) / (prob_b + eps))))
            all_kl.append(kl)

            # Correlation
            corr = float(np.corrcoef(logits_a, logits_b)[0, 1])
            all_corr.append(corr)

            all_positions += 1

        if first_div is not None:
            first_divs.append(first_div)

    total = all_positions
    top1_rate = all_top1 / total if total > 0 else 0.0
    mean_first_div = float(np.mean(first_divs)) if first_divs else -1.0
    mean_kl = float(np.mean(all_kl))
    mean_top5 = float(np.mean(all_top5))
    mean_corr = float(np.mean(all_corr))
    divergence_rate = 1.0 - top1_rate

    # Speed / efficiency
    mean_speed_a = speed_a / n if n > 0 else 0
    mean_speed_b = speed_b / n if n > 0 else 0
    speed_ratio = mean_speed_b / mean_speed_a if mean_speed_a > 0 else 0
    quality_ratio = top1_rate  # simplified
    precision_efficiency = quality_ratio / speed_ratio if speed_ratio > 0 else 0

    return {
        "pair": f"{label_a}_vs_{label_b}",
        "label_a": label_a,
        "label_b": label_b,
        "num_prompts": n,
        "total_positions": total,
        "top1_match_rate": round(top1_rate, 4),
        "divergence_rate": round(divergence_rate, 4),
        "mean_first_divergence": round(mean_first_div, 1),
        "mean_top5_overlap": round(mean_top5, 2),
        "mean_kl_divergence": round(mean_kl, 6),
        "mean_logit_correlation": round(mean_corr, 4),
        "speed_a_ms": round(mean_speed_a, 0),
        "speed_b_ms": round(mean_speed_b, 0),
        "speed_ratio": round(speed_ratio, 3),
        "precision_efficiency_ratio": round(precision_efficiency, 2),
        "num_divergent_prompts": len(first_divs),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

PRECISION_CONFIGS = {
    "pt_fp32":  {"label": "pt_fp32",  "dtype": torch.float32},
    "pt_bf16":  {"label": "pt_bf16",  "dtype": torch.bfloat16},
    "pt_fp16":  {"label": "pt_fp16",  "dtype": torch.float16},
}

PAIRS = [
    ("pt_fp32", "pt_bf16"),
    ("pt_fp32", "pt_fp16"),
    ("pt_bf16", "pt_fp16"),
]


def main() -> None:
    parser = argparse.ArgumentParser(description="EXP-0001.7: Precision Ladder")
    parser.add_argument("--prompts", default=str(SCRIPT_DIR / "prompts_50.jsonl"))
    parser.add_argument("--output", default=str(OUTPUT_DIR))
    parser.add_argument("--device", default="auto")
    parser.add_argument("--max-prompts", type=int, default=50)
    args = parser.parse_args()

    device_str = args.device
    if device_str == "auto":
        if torch.cuda.is_available():
            device = torch.device("cuda")
        elif torch.backends.mps.is_available():
            device = torch.device("mps")
        else:
            device = torch.device("cpu")
    else:
        device = torch.device(device_str)
    print(f"Device: {device}")

    # Load prompts
    prompts_path = Path(args.prompts)
    prompts = _load_prompts(prompts_path)[:args.max_prompts]
    n = len(prompts)
    print(f"Prompts: {n}")

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Tokenizer
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)

    # ── Run all precision levels ───────────────────────────────────────────
    all_results: dict[str, list[dict]] = {}
    all_speeds: dict[str, float] = {}

    for key, cfg in PRECISION_CONFIGS.items():
        label = cfg["label"]
        dtype = cfg["dtype"]
        print(f"\n{'='*60}\n {label}\n{'='*60}")

        model = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=dtype)
        model.to(device)
        model.eval()

        results = []
        total_ms = 0.0
        for i, prompt in enumerate(prompts):
            r = run_with_logits(model, tokenizer, prompt, dtype, device)
            results.append(r)
            total_ms += r["elapsed_ms"]
            if (i + 1) % 10 == 0:
                print(f"  [{i+1}/{n}] {prompt[:40]}... ({r['elapsed_ms']:.0f}ms)")

        all_results[label] = results
        all_speeds[label] = total_ms

    # ── Compare all pairs ──────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f" Precision Ladder")
    print(f"{'='*60}")

    ladder_entries = []
    for pair_key in PAIRS:
        a_key, b_key = pair_key
        a_label = PRECISION_CONFIGS[a_key]["label"]
        b_label = PRECISION_CONFIGS[b_key]["label"]

        entry = compare_pair(
            all_results[a_label], all_results[b_label],
            a_label, b_label,
            all_speeds[a_label], all_speeds[b_label],
        )
        ladder_entries.append(entry)

        # Per-pair directory
        pair_dir = out_dir / entry["pair"]
        pair_dir.mkdir(parents=True, exist_ok=True)
        with open(pair_dir / "summary.json", "w") as f:
            json.dump(entry, f, ensure_ascii=False, indent=2)

        # Print
        print(f"\n  {entry['pair']}:")
        print(f"    top1_match={entry['top1_match_rate']:.3f}  "
              f"div_rate={entry['divergence_rate']:.3f}  "
              f"mean_first_div={entry['mean_first_divergence']:.1f}")
        print(f"    top5_ovlp={entry['mean_top5_overlap']:.1f}/5  "
              f"KL={entry['mean_kl_divergence']:.6f}  corr={entry['mean_logit_correlation']:.4f}")
        print(f"    speed_a={entry['speed_a_ms']:.0f}ms  speed_b={entry['speed_b_ms']:.0f}ms  "
              f"ratio={entry['speed_ratio']:.3f}  eff={entry['precision_efficiency_ratio']:.2f}")

    # ── Ladder summary ─────────────────────────────────────────────────────
    baseline_label = "pt_fp32"
    baseline_total = all_speeds[baseline_label]

    # Per-config summary (relative to baseline)
    config_summaries = []
    for key, cfg in PRECISION_CONFIGS.items():
        label = cfg["label"]
        speed = all_speeds[label]
        rel_speed = speed / baseline_total if baseline_total > 0 else 0

        # Divergence rate vs baseline
        div_rate = None
        if label != baseline_label:
            entry = next((e for e in ladder_entries
                          if baseline_label in e["pair"] and label in e["pair"]), None)
            if entry:
                div_rate = entry["divergence_rate"]

        config_summaries.append({
            "label": label,
            "dtype": str(cfg["dtype"]),
            "total_ms": round(speed, 0),
            "relative_speed": round(rel_speed, 3),
            "divergence_rate_vs_baseline": div_rate,
            "numerical_stability_score": round(1.0 - (div_rate or 0), 4),
        })

    # ── Output ─────────────────────────────────────────────────────────────
    ladder = {
        "experiment": "EXP-0001.7",
        "baseline": baseline_label,
        "model_id": MODEL_ID,
        "num_prompts": n,
        "max_new_tokens": MAX_NEW_TOKENS,
        "device": str(device),
        "configs": config_summaries,
        "pairs": ladder_entries,
    }
    with open(out_dir / "precision_ladder.json", "w") as f:
        json.dump(ladder, f, ensure_ascii=False, indent=2)

    import transformers
    manifest = {
        "experiment": "EXP-0001.7",
        "model_id": MODEL_ID,
        "transformers_version": transformers.__version__,
        "torch_version": torch.__version__,
        "device": str(device),
        "num_prompts": n,
        "configs_tested": list(PRECISION_CONFIGS.keys()),
    }
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # ── Final table ────────────────────────────────────────────────────────
    print(f"\n{'='*70}")
    print(f" Precision Ladder — Numerical Stability Scores")
    print(f"{'='*70}")
    print(f" {'Config':<12} {'Speed(ms)':>10} {'RelSpeed':>9} {'DivRate':>9} {'Stability':>10}")
    print(f" {'-'*12} {'-'*10} {'-'*9} {'-'*9} {'-'*10}")
    for cs in config_summaries:
        ds = f"{cs['divergence_rate_vs_baseline']:.4f}" if cs['divergence_rate_vs_baseline'] is not None else "  (base)"
        print(f" {cs['label']:<12} {cs['total_ms']:>10.0f} {cs['relative_speed']:>9.3f} {ds:>9} {cs['numerical_stability_score']:>10.4f}")
    print(f"\n Output: {out_dir}/")


def _load_prompts(path: Path) -> list[str]:
    prompts: list[str] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                prompts.append(json.loads(line)["prompt"])
            except (json.JSONDecodeError, KeyError):
                prompts.append(line)
    return prompts


if __name__ == "__main__":
    main()
