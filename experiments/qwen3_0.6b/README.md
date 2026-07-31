# Qwen3-0.6B Akasha Integration Experiment

## EXP-0001 — Akasha Single-Node LLM Integration

**Goal**: Prove that Qwen3-0.6B can run via the Akasha LLM Adapter and produce token-identical output to standalone inference.

### Success Criteria

- [ ] Qwen standalone inference works (reference)
- [ ] Qwen via Akasha LLM Adapter works
- [ ] Token IDs match between Akasha and reference
- [ ] Token-level timing recorded

### Running

```bash
# 1. Golden Reference
python experiments/qwen3_0.6b/reference/run_reference.py \
  --model Qwen/Qwen2.5-0.5B-Instruct \
  --prompt-file experiments/qwen3_0.6b/prompts/basic.jsonl \
  --output-dir experiments/qwen3_0.6b/reference/golden

# 2. Akasha Single Node
npx tsx experiments/qwen3_0.6b/run_single_node.ts \
  --model Qwen/Qwen2.5-0.5B-Instruct \
  --prompt-file experiments/qwen3_0.6b/prompts/basic.jsonl \
  --golden-dir experiments/qwen3_0.6b/reference/golden
```

### Configs

- `configs/single-node.json` — 1 Akasha node with Qwen adapter
- `configs/four-node.json` — 4 simulated nodes (future)
