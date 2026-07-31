# EXP-0002C — Specialized Experts

> **「ArcAsha は単なるロードバランサーではない」ことの第一歩。**

## Objective

Capability Profile に基づいて Router が適切な Expert を選択する。

```
Master
├─ Node A / Qwen3-0.6B → Capability: general=0.9, math=0.6
└─ Node B / Qwen3-0.6B → Capability: math=0.9, general=0.5
```

## Success Criteria

- [ ] Capability Profiles registered per-node
- [ ] Math prompt → Router selects Node B (higher math score)
- [ ] General prompt → Router selects Node A (higher general score)
- [ ] Selection is deterministic and logged
- [ ] Same model, different capability profiles → correct routing

## Design

### Capability Profile (simulated for now)

```json
{
  "node-a": { "general": 0.9, "math": 0.6, "coding": 0.5 },
  "node-b": { "general": 0.5, "math": 0.9, "coding": 0.7 }
}
```

### Task Vectors (simulated)

```json
{
  "math_prompt":    { "math": 0.95, "general": 0.3 },
  "general_prompt": { "general": 0.9, "math": 0.1 }
}
```

### Routing Logic

```
score(node) = Σ capability[key] × task_vector[key]
            = max over nodes

Math:     Node A = 0.6×0.95+0.9×0.3=0.84, Node B = 0.9×0.95+0.5×0.3=1.01 → B ✅
General:  Node A = 0.9×0.9+0.6×0.1=0.87,  Node B = 0.5×0.9+0.9×0.1=0.54 → A ✅
```

## Running

```bash
# 3 terminals: Node A (general), Node B (math), Master
npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts --port 8081 --profile general
npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts --port 8082 --profile math
npx tsx experiments/qwen3_0.6b/EXP-0002C/run_master.ts --nodes ws://localhost:8081,ws://localhost:8082
```
