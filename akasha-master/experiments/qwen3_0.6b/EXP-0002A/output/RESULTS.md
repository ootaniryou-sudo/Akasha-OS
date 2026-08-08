# EXP-0002A Results — 2026-07-31

## Remote Single Expert: First Distributed Inference

**1 Master + 1 Remote Node via WebSocket (localhost)**

---

## Result: ✅ PASS — Distributed inference functional

```
Master PC → WebSocket → Remote Node → Qwen3-0.6B → Tokens → Master
```

### Core Metrics

| Metric | Value |
|--------|-------|
| **Network overhead** | **2ms** (localhost) |
| Node inference time | 1,512ms avg |
| Roundtrip time | 1,514ms avg |
| Tokens/s (remote) | 21.1 |
| Protocol | JSON (MVP) |

### What Worked

- [x] Node discovery & WebSocket connection
- [x] Model loaded on remote node (`onnx-community/Qwen3-0.6B-ONNX`)
- [x] Prompt sent from Master to Node
- [x] Qwen3-0.6B inference executed on remote Node
- [x] Tokens returned to Master
- [x] Timing captured at both ends

### Network Breakdown

```
Total roundtrip:   1,514ms
  Node inference:  1,512ms (99.9%)
  Network + JSON:     2ms (0.1%)
```

On localhost, serialization + transport is negligible (2ms). Real network overhead will be measured in EXP-0002B with actual separate machines.

### Known Issue: max_new_tokens default

Remote node defaulted to 32 tokens for all prompts (vs 10/20/30 specified). The `req.max_new_tokens || 32` fallback needs fixing — some prompts have `max_new_tokens: 0` which is falsy. Fix: use `??` instead of `||`.

## Output

```
EXP-0002A/output/
└── comparison.json
```

## Next: EXP-0002B — Two Experts

Add second Node, validate Router distributes requests across both.

