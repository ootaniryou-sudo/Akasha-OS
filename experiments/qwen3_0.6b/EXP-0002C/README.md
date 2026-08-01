# EXP-0002C — Capability-Aware Routing

> **Phase 3: Intelligent Routing の最初の実験。**
> **Scheduler が Node の Capability を評価し、適切な Expert にルーティングする。**

## Objective

2つの Node（同一 Qwen3-0.6B、異なる Capability プロファイル）に対して、
Prompt の内容に基づいて Capability-Aware Scheduler が適切な Expert を選択できることを確認。

```
Master Hub (:8080) — Capability-Aware Scheduler
  ├── Node A — Role: expert, Capability: { coding: 0.95, math: 0.65 }
  └── Node B — Role: expert, Capability: { coding: 0.62, math: 0.94 }
```

## Routing Logic

```
Prompt → Classify (coding/math/general) → Select best-capability node

  "Write Python code"     → Node A (coding: 0.95)  ✅
  "Solve integral"        → Node B (math: 0.94)    ✅
  "What is 2+2?"          → tie → round-robin fallback
```

## Success Criteria

- [ ] 2 Nodes register with capability profiles
- [ ] Prompt Classifier categorizes into coding / math / general
- [ ] Coding prompts → routed to coding expert (Node A)
- [ ] Math prompts → routed to math expert (Node B)
- [ ] Capability tie → fallback to round-robin
- [ ] Routing accuracy measured (% correct)

## Architecture

```
Master Hub
  ├── CapabilityRegistry      ← Node capabilities stored & queried
  ├── PromptClassifier        ← Classifies prompt into capability domain
  └── CapabilityScheduler     ← Selects best node via capability match
```

### Node Registration (extended protocol)

```json
{
  "type": "register",
  "node": {
    "id": "node-coding",
    "role": "expert",
    "capabilities": {
      "coding": 0.95,
      "math": 0.65,
      "general": 0.80
    }
  }
}
```

### Prompt → Capability (keyword-based MVP)

| Keywords | Capability |
|----------|-----------|
| `def`, `function`, `code`, `Python`, `write`, `implement` | coding |
| `calculate`, `solve`, `integral`, `sum`, `equation`, `math` | math |
| (none matched) | general → round-robin |

## Running

```bash
# Terminal 1: Master Hub (capability-aware)
npx tsx experiments/qwen3_0.6b/EXP-0002C/run_master.ts --port 8080

# Terminal 2: Node A (coding expert)
npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts \
  --master ws://localhost:8080 --node-id node-coding \
  --capability '{"coding":0.95,"math":0.65,"general":0.80}'

# Terminal 3: Node B (math expert)
npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts \
  --master ws://localhost:8080 --node-id node-math \
  --capability '{"coding":0.62,"math":0.94,"general":0.80}'
```

## Next

- **EXP-0002D**: Shadow Routing（Main + Shadow + Verification）
- **EXP-0002E**: Cost-Aware Routing
- **EXP-0002F**: Latency-Aware Routing
- **EXP-0002G**: Stability-Aware Routing（EXP-0001 の成果を活用）
