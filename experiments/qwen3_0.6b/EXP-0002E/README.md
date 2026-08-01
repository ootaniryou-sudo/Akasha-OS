# EXP-0002E — Composite Score Routing

> **Capability + Confidence + Latency + Stability + Cost の複合スコアでルーティング。**
> **EXP-0001 の Numerical Stability が初めて Routing に直接活用される。**
> **0002D.1（Evaluator精度）→ 0002E（複合判断）→ 0002F（Shadow検証）の中心。**

## Composite Score Formula

```
Score(node, task) =
    w₁ × Capability(node, task)   ← 0002C/0002D: タスク適性
  + w₂ × Confidence(node, task)   ← 0002D.1: 推定の信頼度
  + w₃ × Latency(node)            ← 0002A: RTT
  + w₄ × Stability(node, backend) ← 0001: 数値安定性プロファイル
  + w₅ × Cost(node)               ← 計算コスト（将来）
```

### Concrete Example

```
Node A (FP16 MPS):
  Capability=0.93, Confidence=0.85, Latency=18ms, Stability=0.992
  Score = 0.35×0.93 + 0.15×0.85 + 0.20×1.0 + 0.30×0.992 = 0.950

Node B (BF16 MPS):
  Capability=0.95, Confidence=0.90, Latency=210ms, Stability=0.791
  Score = 0.35×0.95 + 0.15×0.90 + 0.20×0.09 + 0.30×0.791 = 0.724

→ Node A wins: 能力は少し低いが、速くて安定している
```

### Weight Rationale

| Factor | Weight | Rationale |
|--------|:---:|------|
| Capability | 0.55 | 最重要：タスクに適したExpertを選ぶ |
| Latency | 0.25 | 実用上重要：応答速度 |
| Stability | 0.20 | 品質保証：バックエンド固有の数値リスク |

## Architecture

```
Master Hub
  ├── CapabilityRegistry   ← EXP-0002C
  ├── LatencyMonitor       ← EXP-0002A (RTT tracking)
  ├── StabilityProfile     ← EXP-0001 (platform/backend/precision)
  └── CompositeScheduler   ← Weighted score calculation
```

### Stability Score (from EXP-0001)

```
Stability(backend, precision) = 1.0 − divergence_rate

Example:
  FP16 MPS:  stability = 1.0 − 0.008 = 0.992
  BF16 MPS:  stability = 1.0 − 0.209 = 0.791
```

## Success Criteria

- [ ] Composite score combines 3 dimensions correctly
- [ ] High-capability node chosen for specialized tasks
- [ ] Low-latency node preferred when capability scores tie
- [ ] Low-stability backend deprioritized (BF16 on MPS)
- [ ] Score weights adjustable via config

## Running

```bash
npx tsx experiments/qwen3_0.6b/EXP-0002E/run_master.ts --port 8080 \
  --weights '{"capability":0.55,"latency":0.25,"stability":0.20}'
```

Depends on: EXP-0001 (Stability), EXP-0002A (Latency), EXP-0002C (Capability)
