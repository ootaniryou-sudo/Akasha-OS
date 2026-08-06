#!/usr/bin/env python3
"""EXP-0001.8 — Replication: verify BF16 divergence stability across runs."""
import argparse, json, sys, time
from pathlib import Path
from typing import Any
import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_ID = "Qwen/Qwen3-0.6B"
MAX_TOKENS = 32
SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR / "output"

def run_inference(model, tokenizer, prompt, device, max_tokens=MAX_TOKENS):
    inputs = tokenizer(prompt, return_tensors="pt").to(device)
    past_kv, cur = None, inputs["input_ids"]
    ids = []
    t0 = time.time()
    for _ in range(max_tokens):
        with torch.no_grad():
            out = model(cur, past_key_values=past_kv, use_cache=True) if past_kv is not None else model(cur)
        logits = out.logits[0, -1, :]
        past_kv = out.past_key_values
        tid = int(torch.argmax(logits, dim=-1).item())
        ids.append(tid)
        cur = torch.tensor([[tid]], device=device)
    return {"output_token_ids": ids, "elapsed_ms": (time.time()-t0)*1000}

def compare(ref_ids, test_ids):
    n = min(len(ref_ids), len(test_ids))
    matches = sum(1 for i in range(n) if ref_ids[i] == test_ids[i])
    first_div = next((i for i in range(n) if ref_ids[i] != test_ids[i]), None)
    return {"top1_match_rate": round(matches/n, 4) if n>0 else 0, "divergence_rate": round(1-matches/n, 4) if n>0 else 0, "first_divergence": first_div, "n_compared": n}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--prompts", default=str(SCRIPT_DIR/"../EXP-0001.7/prompts_50.jsonl"))
    p.add_argument("--output", default=str(OUTPUT_DIR))
    p.add_argument("--device", default="auto")
    args = p.parse_args()

    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    print(f"Device: {dev}  Runs: {args.runs}")

    prompts = []
    with open(args.prompts) as f:
        for line in f:
            if line.strip():
                prompts.append(json.loads(line.strip())["prompt"])
    n = len(prompts)
    print(f"Prompts: {n}")

    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(MODEL_ID)

    # Baseline: FP32
    print("\n=== Baseline: FP32 ===")
    m32 = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.float32).to(dev).eval()
    ref_results = [run_inference(m32, tok, p, dev) for p in prompts]
    print(f"  {n} prompts, avg {np.mean([r['elapsed_ms'] for r in ref_results]):.0f}ms")

    # Replication runs
    all_runs = []
    for run_id in range(1, args.runs + 1):
        print(f"\n=== Run {run_id}/{args.runs} ===")
        run_dir = out / f"run_{run_id:03d}"
        run_dir.mkdir(parents=True, exist_ok=True)

        # BF16
        m_bf16 = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.bfloat16).to(dev).eval()
        bf16_results = [run_inference(m_bf16, tok, p, dev) for p in prompts]
        bf16_cmp = [compare(ref_results[i]["output_token_ids"], bf16_results[i]["output_token_ids"]) for i in range(n)]
        bf16_sum = {
            "precision": "bf16",
            "top1_match_rate": round(float(np.mean([c["top1_match_rate"] for c in bf16_cmp])), 4),
            "divergence_rate": round(float(np.mean([c["divergence_rate"] for c in bf16_cmp])), 4),
            "mean_first_divergence": round(float(np.mean([c["first_divergence"] for c in bf16_cmp if c["first_divergence"] is not None])), 1),
            "speed_ms_avg": round(float(np.mean([r["elapsed_ms"] for r in bf16_results])), 0),
        }

        # FP16
        m_fp16 = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.float16).to(dev).eval()
        fp16_results = [run_inference(m_fp16, tok, p, dev) for p in prompts]
        fp16_cmp = [compare(ref_results[i]["output_token_ids"], fp16_results[i]["output_token_ids"]) for i in range(n)]
        fp16_sum = {
            "precision": "fp16",
            "top1_match_rate": round(float(np.mean([c["top1_match_rate"] for c in fp16_cmp])), 4),
            "divergence_rate": round(float(np.mean([c["divergence_rate"] for c in fp16_cmp])), 4),
            "mean_first_divergence": round(float(np.mean([c["first_divergence"] for c in fp16_cmp if c["first_divergence"] is not None])), 1),
            "speed_ms_avg": round(float(np.mean([r["elapsed_ms"] for r in fp16_results])), 0),
        }

        run_data = {"run_id": run_id, "bf16": bf16_sum, "fp16": fp16_sum}
        all_runs.append(run_data)
        with open(run_dir/"summary.json","w") as f: json.dump(run_data, f, indent=2)
        print(f"  BF16: div={bf16_sum['divergence_rate']:.4f} 1st_div={bf16_sum['mean_first_divergence']:.1f} speed={bf16_sum['speed_ms_avg']:.0f}ms")
        print(f"  FP16: div={fp16_sum['divergence_rate']:.4f} 1st_div={fp16_sum['mean_first_divergence']:.1f} speed={fp16_sum['speed_ms_avg']:.0f}ms")

    # Aggregate
    bf16_divs = [r["bf16"]["divergence_rate"] for r in all_runs]
    fp16_divs = [r["fp16"]["divergence_rate"] for r in all_runs]
    agg = {
        "experiment": "EXP-0001.8", "runs": args.runs, "prompts": n,
        "bf16": {"div_mean": round(float(np.mean(bf16_divs)),4), "div_std": round(float(np.std(bf16_divs)),4),
                  "div_min": round(float(np.min(bf16_divs)),4), "div_max": round(float(np.max(bf16_divs)),4)},
        "fp16": {"div_mean": round(float(np.mean(fp16_divs)),4), "div_std": round(float(np.std(fp16_divs)),4),
                  "div_min": round(float(np.min(fp16_divs)),4), "div_max": round(float(np.max(fp16_divs)),4)},
        "reproducible": bool(np.std(bf16_divs) < 0.02),
    }
    with open(out/"replication.json","w") as f: json.dump(agg, f, indent=2)

    print(f"\n{'='*60}")
    print(f" EXP-0001.8 Replication Results ({args.runs} runs)")
    print(f"{'='*60}")
    print(f"  BF16: μ={agg['bf16']['div_mean']:.4f} σ={agg['bf16']['div_std']:.4f} [{agg['bf16']['div_min']:.4f}-{agg['bf16']['div_max']:.4f}]")
    print(f"  FP16: μ={agg['fp16']['div_mean']:.4f} σ={agg['fp16']['div_std']:.4f} [{agg['fp16']['div_min']:.4f}-{agg['fp16']['div_max']:.4f}]")
    print(f"  Reproducible (σ<0.02): {agg['reproducible']}")

if __name__ == "__main__":
    main()
