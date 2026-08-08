#!/usr/bin/env python3
"""
Golden Reference — standalone Qwen3-0.6B inference for output comparison.

Usage:
  python run_reference.py --model Qwen/Qwen3-0.6B --prompt-file prompts/basic.jsonl --output-dir golden/

Output:
  golden/{index}.json  → {prompt, input_tokens, output_tokens, decoded_text, timing_ms}
"""

import argparse, json, os, time, sys
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='Qwen/Qwen3-0.6B')
    parser.add_argument('--prompt-file', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--device', default='cpu')
    args = parser.parse_args()

    print(f"Loading {args.model} ...")
    t0 = time.time()

    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch
    except ImportError:
        print("ERROR: pip install transformers torch")
        sys.exit(1)

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype=torch.float32,
        device_map=args.device,
        trust_remote_code=True,
    )
    model.eval()

    print(f"Loaded in {time.time() - t0:.1f}s")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    with open(args.prompt_file) as f:
        prompts = [json.loads(line) for line in f if line.strip()]

    env_info = {
        "model": args.model,
        "device": args.device,
        "torch_version": torch.__version__,
        "transformers_version": __import__('transformers').__version__,
    }
    with open(output_dir / "environment.json", "w") as f:
        json.dump(env_info, f, indent=2)

    for idx, p in enumerate(prompts):
        prompt = p['prompt']
        max_tokens = p.get('max_new_tokens', 20)
        temperature = p.get('temperature', 0.0)
        top_p = p.get('top_p', 1.0)

        print(f"\n[{idx}] Prompt: {prompt[:60]}...")

        # Tokenize
        t_tok = time.time()
        inputs = tokenizer(prompt, return_tensors='pt').to(args.device)
        input_ids = inputs['input_ids'][0].tolist()
        tok_ms = (time.time() - t_tok) * 1000

        # Generate
        t_gen = time.time()
        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=max_tokens,
                temperature=temperature if temperature > 0 else 1.0,
                do_sample=temperature > 0,
                top_p=top_p,
                pad_token_id=tokenizer.eos_token_id,
            )
        gen_ms = (time.time() - t_gen) * 1000

        output_ids = outputs[0][inputs['input_ids'].shape[1]:].tolist()
        decoded = tokenizer.decode(output_ids, skip_special_tokens=True)

        result = {
            "index": idx,
            "prompt": prompt,
            "input_token_ids": input_ids,
            "output_token_ids": output_ids,
            "decoded_text": decoded,
            "timing_ms": {
                "tokenize": round(tok_ms, 2),
                "generate": round(gen_ms, 2),
                "total": round(tok_ms + gen_ms, 2),
            },
            "config": {
                "max_new_tokens": max_tokens,
                "temperature": temperature,
                "top_p": top_p,
            },
        }

        out_path = output_dir / f"{idx:03d}.json"
        with open(out_path, "w") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

        print(f"  → {len(output_ids)} tokens: {decoded[:60]}...")
        print(f"  → saved to {out_path}")

    print(f"\nDone. {len(prompts)} prompts processed.")


if __name__ == "__main__":
    main()

