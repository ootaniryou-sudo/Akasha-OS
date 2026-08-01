# EXP-0002E.2 — Pareto Routing

> **Capability / Latency / Stability の複数軸で Pareto Frontier を描き、**
> **Router はフロンティア上のみから選択する。**

## Objective

0002E では重み付き和（スカラー化）で 1 つのスコアに圧縮した。
0002E.2 では、複数軸のまま Pareto Dominance で比較する。

```
Capability ↑
    │        ●C
    │     ●B
    │  ●A
    │
    └──────────→ Stability →

  A: 低能力・低安定性 → 劣る（Pareto 支配される）
  B: 中能力・中安定性 → フロンティア上
  C: 高能力・高安定性 → フロンティア上（最良）
```

## Pareto Dominance

```
Node X dominates Node Y if:
  X ≥ Y on all axes AND X > Y on at least one axis

Router は非支配集合（Pareto Frontier）のみを考慮。
```

## 3-Axis Example

| Node | Capability | Latency (ms) | Stability |
|------|:---:|:---:|:---:|
| A | 0.70 | 10 | 0.90 |
| B | 0.85 | 40 | 0.99 |
| C | 0.95 | 80 | 0.99 |
| D | 0.90 | 60 | 0.79 |

```
Frontier: B, C (A は B に支配、D は低安定性で除外)

Router は B vs C のトレードオフだけを扱う
  B: 中能力・低遅延
  C: 高能力・高遅延
```

## Success Criteria

- [ ] Multi-axis Pareto dominance computed
- [ ] Dominated nodes excluded from routing
- [ ] Frontier visualization (2D/3D scatter)
- [ ] Trade-off between frontier nodes quantified
- [ ] Comparison with weighted-sum (0002E) results

## Running

```bash
npx tsx experiments/qwen3_0.6b/EXP-0002E.2/run_pareto.ts
```

Depends on: EXP-0002E (Composite Score), EXP-0002E.1 (Sensitivity)
