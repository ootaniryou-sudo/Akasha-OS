#!/usr/bin/env python3
"""
EXP-0001.6 — Divergence Prediction & Shadow Policy
═══════════════════════════════════════════════════════════════════════════════

Can logit_margin predict future cross-runtime token divergence?

For each generation step t:
  margin(t) → does divergence occur at t+1, t+3, t+5, t+10?

Outputs precision/recall/F1 per threshold + ROC data.
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
PROMPTS_FILE = SCRIPT_DIR / "prompts_100.jsonl"


# ═══════════════════════════════════════════════════════════════════════════════
# Inference with full logit capture (same as EXP-0001.5)
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
# Per-step prediction record
# ═══════════════════════════════════════════════════════════════════════════════

def compute_prediction_records(
    pos_a: list[dict], pos_b: list[dict],
    lookahead_steps: list[int] = [1, 3, 5, 10],
) -> list[dict[str, Any]]:
    """For each position, record margin and whether future divergence occurs."""
    min_len = min(len(pos_a), len(pos_b))
    records = []

    for t in range(min_len):
        rec = {
            "pos": t,
            "token_a": pos_a[t]["token_id"],
            "token_b": pos_b[t]["token_id"],
            "top1_match": pos_a[t]["token_id"] == pos_b[t]["token_id"],
            "logit_margin_a": pos_a[t]["logit_margin"],
            "logit_margin_b": pos_b[t]["logit_margin"],
        }
        # Future divergence at t+k
        for k in lookahead_steps:
            future_t = t + k
            if future_t < min_len:
                rec[f"diverged_at_t_plus_{k}"] = (
                    pos_a[future_t]["token_id"] != pos_b[future_t]["token_id"]
                )
            else:
                rec[f"diverged_at_t_plus_{k}"] = None  # beyond sequence
        records.append(rec)

    return records


# ═══════════════════════════════════════════════════════════════════════════════
# Threshold analysis
# ═══════════════════════════════════════════════════════════════════════════════

def threshold_analysis(
    records: list[dict],
    lookahead: int,
    num_thresholds: int = 50,
) -> dict[str, Any]:
    """Compute precision/recall/F1 at each margin threshold."""
    # Filter to positions where we have a future divergence label
    valid = [r for r in records if r[f"diverged_at_t_plus_{lookahead}"] is not None]
    if not valid:
        return {"error": "no valid records"}

    margins = np.array([r["logit_margin_a"] for r in valid])
    labels = np.array([r[f"diverged_at_t_plus_{lookahead}"] for r in valid], dtype=bool)

    n_divergent = int(np.sum(labels))
    n_total = len(valid)

    # Threshold sweep
    thresholds = np.logspace(-4, 1, num_thresholds)  # 0.0001 to 10
    results = []

    for thresh in thresholds:
        # Predict: margin < threshold → will diverge
        predicted_positive = margins < thresh
        tp = int(np.sum(predicted_positive & labels))
        fp = int(np.sum(predicted_positive & ~labels))
        fn = int(np.sum(~predicted_positive & labels))

        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

        results.append({
            "threshold": round(float(thresh), 6),
            "tp": tp, "fp": fp, "fn": fn,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
        })

    # Best threshold by F1
    best = max(results, key=lambda r: r["f1"])

    # ROC points (TPR vs FPR)
    roc_points = []
    for thresh in thresholds:
        predicted_positive = margins < thresh
        tp = int(np.sum(predicted_positive & labels))
        fp = int(np.sum(predicted_positive & ~labels))
        fn = int(np.sum(~predicted_positive & labels))
        tn = int(np.sum(~predicted_positive & ~labels))

        tpr = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        fpr = fp / (fp + tn) if (fp + tn) > 0 else 0.0
        roc_points.append({"tpr": round(tpr, 4), "fpr": round(fpr, 4)})

    # AUC (trapezoidal)
    roc_sorted = sorted(roc_points, key=lambda p: p["fpr"])
    auc = 0.0
    for i in range(1, len(roc_sorted)):
        dx = roc_sorted[i]["fpr"] - roc_sorted[i - 1]["fpr"]
        dy = (roc_sorted[i]["tpr"] + roc_sorted[i - 1]["tpr"]) / 2
        auc += dx * dy

    return {
        "lookahead_k": lookahead,
        "n_total": n_total,
        "n_divergent": n_divergent,
        "divergence_rate": round(n_divergent / n_total, 4),
        "best_threshold": {
            "margin": best["threshold"],
            "precision": best["precision"],
            "recall": best["recall"],
            "f1": best["f1"],
        },
        "roc_auc": round(auc, 4),
        "thresholds": results,
        "roc_points": roc_points,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="EXP-0001.6: Divergence Prediction")
    parser.add_argument("--pair", default="fp32_vs_fp16",
                        choices=["fp32_vs_fp16", "fp32_vs_onnx_fp16"])
    parser.add_argument("--prompts", default=str(PROMPTS_FILE))
    parser.add_argument("--output", default=str(OUTPUT_DIR))
    parser.add_argument("--device", default="auto")
    parser.add_argument("--max-prompts", type=int, default=100)
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
    pair_dir = out_dir / args.pair
    pair_dir.mkdir(parents=True, exist_ok=True)

    # Tokenizer
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)

    # ── Run A: FP32 ────────────────────────────────────────────────────────
    print(f"\n{'='*60}\n Running A: float32\n{'='*60}")
    model_a = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.float32)
    model_a.to(device)
    model_a.eval()

    results_a = []
    for i, prompt in enumerate(prompts):
        r = run_with_logits(model_a, tokenizer, prompt, torch.float32, device)
        results_a.append(r)
        if (i + 1) % 10 == 0:
            print(f"  [{i+1}/{n}] {prompt[:40]}... ({r['elapsed_ms']:.0f}ms)")

    # ── Run B: FP16 ────────────────────────────────────────────────────────
    print(f"\n{'='*60}\n Running B: float16\n{'='*60}")
    model_b = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.float16)
    model_b.to(device)
    model_b.eval()

    results_b = []
    for i, prompt in enumerate(prompts):
        r = run_with_logits(model_b, tokenizer, prompt, torch.float16, device)
        results_b.append(r)
        if (i + 1) % 10 == 0:
            print(f"  [{i+1}/{n}] {prompt[:40]}... ({r['elapsed_ms']:.0f}ms)")

    # ── Prediction Records ─────────────────────────────────────────────────
    print(f"\n{'='*60}\n Computing divergence predictions\n{'='*60}")

    lookahead_steps = [1, 3, 5, 10]
    all_records = []
    prompt_summaries = []

    for i in range(n):
        pa = results_a[i]["positions"]
        pb = results_b[i]["positions"]
        records = compute_prediction_records(pa, pb, lookahead_steps)
        all_records.extend(records)

        # Per-prompt: first divergence
        first_div = None
        for r in records:
            if not r["top1_match"] and first_div is None:
                first_div = r["pos"]
        prompt_summaries.append({
            "index": i,
            "prompt": prompts[i][:60],
            "len_a": len(pa), "len_b": len(pb),
            "first_divergence": first_div,
            "num_records": len(records),
        })

    # Save all records
    predictions_path = pair_dir / "predictions.jsonl"
    with open(predictions_path, "w") as f:
        for rec in all_records:
            f.write(json.dumps(rec) + "\n")
    print(f"  Saved {len(all_records)} prediction records to {predictions_path}")

    # ── Threshold Analysis per lookahead ───────────────────────────────────
    threshold_results = {}
    for k in lookahead_steps:
        tr = threshold_analysis(all_records, k)
        threshold_results[f"k_{k}"] = tr

        b = tr["best_threshold"]
        print(f"\n  k={k:2d}: n={tr['n_total']} divergent={tr['n_divergent']} "
              f"rate={tr['divergence_rate']:.3f}  AUC={tr['roc_auc']:.3f}")
        print(f"         best_threshold={b['margin']:.4f}  "
              f"P={b['precision']:.3f}  R={b['recall']:.3f}  F1={b['f1']:.3f}")

    # ── Summary ────────────────────────────────────────────────────────────
    summary = {
        "experiment": "EXP-0001.6",
        "pair": args.pair,
        "model_id": MODEL_ID,
        "num_prompts": n,
        "total_positions": len(all_records),
        "lookahead_steps": lookahead_steps,
        "threshold_results": threshold_results,
        "prompt_summaries": prompt_summaries,
    }
    with open(pair_dir / "summary.json", "w") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    # ── Manifest ───────────────────────────────────────────────────────────
    import transformers
    manifest = {
        "experiment": "EXP-0001.6",
        "pair": args.pair,
        "model_id": MODEL_ID,
        "transformers_version": transformers.__version__,
        "torch_version": torch.__version__,
        "device": str(device),
        "max_new_tokens": MAX_NEW_TOKENS,
        "num_prompts": n,
        "total_records": len(all_records),
    }
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # ── Final report ───────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f" EXP-0001.6: {args.pair}")
    print(f"{'='*60}")
    for k in lookahead_steps:
        tr = threshold_results[f"k_{k}"]
        b = tr["best_threshold"]
        print(f"  k={k:2d}  AUC={tr['roc_auc']:.3f}  "
              f"best_margin={b['margin']:.4f}  F1={b['f1']:.3f}")

    # Prediction quality interpretation
    best_k5 = threshold_results["k_5"]
    auc = best_k5["roc_auc"]
    if auc > 0.85:
        quality = "EXCELLENT — margin is a strong divergence predictor"
    elif auc > 0.70:
        quality = "GOOD — margin has meaningful predictive power"
    elif auc > 0.55:
        quality = "MODERATE — margin has some predictive power"
    else:
        quality = "WEAK — margin alone is insufficient"

    print(f"\n  Prediction quality: {quality}")
    print(f"  Output: {pair_dir}/")


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
