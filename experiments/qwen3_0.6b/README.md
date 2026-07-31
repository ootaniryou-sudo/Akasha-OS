# Qwen3-0.6B Akasha Integration Experiment

## ⚠️ Prerequisite: EXP-0000

**Before running EXP-0001, you MUST run EXP-0000 first.**

[`golden/README.md`](golden/README.md) — establishes the Golden Reference:
pure Qwen3-0.6B via Python Transformers, no ArcAsha.

```
EXP-0000 (golden/)  →  EXP-0001 (this)  →  EXP-0002+ (future)
```

If EXP-0000 fails, EXP-0001 is meaningless. See [`golden/README.md`](golden/README.md).

---

## EXP-0001 — Akasha Single-Node LLM Integration

**Goal**: Prove that Qwen3-0.6B can run on Akasha-OS and produce token-identical output to the EXP-0000 Golden Reference.

### Success Criteria

- [ ] EXP-0000 Golden Reference completed (prerequisite)
- [ ] Qwen via Akasha LLM Adapter works (direct mode)
- [ ] Qwen via full Akasha path works (--akasha mode): Master → Router → Protocol → Node → Qwen
- [ ] Token IDs match between Akasha and EXP-0000 Golden Reference
- [ ] Token-level timing recorded

### Running

```bash
# 0. Prerequisite — Golden Reference (run first!)
python experiments/qwen3_0.6b/golden/run_golden.py

# 1. Akasha — Direct Adapter Mode (validates LLM Adapter API)
npx tsx experiments/qwen3_0.6b/run_single_node.ts \
  --model Qwen/Qwen3-0.6B \
  --prompt-file experiments/qwen3_0.6b/golden/prompts.jsonl \
  --golden-dir experiments/qwen3_0.6b/golden/output

# 2. Akasha — Full Integration Path (validates distributed path)
npx tsx experiments/qwen3_0.6b/run_single_node.ts \
  --akasha \
  --model Qwen/Qwen3-0.6B \
  --prompt-file experiments/qwen3_0.6b/golden/prompts.jsonl \
  --golden-dir experiments/qwen3_0.6b/golden/output
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

### Explicitly Out of Scope for EXP-0001

The following are **deliberately deferred** to avoid confounding results:

| Deferred Item | Reason | Target Phase |
|---------------|--------|--------------|
| 1M Context | Requires hierarchical paging (HOT/WARM/COLD) — not needed for adapter validation | Phase 6+ |
| MoE (Constellation Mind) | Requires multi-expert routing — single-node test first | Phase 8+ |
| Activation Compression | Premature optimization — validate baseline first | Phase 8+ |
| Adaptive Precision | Premature optimization — validate baseline first | Phase 8+ |
| Rust native kernel | WebGPU/TS path sufficient for adapter validation | Phase 4+ |
| 10,000 nodes | Scaling experiment — meaningless before single-node works | Phase 5+ |
| Smartphone swarm | Physical deployment — validate logic in simulation first | Phase 5+ |

> **Principle**: If you touch these now, you won't know what succeeded.
> EXP-0001 answers exactly one question: *"Does Qwen3-0.6B run correctly through the Akasha LLM Adapter?"*
