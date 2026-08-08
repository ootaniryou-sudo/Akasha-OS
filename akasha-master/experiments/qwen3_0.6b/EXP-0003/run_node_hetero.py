#!/usr/bin/env python3
"""
EXP-0003 — Heterogeneous PyTorch WebSocket Client Node

Runs an arbitrary HF causal LM on MPS (or CPU) and connects to the Master Hub
as a WebSocket client. Used as a Heterogeneous Expert in EXP-0003
(Belief(Node, Task) learning across truly different model families).

Usage:
  python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
    --master ws://localhost:8080 \
    --node-id node-gemma \
    --model unsloth/gemma-3-1b-it \
    --precision fp16 --device mps

  python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
    --master ws://localhost:8080 \
    --node-id node-smollm \
    --model HuggingFaceTB/SmolLM2-360M-Instruct \
    --precision fp16 --device mps

Protocol (client to Master Hub):
  → {"type":"register","node":{id,platform,backend,precision,capabilities,model_id}}
  ← {"type":"register_ack","node_id":...,"stability":...}
  ← {"type":"compute","request_id":...,"prompt":...,"max_new_tokens":...,"temperature":...}
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

def load_model(model_id: str, precision: str, device: str):
    from transformers import AutoModelForCausalLM, AutoTokenizer

    print(f"  Loading {model_id} ({precision}) ...")
    tokenizer = AutoTokenizer.from_pretrained(model_id)

    dtype = torch.float16 if precision == "fp16" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(model_id, dtype=dtype)
    model.to(device)
    model.eval()

    n_params = sum(p.numel() for p in model.parameters()) / 1e6
    print(f"  Loaded on {device}, dtype={dtype}, {n_params:.0f}M params, tok={tokenizer.__class__.__name__}")
    return model, tokenizer


def generate(model, tokenizer, prompt: str, max_new_tokens: int, temperature: float, device: str):
    """Greedy deterministic generation (temperature=0) or sampled (temperature>0)."""
    inputs = tokenizer(prompt, return_tensors="pt").to(device)

    with torch.no_grad():
        gen_kwargs = dict(
            max_new_tokens=max_new_tokens,
            do_sample=False if temperature == 0 else True,
            top_p=1.0,
        )
        if temperature > 0:
            gen_kwargs["temperature"] = temperature

        # Qwen3 thinking mode: only pass if model supports it (base models reject it)
        try:
            gen_kwargs["thinking"] = False
            outputs = model.generate(**inputs, **gen_kwargs)
        except (TypeError, ValueError):
            gen_kwargs.pop("thinking", None)
            outputs = model.generate(**inputs, **gen_kwargs)

    input_len = inputs["input_ids"].shape[1]
    new_tokens = outputs[0][input_len:].tolist()
    text = tokenizer.decode(new_tokens, skip_special_tokens=True)
    return new_tokens, text


def apply_chat_template(tokenizer, prompt: str) -> str:
    """Apply chat template if the tokenizer supports it, else use raw prompt."""
    try:
        msgs = [{"role": "user", "content": prompt}]
        return tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    except Exception:
        return prompt


# ═══════════════════════════════════════════════════════════════════════════════
# Client
# ═══════════════════════════════════════════════════════════════════════════════

async def run_client(master_url: str, node_id: str, model_id: str, precision: str, device: str):
    backend = "pytorch"
    # Model family name for capability hints (e.g. qwen, smollm, gemma, phi)
    family = node_id.split("-")[-1]

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
                "model_id": model_id,
                "capabilities": {"coding": 0.8, "math": 0.8, "general": 0.8},
            },
        }))
        print(f"  📝 Registered as {node_id} ({model_id})")

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
                use_chat = msg.get("chat", True)

                print(f"  📥 [{request_id}] {prompt[:50]}...")
                import time
                t0 = time.time()
                try:
                    # Apply chat template for instruct models (Qwen3 already
                    # expects plain prompt from golden ref; others use template)
                    gen_prompt = apply_chat_template(tokenizer, prompt) if use_chat else prompt
                    tokens, text = generate(model, tokenizer, gen_prompt, max_tokens, temperature, device)
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
                            "node_id": node_id, "model_id": model_id,
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
    parser = argparse.ArgumentParser(description="Heterogeneous PyTorch WebSocket client node")
    parser.add_argument("--master", default="ws://localhost:8080")
    parser.add_argument("--node-id", default="node-hetero")
    parser.add_argument("--model", default="HuggingFaceTB/SmolLM2-360M-Instruct")
    parser.add_argument("--precision", default="fp16", choices=["fp16", "fp32"])
    parser.add_argument("--device", default="mps", choices=["mps", "cpu", "auto"])
    args = parser.parse_args()

    print("═" * 60)
    print(f"EXP-0003 Heterogeneous Node — {args.node_id}")
    print(f"  Model:   {args.model}")
    print(f"  Backend: pytorch/{args.precision}")
    print(f"  Master:  {args.master}")
    print("═" * 60)

    global model, tokenizer
    device = args.device
    if device == "auto":
        device = "mps" if torch.backends.mps.is_available() else "cpu"

    print("\n[1/2] Loading model...")
    model, tokenizer = load_model(args.model, args.precision, device)

    print("\n[2/2] Starting client loop...")
    try:
        asyncio.run(run_client(args.master, args.node_id, args.model, args.precision, device))
    except KeyboardInterrupt:
        print("\n  👋 bye")
        sys.exit(0)


if __name__ == "__main__":
    main()
