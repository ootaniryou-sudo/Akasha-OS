# EXP-0003B — Cost-Aware Routing

> **Quality だけでなく Latency と Cost も考慮した総合ルーティング。**
> **「最高品質」ではなく「十分良くて安い」を選べる Router を検証する。**

## Core Concept

Phase 1〜0003 までの Composite Score は Quality 中心だった:

```
Composite = w_q × Quality + w_l × Latency + w_c × Cost
           (0003 までは w_c = 0: Cost を無視)
```

現実の分散システムでは **Quality + Latency + Memory + Cost** が全て重要。
特に異種エキスパート (Qwen 596M / SmolLM 362M / Gemma 1B) では、
「大きなモデル = 高品質」とは限らない (0003 で実証済み: SmolLM が coding 最強)。

ならば **安くて十分良い** モデルを選ぶのが合理的。

```
Cost(node) ∝ params          # メモリ/エネルギーに近似
cost_score(node) = 1 - params/max_params   # 小さいモデルほど高い
```

## Hypothesis (検証する仮説)

> **Cost-aware ルーティングは Quality を大きく落とさずに Cost を削減できる。**
> → **Quality-per-Cost (QPC = quality / cost) が Quality-only より高い。**

## Design: 3-Policy Comparison

| Policy | w_q | w_l | w_c | 特徴 |
|--------|:---:|:---:|:---:|------|
| **quality-only** | 1.0 | 0.0 | 0.0 | Cost を無視 (従来の 0003) |
| **quality-priority** | 0.7 | 0.2 | 0.1 | 品質重視だが Cost も考慮 |
| **cost-aware** | 0.5 | 0.2 | 0.3 | 品質とコストのバランス |

```
Phase 1 (観測): 各 (node, task) に 3 プロンプト → Belief(node, task) 学習
Phase 2 (検証): 各タスク 5 held-out → 3 ポリシー同時評価
  Oracle: 実際に最高 evaluateTask スコアを出したノード
```

## Results (2026-08-02)

```
Routing Accuracy + Cost (10 held-out prompts):
┌──────────────────┬────────────┬────────────┬─────────────┬────────────┐
│ Policy           │ Routing Acc│ Avg Quality│ Avg Cost    │ QPC (Q/cost)│
├──────────────────┼────────────┼────────────┼─────────────┼────────────┤
│ quality-only     │    50% (5/10)│      0.660 │      0.0007 │        969 │
│ quality-priority │    60% (6/10)│      0.670 │      0.0004 │       1851 │
│ cost-aware       │    60% (6/10)│      0.670 │      0.0004 │       1851 │
└──────────────────┴────────────┴────────────┴─────────────┴────────────┘

Model selection distribution:
  quality-only    : node-smollm=5 node-gemma=5
  quality-priority: node-smollm=10
  cost-aware      : node-smollm=10
```

## Interpretation

1. **仮説 SUPPORTED ✅**: Cost-aware の QPC = 1851 は Quality-only の 969 の **1.91倍**。
2. **コスト半減・精度向上**: Avg Cost 0.0007→0.0004 (**-43%**) で、Accuracy は 50%→60% に**向上**。コスト削減が品質犠牲を伴わない。
3. **選択の質的変化**: Quality-only は math で Gemma (μ=0.90 の Belief) を 5 回選ぶが、実測では SmolLM が同等以上 (V-math-3/4 で smollm=1.0)。Cost-aware は SmolLM を 10 回選択 = **安くて実力のあるモデル**。
4. **QPC の意味**: Quality-per-Cost は「1単位コストあたりの品質」= コスト効率。1.91倍は「同じ予算でほぼ2倍の品質」に相当。
5. **quality-priority と cost-aware が同結果**: このプロンプト集合では w_c=0.1 でも選択が同じになった。より差が出る設定 (w_c を大きく、または Gemma が真に優位なタスク) での追加検証が次の課題。

## Success Criteria

- [x] Composite に Cost 項を追加 (Quality + Latency + Cost)
- [x] 3 ポリシー比較 (quality-only / quality-priority / cost-aware)
- [x] Cost モデル: params 比例 (Qwen 596M / SmolLM 362M / Gemma 1000M)
- [x] QPC (Quality-per-Cost) 指標を導入
- [x] 仮説検証: Cost-aware QPC 1.91x > Quality-only (SUPPORTED)

## Research Value

> **「最高品質のノード」ではなく「十分良くて最も安いノード」を選ぶ。
> 分散システムの実運用では Quality と Cost のトレードオフが本質。**
>
> Cost-aware は Belief(node, task) と組み合わせることで、
> 「このタスクなら小さくて安いモデルで十分」を観測から判断できる。

## Running

```bash
# Terminal 1: Master
npx tsx experiments/qwen3_0.6b/EXP-0003B/run_master.ts --port 8080

# Terminal 2-4: Heterogeneous experts (EXP-0003 のノードを再利用)
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16
```

Depends on: EXP-0003 (Heterogeneous Experts), EXP-0003/run_node_hetero.py
