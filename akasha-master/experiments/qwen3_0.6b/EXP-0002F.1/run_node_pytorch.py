#!/usr/bin/env python3
"""
EXP-0002F.1 — PyTorch WebSocket Client Node (Cross-Backend Shadow)

Python node that connects to the Master Hub (WebSocket client, same as TS nodes)
and runs Qwen3-0.6B in PyTorch (MPS). Used as a cross-backend Shadow to detect
divergence vs the ONNX/transformers.js Main node.

Usage:
  python experiments/qwen3_0.6b/EXP-0002F.1/run_node_pytorch.py \
    --master ws://localhost:8080 --node-id node-torch-fp16 --precision fp16

Protocol (client to Master Hub):
  → {"type":"register","node":{id,platform,backend,precision,capabilities}}
  ← {"type":"register_ack","node_id":...,"stability":...}
  ← {"type":"compute","request_id":...,"prompt":...,"max_new_tokens":...}
  → {"type":"result","request_id":...,"tokens":[...],"text":"...","timing":{...}}
"""

import argparse
import asyncio
import json
import signal
import sys

import torch
import websockets


# ═══════════════════════════════════════════════════════════════════════════════
# Model loading
# ═══════════════════════════════════════════════════════════════════════════════

MODEL_ID = "Qwen/Qwen3-0.6B"


def load_model(precision: str, device: str):
    from transformers import AutoModelForCausalLM, AutoTokenizer

    print(f"  Loading {MODEL_ID} ({precision}) ...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)

    dtype = torch.float16 if precision == "fp16" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=dtype)
    model.to(device)
    model.eval()
    print(f"  Loaded on {device}, dtype={dtype}")
    return model, tokenizer


def generate(model, tokenizer, prompt: str, max_new_tokens: int, temperature: float, device: str):
    """Greedy deterministic generation for Qwen3-0.6B (matching golden ref)."""
    inputs = tokenizer(prompt, return_tensors="pt").to(device)

    with torch.no_grad():
        gen_kwargs = dict(
            max_new_tokens=max_new_tokens,
            do_sample=False if temperature == 0 else True,
            top_p=1.0,
        )
        if temperature > 0:
            gen_kwargs["temperature"] = temperature

        # Qwen3 thinking mode: only pass if model supports it
        try:
            gen_kwargs["thinking"] = False
            outputs = model.generate(**inputs, **gen_kwargs)
        except (TypeError, ValueError):
            # Model doesn't support 'thinking' kwarg (base model) — retry without
            gen_kwargs.pop("thinking", None)
            outputs = model.generate(**inputs, **gen_kwargs)

    input_len = inputs["input_ids"].shape[1]
    new_tokens = outputs[0][input_len:].tolist()
    text = tokenizer.decode(new_tokens, skip_special_tokens=True)
    return new_tokens, text


# ═══════════════════════════════════════════════════════════════════════════════
# Client
# ═══════════════════════════════════════════════════════════════════════════════

async def run_client(master_url: str, node_id: str, precision: str, device: str):
    backend = "pytorch"

    print(f"  Connecting to {master_url} ...")
    async with websockets.connect(master_url) as ws:

        # Register
        await ws.send(json.dumps({
            "type": "register",
            "node": {
                "id": node_id,
                "platform": f"python-{sys.platform}",
                "device": "Mac (PyTorch MPS)",
                "role": "expert",
                "backend": backend,
                "precision": precision,
                "capabilities": {"coding": 0.95, "math": 0.65, "general": 0.80},
            },
        }))
        print(f"  📝 Registered as {node_id} ({backend}/{precision})")

        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "register_ack":
                print(f"  ✅ ACK. Stability={msg.get('stability')}")
                print(f"  🟢 {node_id} ready\n")

            elif msg.get("type") == "ping":
                await ws.send(json.dumps({"type": "pong", "t": msg.get("t")}))

            elif msg.get("type") == "compute":
                request_id = msg.get("request_id")
                prompt = msg.get("prompt", "")
                max_tokens = msg.get("max_new_tokens", 32)
                temperature = msg.get("temperature", 0.0)

                print(f"  📥 [{request_id}] {prompt[:50]}...")
                import time
                t0 = time.time()
                try:
                    tokens, text = generate(model, tokenizer, prompt, max_tokens, temperature, device)
                    total_ms = (time.time() - t0) * 1000

                    await ws.send(json.dumps({
                        "type": "result",
                        "request_id": request_id,
                        "tokens": tokens,
                        "text": text,
                        "timing": {
                            "tokenize_ms": 0, "prefill_ms": 0,
                            "decode_ms": round(total_ms, 1), "total_ms": round(total_ms, 1),
                        },
                        "metadata": {
                            "node_id": node_id, "model_id": MODEL_ID,
                            "backend": backend, "precision": precision,
                            "platform": f"python-{sys.platform}", "role": "expert",
                        },
                    }))
                    print(f"  📤 [{request_id}] {len(tokens)} tokens, {total_ms:.0f}ms")
                except Exception as e:
                    print(f"  ❌ [{request_id}] {e}")
                    await ws.send(json.dumps({
                        "type": "error", "request_id": request_id, "error": str(e),
                    }))


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="PyTorch WebSocket client node (cross-backend shadow)")
    parser.add_argument("--master", default="ws://localhost:8080")
    parser.add_argument("--node-id", default="node-torch-fp16")
    parser.add_argument("--precision", default="fp16", choices=["fp16", "fp32"])
    parser.add_argument("--device", default="mps", choices=["mps", "cpu", "auto"])
    args = parser.parse_args()

    print("═" * 60)
    print(f"EXP-0002F.1 PyTorch Node — {args.node_id}")
    print(f"  Backend: pytorch/{args.precision}")
    print(f"  Master:  {args.master}")
    print("═" * 60)

    global model, tokenizer
    device = args.device
    if device == "auto":
        device = "mps" if torch.backends.mps.is_available() else "cpu"

    print("\n[1/2] Loading Qwen adapter...")
    model, tokenizer = load_model(args.precision, device)

    print("\n[2/2] Starting client loop...")
    try:
        asyncio.run(run_client(args.master, args.node_id, args.precision, device))
    except KeyboardInterrupt:
        print("\n  🔌 Disconnected.")
    except websockets.exceptions.ConnectionClosed as e:
        print(f"\n  🔌 Master closed: {e}")


model = None
tokenizer = None

if __name__ == "__main__":
    main()
