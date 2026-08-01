# EXP-0002E — Composite Score Routing

> **Capability + Latency + Stability + Cost の複合スコアでルーティングする。**

## Objective

EXP-0002C では Capability 単軸でルーティングした。
EXP-0002E では、EXP-0001（数値安定性）と EXP-0002A/B（レイテンシ）の成果を統合し、
複合スコアで最適ノードを選択する。

## Composite Score Formula

```
Score(node, task) =
    0.55 × Capability(node, task)    ← EXP-0002C: タスク適性
  + 0.25 × Latency(node)             ← EXP-0002A: RTT正規化値
  + 0.20 × Stability(node, backend) ← EXP-0001: 数値安定性プロファイル
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
