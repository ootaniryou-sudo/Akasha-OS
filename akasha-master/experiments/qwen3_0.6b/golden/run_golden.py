#!/usr/bin/env python3
"""
EXP-0000 — Qwen3-0.6B Golden Reference
═══════════════════════════════════════════════════════════════════════════════

Purpose:
  Prove that Qwen3-0.6B itself works correctly BEFORE any ArcAsha integration.

  This is the foundational baseline. If this fails, nothing else matters.

Pipeline:
  Mac → Python Transformers → Qwen3-0.6B → Output

Requirements:
  transformers >= 4.51.0  (qwen3 support)
  torch >= 2.0

Usage:
  python golden/run_golden.py

Output:
  golden/output/{index:04d}.json  — one file per prompt
  golden/output/manifest.json     — summary manifest
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════

MODEL_ID = "Qwen/Qwen3-0.6B"

# Fixed inference parameters for deterministic output
INFERENCE_PARAMS = {
    "max_new_tokens": 32,
    "temperature": 0.0,        # greedy
    "do_sample": False,
    "top_p": 1.0,
}

# Qwen3-specific: thinking=False disables the thinking mode (Qwen3 supports it)
QWEN3_EXTRA = {
    "thinking": False,
}

SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR / "output"
PROMPTS_FILE = SCRIPT_DIR / "prompts.jsonl"


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    # ── Parse CLI ──────────────────────────────────────────────────────────
    parser = argparse.ArgumentParser(
        description="EXP-0000: Qwen3-0.6B Golden Reference"
    )
    parser.add_argument("--model", default=MODEL_ID, help="HF model ID")
    parser.add_argument("--prompts", default=str(PROMPTS_FILE), help="JSONL prompts file")
    parser.add_argument("--output", default=str(OUTPUT_DIR), help="Output directory")
    parser.add_argument("--max-tokens", type=int, default=32, help="Max new tokens")
    parser.add_argument("--device", default="auto", help="Device: auto/cpu/cuda/mps")
    args = parser.parse_args()

    # ── Check prerequisites ────────────────────────────────────────────────
    _check_versions()

    # ── Load prompts ───────────────────────────────────────────────────────
    prompts_path = Path(args.prompts)
    if not prompts_path.exists():
        print(f"ERROR: Prompts file not found: {prompts_path}")
        sys.exit(1)

    prompts = _load_prompts(prompts_path)
    print(f"Loaded {len(prompts)} prompts from {prompts_path}")

    # ── Create output directory ────────────────────────────────────────────
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Load model ─────────────────────────────────────────────────────────
    print(f"\nLoading {args.model} ...")
    t0 = time.time()

    from transformers import AutoModelForCausalLM, AutoTokenizer
    import torch

    # Qwen3 requires trust_remote_code=False (natively supported in transformers >= 4.51.0)
    tokenizer = AutoTokenizer.from_pretrained(args.model)

    # Resolve device
    device = _resolve_device(args.device)
    print(f"  Device: {device}")

    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        dtype=torch.float32,
    )
    model.to(device)
    model.eval()

    # Collect version info
    import transformers
    model_revision = _get_model_revision(args.model)
    env_info = {
        "model_id": args.model,
        "model_revision": model_revision,
        "transformers_version": transformers.__version__,
        "torch_version": torch.__version__,
        "device": str(device),
        "python_version": sys.version,
    }
    load_sec = time.time() - t0
    print(f"Loaded in {load_sec:.1f}s")
    print(f"  transformers: {env_info['transformers_version']}")
    print(f"  torch: {env_info['torch_version']}")
    print(f"  model revision: {env_info['model_revision']}")

    # ── Run inference ──────────────────────────────────────────────────────
    results: list[dict[str, Any]] = []
    total_output_tokens = 0
    total_time_ms = 0.0

    for idx, prompt in enumerate(prompts):
        print(f"\n[{idx:04d}] {prompt[:60]}...")

        # Tokenize
        t_tok = time.time()
        inputs = tokenizer(prompt, return_tensors="pt").to(device)
        input_ids: list[int] = inputs["input_ids"][0].tolist()
        tok_ms = (time.time() - t_tok) * 1000

        # Generate
        t_gen = time.time()
        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=args.max_tokens,
                temperature=INFERENCE_PARAMS["temperature"] if INFERENCE_PARAMS["do_sample"] else 1.0,
                do_sample=INFERENCE_PARAMS["do_sample"],
                top_p=INFERENCE_PARAMS["top_p"],
                pad_token_id=tokenizer.eos_token_id,
            )
        gen_ms = (time.time() - t_gen) * 1000

        # Extract output tokens (excluding input)
        output_ids: list[int] = outputs[0][len(input_ids):].tolist()
        decoded: str = tokenizer.decode(output_ids, skip_special_tokens=True)

        total_ms = tok_ms + gen_ms
        total_output_tokens += len(output_ids)
        total_time_ms += total_ms

        # ── Build result ───────────────────────────────────────────────────
        result = {
            "index": idx,
            "prompt": prompt,
            "input_token_ids": input_ids,
            "input_token_count": len(input_ids),
            "output_token_ids": output_ids,
            "output_token_count": len(output_ids),
            "decoded_text": decoded,
            "timing_ms": {
                "tokenize": round(tok_ms, 3),
                "generate": round(gen_ms, 3),
                "total": round(total_ms, 3),
            },
            "params": {
                "max_new_tokens": args.max_tokens,
                "temperature": INFERENCE_PARAMS["temperature"],
                "do_sample": INFERENCE_PARAMS["do_sample"],
                "top_p": INFERENCE_PARAMS["top_p"],
                "thinking": QWEN3_EXTRA["thinking"],
            },
        }

        # Save individual file
        out_path = output_dir / f"{idx:04d}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        print(f"  → {len(output_ids)} tokens: {decoded[:50]}...")
        print(f"  → saved: {out_path.name} ({total_ms:.0f}ms)")

        results.append(result)

    # ── Manifest ───────────────────────────────────────────────────────────
    manifest = {
        "experiment": "EXP-0000",
        "description": "Qwen3-0.6B Golden Reference — pure Transformers, no ArcAsha",
        "environment": env_info,
        "params": {
            "max_new_tokens": args.max_tokens,
            "temperature": INFERENCE_PARAMS["temperature"],
            "do_sample": INFERENCE_PARAMS["do_sample"],
            "thinking": QWEN3_EXTRA["thinking"],
        },
        "summary": {
            "total_prompts": len(prompts),
            "total_output_tokens": total_output_tokens,
            "avg_output_tokens": round(total_output_tokens / len(prompts), 1),
            "total_time_ms": round(total_time_ms, 1),
            "avg_time_ms": round(total_time_ms / len(prompts), 1),
        },
        "files": [f"{i:04d}.json" for i in range(len(prompts))],
    }

    manifest_path = output_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # ── Summary ────────────────────────────────────────────────────────────
    print(f"\n{'═' * 60}")
    print(f" EXP-0000 Complete")
    print(f" Prompts: {len(prompts)}")
    print(f" Total output tokens: {total_output_tokens}")
    print(f" Total time: {total_time_ms:.0f}ms")
    print(f" Avg time/prompt: {total_time_ms / len(prompts):.0f}ms")
    print(f" Output: {output_dir}/")
    print(f" Manifest: {manifest_path}")
    print(f"{'═' * 60}")


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _check_versions() -> None:
    """Verify transformers >= 4.51.0 for Qwen3 support."""
    try:
        import transformers
    except ImportError:
        print("ERROR: transformers not installed. Run: pip install transformers>=4.51.0 torch")
        sys.exit(1)

    version = tuple(int(x) for x in transformers.__version__.split(".")[:2])
    if version < (4, 51):
        print(
            f"ERROR: transformers {transformers.__version__} is too old. "
            f"Qwen3 requires >= 4.51.0.\n"
            f"Run: pip install 'transformers>=4.51.0'"
        )
        sys.exit(1)

    try:
        import torch  # noqa: F401
    except ImportError:
        print("ERROR: torch not installed. Run: pip install torch")
        sys.exit(1)

    print(f"✓ transformers {transformers.__version__} (>= 4.51.0 required)")
    print(f"✓ torch {torch.__version__}")


def _load_prompts(path: Path) -> list[str]:
    """Load prompt strings from JSONL (one JSON object with 'prompt' key per line)
    or plain text (one prompt per line)."""
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
                # Plain text: use line as-is
                prompts.append(line)
    return prompts


def _resolve_device(device_str: str) -> str:
    """Resolve device string to a valid torch device."""
    import torch
    if device_str == "auto":
        if torch.cuda.is_available():
            return "cuda"
        elif torch.backends.mps.is_available():
            return "mps"
        else:
            return "cpu"
    return device_str


def _get_model_revision(model_id: str) -> str:
    """Get the current revision hash of the model from local cache."""
    try:
        from transformers.utils import cached_file
        from pathlib import Path
        config_path = cached_file(model_id, "config.json")
        parts = Path(config_path).parts
        for i, p in enumerate(parts):
            if p == "snapshots" and i + 1 < len(parts):
                return parts[i + 1]
        return "unknown"
    except Exception:
        return "unknown"


if __name__ == "__main__":
    main()

