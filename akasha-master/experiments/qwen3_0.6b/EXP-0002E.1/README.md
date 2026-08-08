# EXP-0002E.1 — Weight Sensitivity: Decision Boundary

> **Composite Score には連続的な相転移（Decision Boundary）が存在することを実験的に確認。**
> **Router の性質を定量的に説明できるようになった。**

## Proven

> **Composite Score の重みを変化させることで、ルーティングの決定境界が存在することを確認した。**

```
Decision Boundary:

  ΔCapability が十分大きい  → Stability は効かなくなる
  ΔCapability が小さい      → Stability が勝つ
```

## Results (2026-08-01)

| Scenario | Capability (FP16/BF16) | ΔCap | Critical w_stab | w=0.3 での選択 |
|----------|:---:|:---:|:---:|:---:|
| A: 同等 | 0.95 / 0.95 | 0.00 | 0.000 | FP16 |
| B: 小差 | 0.90 / 0.98 | 0.08 | **0.185** | FP16 ✅ |
| C: 大差 | 0.80 / 0.99 | 0.19 | **0.351** | BF16 ⚡ |

```
Scenario B:  0.3 > 0.185 → Stability 支配 → FP16
Scenario C:  0.3 < 0.351 → Capability 支配 → BF16
```

## Theoretical Framing: Lexicographic Optimization

> **Stability acts as a secondary optimization objective whose influence decreases as capability differences increase.**

```
Primary Objective   : Capability
Secondary Objective : Stability (tie-breaker)

振る舞いとして Lexicographic Optimization に近い
（実装は重み付き和だが、挙動は辞書式に近い）
```

## Phase 3 Thread Completion

```
0002C:  Capability
  ↓
0002D:  Adaptive
  ↓
0002D.1: Confidence
  ↓
0002E:  Composite Score
  ↓
0002E.1: Decision Boundary  ← 現在地
```

> ブラックボックスなルーティングではなく、重みと能力差の関係を分析可能な Router へ。

## Next

- **0002E.2**: Pareto Routing（複数軸のフロンティア）
- **0002E.3**: Adaptive Weight Learning（Router が重みを学習）

## Running

```bash
npx tsx experiments/qwen3_0.6b/EXP-0002E.1/run_sensitivity.ts
```

Full results: [`output/summary.json`](output/summary.json)

Depends on: EXP-0002E (Composite Score Routing)
