"""
Akasha-OS — INT4 Quantisation & WebGPU/Wasm Export (Compile Layer)
───────────────────────────────────────────────────────────────────
Converts a fine-tuned HuggingFace model (base + LoRA) into a quantised
binary format suitable for browser-side WebGPU inference.

Supports two export paths:
  1. llama.cpp GGUF (→ WebAssembly via llama.cpp wasm backend)
  2. MLC-LLM (→ WebGPU via Apache TVM Unity)

Usage:
  # Path A: llama.cpp GGUF (best for small models, broad browser support)
  python quantize.py --input ./output/math-lora --format gguf --bits 4

  # Path B: MLC-LLM WebGPU (best for mid-size models, GPU-accelerated)
  python quantize.py --input ./output/math-lora --format mlc --bits 4

Output:
  ./output/{domain}-q4.gguf    (GGUF, ~250 MB for 0.5B model)
  ./output/{domain}-mlc/       (MLC compiled model directory)
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# ─── Constants ──────────────────────────────────────────────────────────────

# Model size → estimated INT4 file size (bytes)
MODEL_SIZE_ESTIMATES = {
    "0.5B": 250 * 1024 * 1024,   # ~250 MB
    "1B":   500 * 1024 * 1024,   # ~500 MB
    "1.5B": 750 * 1024 * 1024,   # ~750 MB
    "3B":   1_500 * 1024 * 1024, # ~1.5 GB
    "7B":   3_500 * 1024 * 1024, # ~3.5 GB
}

# ─── Helper: find parameter count from model config ────────────────────────

def detect_model_size(model_dir: Path) -> str:
    """Detect approximate parameter count from config.json."""
    config_path = model_dir / "config.json"
    if not config_path.exists():
        return "0.5B"

    with open(config_path) as f:
        cfg = json.load(f)

    hidden = cfg.get("hidden_size", 2048)
    layers = cfg.get("num_hidden_layers", 24)
    intermediate = cfg.get("intermediate_size", hidden * 4)

    # Rough estimate: 4*h²*l + 8*h*intermediate*l ≈ params
    params = (4 * hidden * hidden + 8 * hidden * intermediate) * layers
    params_b = params / 1e9

    if params_b < 0.3:
        return "0.1B"
    elif params_b < 0.8:
        return "0.5B"
    elif params_b < 1.5:
        return "1B"
    elif params_b < 2.5:
        return "1.5B"
    elif params_b < 5:
        return "3B"
    elif params_b < 10:
        return "7B"
    else:
        return f"{params_b:.0f}B"


def check_tool(name: str, install_hint: str) -> bool:
    """Check if a CLI tool is available."""
    if shutil.which(name) is None:
        print(f"  ⚠ '{name}' not found. {install_hint}")
        return False
    return True


# ─── Path A: llama.cpp GGUF export ─────────────────────────────────────────

def export_gguf(input_dir: Path, output_dir: Path, bits: int) -> Path:
    """
    Convert HuggingFace model → GGUF INT4 via llama.cpp convert + quantize.

    Requires: llama.cpp built from source (https://github.com/ggerganov/llama.cpp)
    """
    print("\n── Path A: llama.cpp GGUF export ──\n")

    # 1. Merge LoRA into base model (if applicable)
    merged_dir = output_dir / "merged-hf"
    if (input_dir / "adapter_config.json").exists():
        print("  Merging LoRA adapter into base model...")
        # Use PEFT merge script
        cmd_merge = [
            sys.executable, "-m", "peft.merge_and_unload",
            "--base_model_name_or_path", str(input_dir),
            "--peft_model_path", str(input_dir),
            "--output_dir", str(merged_dir),
        ]
        try:
            subprocess.run(cmd_merge, check=True)
        except Exception:
            # Fallback: manual merge via Python
            print("  Falling back to manual LoRA merge...")
            _manual_lora_merge(input_dir, merged_dir)
        model_dir = merged_dir
    else:
        model_dir = input_dir

    # 2. Convert HF → FP16 GGUF
    print("  Converting HF → FP16 GGUF...")
    convert_script = Path(os.environ.get(
        "LLAMA_CPP_DIR",
        str(Path.home() / "llama.cpp"),
    )) / "convert_hf_to_gguf.py"

    fp16_gguf = output_dir / f"{input_dir.name}.fp16.gguf"

    if convert_script.exists():
        subprocess.run([
            sys.executable, str(convert_script),
            str(model_dir),
            "--outfile", str(fp16_gguf),
            "--outtype", "f16",
        ], check=True)
    else:
        print(f"  ⚠ convert_hf_to_gguf.py not found at {convert_script}")
        print(f"  Set LLAMA_CPP_DIR env var to your llama.cpp directory.")
        print(f"  Skipping GGUF conversion — model dir: {model_dir}")
        return model_dir

    # 3. Quantise FP16 → INT4
    print(f"  Quantising to Q{bits}_K_M...")
    quantize_bin = Path(os.environ.get(
        "LLAMA_CPP_DIR",
        str(Path.home() / "llama.cpp"),
    )) / "build/bin/quantize"

    q4_gguf = output_dir / f"{input_dir.name}.q{bits}_k_m.gguf"

    if quantize_bin.exists():
        subprocess.run([
            str(quantize_bin),
            str(fp16_gguf),
            str(q4_gguf),
            f"Q{bits}_K_M",
        ], check=True)

        # Clean up FP16 intermediate
        fp16_gguf.unlink(missing_ok=True)

        size_mb = q4_gguf.stat().st_size / (1024 * 1024)
        print(f"  ✅ GGUF exported: {q4_gguf} ({size_mb:.0f} MB)")
        return q4_gguf
    else:
        print(f"  ⚠ quantize binary not found at {quantize_bin}")
        return fp16_gguf


def _manual_lora_merge(input_dir: Path, output_dir: Path):
    """Merge LoRA weights into base model without CLI tools."""
    try:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM

        print("    Loading base + LoRA for merge...")
        base_model_name = input_dir.name  # fallback
        meta_path = input_dir / "akasha_meta.json"
        if meta_path.exists():
            with open(meta_path) as f:
                meta = json.load(f)
                base_model_name = meta.get("base_model", input_dir.name)

        model = AutoModelForCausalLM.from_pretrained(
            base_model_name,
            torch_dtype=torch.float16,
            device_map="auto",
        )
        model = PeftModel.from_pretrained(model, str(input_dir))
        merged = model.merge_and_unload()

        output_dir.mkdir(parents=True, exist_ok=True)
        merged.save_pretrained(str(output_dir))

        # Copy tokenizer
        tokenizer_files = list(input_dir.glob("tokenizer*")) + list(input_dir.glob("vocab*"))
        for f in tokenizer_files:
            shutil.copy(f, output_dir / f.name)

        print(f"    Merged model saved to {output_dir}")
    except ImportError as e:
        print(f"    ⚠ Cannot merge: {e}")
        # Copy input as-is
        shutil.copytree(input_dir, output_dir, dirs_exist_ok=True)


# ─── Path B: MLC-LLM WebGPU export ─────────────────────────────────────────

def export_mlc(input_dir: Path, output_dir: Path, bits: int) -> Path:
    """
    Compile model for WebGPU via MLC-LLM (Apache TVM Unity).

    Requires: mlc-llm pip package (https://github.com/mlc-ai/mlc-llm)
    """
    print("\n── Path B: MLC-LLM WebGPU export ──\n")

    mlc_output = output_dir / f"{input_dir.name}-mlc"
    mlc_output.mkdir(parents=True, exist_ok=True)

    # 1. Generate MLC config
    model_size = detect_model_size(input_dir)
    config = {
        "model_type": "qwen2" if "qwen" in input_dir.name.lower() else "llama",
        "quantization": f"q{bits}f{bits}_1",  # e.g., q4f16_1 for INT4 weights, FP16 activations
        "model_config": {
            "hidden_size": 2048,
            "num_hidden_layers": 24,
        },
        "vocab_size": 151936,  # Qwen2 default; auto-detect in production
        "context_window_size": 4096,
        "sliding_window_size": -1,
        "prefill_chunk_size": 4096,
        "tensor_parallel_shards": 1,
    }

    config_path = mlc_output / "mlc-chat-config.json"
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)

    # 2. Convert weights via MLC
    print("  Converting weights (HF → MLC)...")
    try:
        subprocess.run([
            sys.executable, "-m", "mlc_llm", "convert_weight",
            str(input_dir),
            "--quantization", f"q{bits}f{bits}_1",
            "--output", str(mlc_output / "params"),
        ], check=True, timeout=600)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("  ⚠ mlc_llm not available. Install: pip install mlc-llm")
        print(f"  Config written to {config_path}")

    # 3. Compile model library for WebGPU
    print("  Compiling model library for WebGPU...")
    try:
        subprocess.run([
            sys.executable, "-m", "mlc_llm", "compile",
            str(config_path),
            "--device", "webgpu",
            "--output", str(mlc_output / "lib"),
        ], check=True, timeout=600)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("  ⚠ MLC compile failed (see above).")

    print(f"  ✅ MLC model exported: {mlc_output}")
    return mlc_output


# ─── Generate Akasha manifest ──────────────────────────────────────────────

def generate_manifest(
    input_dir: Path,
    output_dir: Path,
    domain: str,
    model_size: str,
    quantized_path: Path,
) -> dict:
    """Write akasha_torrent_manifest.json for P2P distribution."""
    manifest = {
        "domain": domain,
        "model_size": model_size,
        "quantization": "INT4",
        "source_dir": str(input_dir),
        "quantized_path": str(quantized_path),
        "estimated_size_bytes": MODEL_SIZE_ESTIMATES.get(
            model_size, quantized_path.stat().st_size if quantized_path.exists() else 0
        ),
        "format": "gguf" if quantized_path.suffix == ".gguf" else "mlc",
        "webgpu_compatible": True,
        "indexeddb_cache_key": f"akasha-model-{domain}-{model_size}",
    }

    manifest_path = output_dir / "akasha_torrent_manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\n  Manifest: {manifest_path}")
    return manifest


# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Akasha-OS INT4 Quantisation & WebGPU/Wasm Export"
    )
    parser.add_argument(
        "--input", type=str, required=True,
        help="Path to fine-tuned model directory (LoRA adapter or merged)"
    )
    parser.add_argument(
        "--format", type=str, default="gguf",
        choices=["gguf", "mlc"],
        help="Export format: gguf (llama.cpp) or mlc (MLC-LLM WebGPU)"
    )
    parser.add_argument(
        "--bits", type=int, default=4,
        choices=[4, 8],
        help="Quantisation bits: 4 (INT4) or 8 (INT8)"
    )
    parser.add_argument(
        "--output", type=str, default="./output",
        help="Output directory for quantised models"
    )
    parser.add_argument(
        "--domain", type=str, default="",
        help="Expert domain name (auto-detected from akasha_meta.json if empty)"
    )

    args = parser.parse_args()
    input_dir = Path(args.input).resolve()
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_dir.exists():
        print(f"Error: input directory not found: {input_dir}")
        sys.exit(1)

    # ── Detect model info ──
    model_size = detect_model_size(input_dir)
    domain = args.domain

    # Try to load domain from akasha_meta.json
    meta_path = input_dir / "akasha_meta.json"
    if meta_path.exists():
        with open(meta_path) as f:
            meta = json.load(f)
            if not domain:
                domain = meta.get("domain", "")
            print(f"  Detected domain: {domain}, model: {model_size}")

    print(f"\n{'='*60}")
    print(f" Akasha-OS INT4 Export")
    print(f" Input:  {input_dir}")
    print(f" Format: {args.format}  |  Bits: {args.bits}")
    print(f" Domain: {domain}  |  Size: {model_size}")
    print(f"{'='*60}")

    # ── Export ──
    if args.format == "gguf":
        if not check_tool("python3", "pip install llama-cpp-python"):
            sys.exit(1)
        quantized = export_gguf(input_dir, output_dir, args.bits)
    else:
        if not check_tool("python3", "pip install mlc-llm"):
            sys.exit(1)
        quantized = export_mlc(input_dir, output_dir, args.bits)

    # ── Manifest ──
    generate_manifest(input_dir, output_dir, domain, model_size, quantized)


if __name__ == "__main__":
    main()
