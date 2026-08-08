"""
Akasha-OS — QLoRA Fine-Tuning Pipeline (Python)
────────────────────────────────────────────────
Base model → domain-specific LoRA adapter via 4-bit quantised training.

Supports:
  - Qwen3-0.6B / Qwen3-1.7B
  - Llama-3.2-1B / Llama-3.2-3B
  - Any HuggingFace causal LM compatible with `peft` + `bitsandbytes`

Usage:
  python finetune.py --base Qwen/Qwen3-0.6B --domain math --epochs 3

Output:
  ./output/{domain}-lora/  — LoRA adapter weights (SafeTensors)
  ./output/{domain}-lora/config.json
"""

import argparse
import json
import os
import time
from pathlib import Path

import torch
from datasets import load_dataset, Dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    TrainingArguments,
    TrainerCallback,
)
from peft import LoraConfig, get_peft_model, TaskType, prepare_model_for_kbit_training

# ─── Configuration ──────────────────────────────────────────────────────────

DOMAIN_DATASETS = {
    "math": [
        "meta-math/MetaMathQA",       # 数学問題＋解答
        "gsm8k",                       # 小学校～高校数学
    ],
    "code": [
        "bigcode/the-stack-smol",      # コード (小規模サブセット)
        "m-a-p/Code-Feedback",         # コードQA
    ],
    "language": [
        "HuggingFaceH4/ultrachat_200k",  # 多言語対話
        "lighteval/mmlu",                 # 汎用知識
    ],
    "general": [
        "tatsu-lab/alpaca",              # 汎用命令追従
    ],
}

# ─── QLoRA 4-bit config ────────────────────────────────────────────────────

def build_bnb_config() -> BitsAndBytesConfig:
    """4-bit NF4 quantisation for memory-efficient training."""
    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4",
    )

def build_lora_config(rank: int = 64, alpha: int = 128) -> LoraConfig:
    """LoRA adapter config: rank 64, targeting all projection layers."""
    return LoraConfig(
        r=rank,
        lora_alpha=alpha,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",   # attention
            "gate_proj", "up_proj", "down_proj",       # MLP
        ],
        lora_dropout=0.05,
        bias="none",
        task_type=TaskType.CAUSAL_LM,
    )

# ─── Data loading ──────────────────────────────────────────────────────────

def load_domain_data(domain: str, max_samples: int = 10_000) -> Dataset:
    """Load and concatenate domain-specific datasets."""
    dataset_names = DOMAIN_DATASETS.get(domain, DOMAIN_DATASETS["general"])
    all_data = []

    for ds_name in dataset_names:
        try:
            ds = load_dataset(ds_name, split="train", trust_remote_code=True)
            # Take a subset to control training time
            subset = ds.select(range(min(len(ds), max_samples // len(dataset_names))))
            all_data.append(subset)
            print(f"  Loaded {ds_name}: {len(subset)} samples")
        except Exception as e:
            print(f"  ⚠ Skipping {ds_name}: {e}")

    if not all_data:
        raise ValueError(f"No datasets loaded for domain '{domain}'")

    combined = Dataset.from_list(
        [item for ds in all_data for item in ds]
    )
    return combined

# ─── Tokenisation ──────────────────────────────────────────────────────────

def tokenize_function(examples, tokenizer, max_length: int = 2048):
    """Tokenize with chat template applied."""
    texts = []

    for ex in examples:
        # Try common dataset field names
        if "messages" in ex:
            # Conversational format (e.g., ultrachat)
            texts.append(
                tokenizer.apply_chat_template(
                    ex["messages"],
                    tokenize=False,
                    add_generation_prompt=False,
                )
                if hasattr(tokenizer, "apply_chat_template")
                else str(ex["messages"])
            )
        elif "instruction" in ex and "output" in ex:
            texts.append(f"### Instruction:\n{ex['instruction']}\n\n### Response:\n{ex['output']}")
        elif "question" in ex and "answer" in ex:
            texts.append(f"Q: {ex['question']}\nA: {ex['answer']}")
        elif "text" in ex:
            texts.append(ex["text"])
        elif "content" in ex:
            texts.append(ex["content"])
        else:
            # Fallback: join all string values
            texts.append(" ".join(str(v) for v in ex.values() if isinstance(v, str)))

    tokenized = tokenizer(
        texts,
        truncation=True,
        max_length=max_length,
        padding="max_length",
        return_tensors="pt",
    )
    tokenized["labels"] = tokenized["input_ids"].clone()
    return tokenized

# ─── Training ──────────────────────────────────────────────────────────────

class PrintCallback(TrainerCallback):
    """Log training progress."""
    def on_log(self, args, state, control, logs=None, **kwargs):
        if logs and "loss" in logs:
            step = state.global_step
            loss = logs["loss"]
            lr = logs.get("learning_rate", 0)
            print(f"  Step {step:>6}: loss={loss:.4f}, lr={lr:.2e}")

def finetune(
    base_model: str,
    domain: str,
    output_dir: str,
    epochs: int = 3,
    lora_rank: int = 64,
    max_samples: int = 10_000,
    batch_size: int = 4,
    gradient_accumulation: int = 4,
    learning_rate: float = 2e-4,
    max_length: int = 2048,
):
    print(f"\n{'='*60}")
    print(f" Akasha-OS QLoRA Fine-Tuning")
    print(f" Base: {base_model}  |  Domain: {domain}  |  Epochs: {epochs}")
    print(f"{'='*60}\n")

    # ── 1. Load base model with 4-bit quantisation ──
    print("Loading base model (4-bit)...")
    bnb_config = build_bnb_config()

    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
        attn_implementation="flash_attention_2",  # fallback to sdpa if not available
    )

    tokenizer = AutoTokenizer.from_pretrained(base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # ── 2. Prepare for k-bit training + apply LoRA ──
    print("Applying LoRA adapters...")
    model = prepare_model_for_kbit_training(model)
    lora_config = build_lora_config(rank=lora_rank)
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    # ── 3. Load domain data ──
    print(f"\nLoading {domain} training data...")
    dataset = load_domain_data(domain, max_samples=max_samples)

    # ── 4. Tokenise ──
    print("Tokenising...")
    tokenized = dataset.map(
        lambda x: tokenize_function(x, tokenizer, max_length),
        batched=True,
        remove_columns=dataset.column_names,
    )

    # ── 5. Train ──
    output_path = Path(output_dir) / f"{domain}-lora"
    output_path.mkdir(parents=True, exist_ok=True)

    training_args = TrainingArguments(
        output_dir=str(output_path / "checkpoints"),
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=gradient_accumulation,
        learning_rate=learning_rate,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        logging_steps=10,
        save_steps=200,
        save_total_limit=2,
        bf16=torch.cuda.is_bf16_supported(),
        fp16=not torch.cuda.is_bf16_supported(),
        report_to="none",
        dataloader_num_workers=2,
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized,
        tokenizer=tokenizer,
        callbacks=[PrintCallback()],
    )

    start = time.time()
    print(f"\nTraining started ({epochs} epochs)...\n")
    trainer.train()

    elapsed = time.time() - start
    print(f"\nTraining complete: {elapsed/60:.1f} minutes")

    # ── 6. Save LoRA adapter ──
    print(f"Saving LoRA adapter to {output_path}...")
    model.save_pretrained(str(output_path))
    tokenizer.save_pretrained(str(output_path))

    # Save metadata for the Akasha pipeline
    meta = {
        "base_model": base_model,
        "domain": domain,
        "lora_rank": lora_rank,
        "training_samples": len(dataset),
        "epochs": epochs,
        "trainable_params": sum(p.numel() for p in model.parameters() if p.requires_grad),
        "output_dir": str(output_path),
    }
    with open(output_path / "akasha_meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    print(f"Done! LoRA saved to {output_path}")
    return str(output_path)

# ─── CLI ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Akasha-OS QLoRA Fine-Tuning Pipeline"
    )
    parser.add_argument(
        "--base", type=str, default="Qwen/Qwen2.5-0.5B",
        help="Base HuggingFace model ID (default: Qwen/Qwen2.5-0.5B)"
    )
    parser.add_argument(
        "--domain", type=str, default="math",
        choices=["math", "code", "language", "general"],
        help="Expert domain to fine-tune for"
    )
    parser.add_argument(
        "--epochs", type=int, default=3,
        help="Number of training epochs"
    )
    parser.add_argument(
        "--lora-rank", type=int, default=64,
        help="LoRA rank (default: 64)"
    )
    parser.add_argument(
        "--max-samples", type=int, default=10_000,
        help="Max training samples (default: 10000)"
    )
    parser.add_argument(
        "--batch-size", type=int, default=4,
        help="Per-device batch size"
    )
    parser.add_argument(
        "--output", type=str, default="./output",
        help="Output directory for LoRA adapters"
    )
    parser.add_argument(
        "--lr", type=float, default=2e-4,
        help="Learning rate"
    )

    args = parser.parse_args()

    finetune(
        base_model=args.base,
        domain=args.domain,
        output_dir=args.output,
        epochs=args.epochs,
        lora_rank=args.lora_rank,
        max_samples=args.max_samples,
        batch_size=args.batch_size,
        learning_rate=args.lr,
    )

if __name__ == "__main__":
    main()

