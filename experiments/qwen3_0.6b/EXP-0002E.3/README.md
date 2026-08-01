# EXP-0002E.3 — Adaptive Weight Learning

> **Router 自身が Composite Score の重みを経験から学習する。**
> **「手作業で調整するルーター」から「自ら方針を更新するルーター」へ。**
> **重み学習は Pareto 集合の中だけで行う（0002E.2 の成果を活用）。**

## Objective

0002E では w_stab=0.3 が固定だった。
0002E.3 では、各タスクの結果フィードバックから重みをオンライン学習する。

```
w_stab = 0.30 (初期値)
    ↓
Online Learning (タスク結果から)
    ↓
0.27 → 0.31 → 0.29 → ... (適応)
```

## Pareto-Integrated Learning (0002E.2 の成果)

```
以前:   Weight → Composite → Decision（全ノード対象）
現在:   Pareto Filter → Weight → Composite → Decision（フロンティア内のみ）

  All Nodes
      ↓
  Pareto Frontier (0002E.2)
      ↓
  Adaptive Weight (0002E.3)
      ↓
  Composite Score
      ↓
  Best Node
```

> **重み学習は Pareto 集合の中だけで行う。**
> 完全支配ノード（node-h 型）を学習対象から除外できる。

## Learning Signal

```
各タスク後:
  - 選択されたノードの実測品質 (evaluator score)
  - 代替ノードの推定品質（もし選ばれていたら）
  - 重みを高品質な選択が増える方向に調整
```

### Simple Approach: Reward-Based Update

```
reward = 1 if chosen node performed well, else 0

w_stab += η × (stability_contribution × (reward − baseline))
```

### Advanced: Bandit / Policy Gradient

```
Router を多腕バンディットとして定式化
  - 各 weight 設定 = アーム
  - タスク結果 = 報酬
  - UCB / Thompson Sampling で探索・活用
```

## Success Criteria

- [ ] Weights initialized from 0002E (w_stab=0.3)
- [ ] Online update after each task
- [ ] Weights converge to stable values
- [ ] Converged weights improve routing quality vs fixed weights
- [ ] Exploration vs exploitation balance (ε-greedy / UCB)

## Comparison Metrics

| Metric | Fixed (0002E) | Adaptive (0002E.3) |
|--------|:---:|:---:|
| Routing quality (avg task score) | baseline | ? |
| Weight stability (variance) | 0 | ? |
| Adaptation to node drift | none | ? |

## Running

```bash
npx tsx experiments/qwen3_0.6b/EXP-0002E.3/run_master.ts --port 8080 --learn-weights
```

Depends on: EXP-0002E (Composite Score), EXP-0002D.1 (Evaluator)
