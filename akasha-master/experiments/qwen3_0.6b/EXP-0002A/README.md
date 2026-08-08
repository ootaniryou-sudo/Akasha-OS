# EXP-0002A — Remote Single Expert

> **Master PC が、実際の別 Node にいる Qwen3-0.6B を ArcAsha 経由で起動・実行・回収できるか。**

## Objective

First true distributed inference: 1 Master + 1 Remote Node via ArcAsha protocol.

```
Master PC (Heart of Wisdom)
  │
  ├─ Eye of Wisdom (route request)
  ├─ Knowledge Edict (binary protocol)
  │
  ▼
Node A (Remote)
  ├─ Qwen3-0.6B
  └─ Return tokens via Knowledge Edict
```

## Success Criteria

- [ ] Node discovery & registration over WebSocket
- [ ] Model metadata registered (backend, precision, platform, capability)
- [ ] Master sends COMPUTE_TASK via binary protocol
- [ ] Remote Node executes Qwen3-0.6B inference
- [ ] Result tokens returned to Master via RESULT packet
- [ ] Token-level timing recorded at both ends

## Architecture

### Master Side
```
AkashaRouter
  ├─ submitPrompt(prompt) → route → pickLocalNode → COMPUTE_TASK
  ├─ onResult(txId, tokens) → logit tournament → final token
  └─ ExperimentLogger → per-request metrics
```

### Node Side
```
AkashaEdgeNode
  ├─ onComputeTask(packet) → QwenAdapter.generate()
  └─ sendResult(txId, tokens)
```

## Required Metrics (per request)

```json
{
  "request_id": "req-0001",
  "node_id": "node-001",
  "model_id": "Qwen3-0.6B",
  "backend": "pytorch-mps",
  "precision": "fp16",
  "platform": "macos-arm64",
  "network": "localhost",
  "input_tokens": 8,
  "output_tokens": 32,

  "routing_ms": 1.2,
  "network_ms": 3.5,
  "queue_ms": 0.0,
  "prefill_ms": 150,
  "decode_ms": 850,
  "total_ms": 1004.7,

  "network_bytes": 256,
  "memory_usage_mb": 1200,
  "temperature": 0.0,
  "battery_pct": null,
  "failure": false,
  "retry": 0
}
```

## Local vs Remote Comparison

Run identical prompts:
1. **Local**: Master PC直接で QwenAdapter.generate()
2. **Remote**: Master → Protocol → Remote Node → Qwen → Protocol → Master

Measure the **distributed overhead**:

```
Overhead = Remote total_ms − Local total_ms
         = routing_ms + network_ms + serialization_ms
```

## Running

```bash
# Terminal 1: Remote Node
npx tsx experiments/qwen3_0.6b/EXP-0002A/run_node.ts --port 8081

# Terminal 2: Master
npx tsx experiments/qwen3_0.6b/EXP-0002A/run_master.ts \
  --node ws://localhost:8081 \
  --prompts ../golden/prompts.jsonl
```

## Output

```
EXP-0002A/output/
├── manifest.json
├── local_baseline/
│   └── run.json
├── remote/
│   └── run.json
├── comparison.json       # Local vs Remote overhead
└── RESULTS.md
```

