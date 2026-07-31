# EXP-0002B — Two Experts

> **Router が初めて複数 Node を区別してルーティングする。**

## Objective

2つの Node（同一モデル）に対して、Router が Request を振り分けられることを確認。

```
Master
├─ Node A / Qwen3-0.6B (fp16)
└─ Node B / Qwen3-0.6B (fp16)
```

## Success Criteria

- [ ] 2 Nodes register successfully with distinct node_ids
- [ ] Router round-robins or load-balances requests
- [ ] Request 1 → Node A, Request 2 → Node B, Request 3 → Node A
- [ ] Both nodes produce valid tokens
- [ ] Per-node metrics collected independently

## What This Validates

This is NOT "ArcAsha as load balancer" — it validates the core routing infrastructure:
- Star Registry (Node Registry) works with multiple nodes
- IdleClusterPool acquires/releases correctly
- Binary protocol handles multiple concurrent connections
- Fault tolerance can track multiple transactions

## Running

```bash
# Terminal 1: Node A
npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts --port 8081 --node-id node-a

# Terminal 2: Node B
npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts --port 8082 --node-id node-b

# Terminal 3: Master
npx tsx experiments/qwen3_0.6b/EXP-0002B/run_master.ts \
  --nodes ws://localhost:8081,ws://localhost:8082 \
  --prompts ../golden/prompts.jsonl
```
