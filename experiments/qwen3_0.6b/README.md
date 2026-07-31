# Qwen3-0.6B Akasha Integration Experiment

## EXP-0001 — Akasha Single-Node LLM Integration

**Goal**: Prove that Qwen3-0.6B can run on Akasha-OS and produce token-identical output to standalone PyTorch inference.

### Success Criteria

- [ ] Qwen3-0.6B standalone inference works (reference)
- [ ] Qwen via Akasha LLM Adapter works (direct mode)
- [ ] Qwen via full Akasha path works (--akasha mode): Master → Router → Protocol → Node → Qwen
- [ ] Token IDs match between Akasha and reference
- [ ] Token-level timing recorded

### Running

```bash
# 1. Golden Reference (PyTorch, standalone)
python experiments/qwen3_0.6b/reference/run_reference.py \
  --model Qwen/Qwen3-0.6B \
  --prompt-file experiments/qwen3_0.6b/prompts/basic.jsonl \
  --output-dir experiments/qwen3_0.6b/reference/golden

# 2. Akasha — Direct Adapter Mode (validates LLM Adapter API)
npx tsx experiments/qwen3_0.6b/run_single_node.ts \
  --model Qwen/Qwen3-0.6B \
  --prompt-file experiments/qwen3_0.6b/prompts/basic.jsonl \
  --golden-dir experiments/qwen3_0.6b/reference/golden

# 3. Akasha — Full Integration Path (validates distributed path)
npx tsx experiments/qwen3_0.6b/run_single_node.ts \
  --akasha \
  --model Qwen/Qwen3-0.6B \
  --prompt-file experiments/qwen3_0.6b/prompts/basic.jsonl \
  --golden-dir experiments/qwen3_0.6b/reference/golden
```

### Configs

- `configs/single-node.json` — 1 Akasha node with Qwen3-0.6B adapter
- `configs/four-node.json` — 4 simulated nodes (future)
- Config files are generated on first run via `--generate-configs`

### Important: Two Paths

| Path | What It Tests | Flag |
|------|---------------|------|
| **Direct Adapter** | `QwenAdapter.generate()` works correctly | (default) |
| **Akasha Path** | Master → Router → Binary Protocol → Node → Qwen | `--akasha` |

EXP-0001 is primarily an **adapter validation experiment**. True distributed inference validation will come in EXP-0002 (multi-node).
