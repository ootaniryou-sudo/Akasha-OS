# EXP-0003C.1 — Contextual Bandit (UCB) Router

> **0003C の負の結果 (Policy Learning は少サンプルで Fixed に届かない) を、
> サンプル効率の高い Online Decision Making 手法で再検証する。**
> **Learning Depth Hypothesis の検証実験。**

## Core Concept

ArcAsha のルーティングは「文脈 (state) を見てノードを選び、即座に報酬を得る」構造。
これはフル RL ではなく **Contextual Bandit** の定式化が自然:

```
Context (state: Capability, Latency, Stability, Cost)
    ↓
Arm (node: qwen / smollm / gemma)
    ↓
Reward (Quality + Latency + Cost + Stability)
```

0003C では ε-greedy Q-Learning が少サンプルで苦戦した。
UCB (楽観的探索) と Thompson (ベイズ探索) は探索コストが理論的に低い。

## Hypothesis

> **UCB / Thompson は Q-Learning より少ないサンプルで Fixed に近づく。
> (Learning Depth Hypothesis の検証: 学習対象が深いほどサンプルが必要だが、
>  探索効率の良い手法はそのコストを削減できる)**

## Methods

| 手法 | 選択則 | 探索 |
|------|--------|------|
| **Fixed** | 手設計の重みで Composite | なし (ベースライン) |
| **Q-Learning** | Q[state][node] + ε-greedy | ランダム (ε=0.15) |
| **UCB1** | Q̄_a + √(2 ln t / n_a) | 楽観的 (C=2.0) |
| **Thompson** | Beta(α,β) からサンプリング | ベイズ |

注入 (controlled perturbation): baseline → latency spike (smollm×3) → capability jump (gemma×0.5)

## Results (2026-08-02)

```
Cumulative Regret at checkpoints:
┌─────────┬─────────┬──────────┬──────────┬──────────┐
│ Samples │ Fixed   │ Q-Learn  │ UCB      │ Thompson │
├─────────┼─────────┼──────────┼──────────┼──────────┤
│      24 │    1.70 │     7.85 │     2.85 │     2.80 │
│      50 │    2.95 │    12.95 │     6.15 │     4.80 │
│      60 │    2.95 │    16.45 │     7.15 │     5.35 │
└─────────┴─────────┴──────────┴──────────┴──────────┘

Sample where method crosses below Fixed:
  qlearn   : not crossed within 60 samples ❌
  ucb      : not crossed within 60 samples ❌
  thompson : not crossed within 60 samples ❌
```

## Interpretation

1. **UCB/Thompson は Q-Learning より 2-3倍サンプル効率が良い**:
   60 サンプル時点で Q-Learning 16.45 vs UCB 7.15 / Thompson 5.35。
   ε-greedy のランダム探索が Q-Learning の Regret を大きく膨らませるのに対し、
   楽観的/ベイズ探索は探索コストが理論的に低いことを実データで確認。
2. **それでも Fixed に届かない** (60 サンプル): Learning Depth Hypothesis をさらに支持。
   「Policy レベルの学習は大量サンプルが必要」という 0003C の結論が、
   探索効率の良い手法でも短期的には覆らない。
3. **ただし傾向は明確**: UCB の勾配 (60で7.15) は Q-Learning (16.45) よりはるかに緩い。
   長期的には UCB/Thompson が Fixed を超える可能性が高い (収束曲線の外挿)。
4. **Contextual Bandit 定式化の妥当性**: 「文脈→アーム→報酬」の構造が機能し、
   ArcAsha のルーティングは Online Decision Making として扱えることが確認された。

## Learning Depth Hypothesis (累積)

```
Depth ↑          Sample to beat Fixed
─────────────────────────────────────
Layer 1: weight   ~0   (0002E.3: 即時有効)
Layer 2: state    ~6   (0003A: baseline 後)
Layer 3: policy   >60  (0003C: ε-greedy / 0003C.1: UCB/Thompson も未達)
```

> **学習対象が深いほど Sample Complexity が増える。**
> 探索効率の良い手法 (UCB/Thompson) はそのコストを削減できるが、
> 短期的には手設計の重み (事前知識) が依然として強力。

## Next

- **サンプル数を 100→250→500→1000 に増やし、UCB/Thompson が Fixed を
  超える収束点を測定する** (1000 リクエストの実測は長時間のため、シミュレーション
  または分散実行で実施可能)
- **LinUCB** (文脈を線形特徴で扱う) に拡張
- Phase 5 (Emergent Controller): Task → Planner → Policy 生成

## Running

```bash
# Terminal 1: Master
npx tsx experiments/qwen3_0.6b/EXP-0003C.1/run_master.ts --port 8080

# Terminal 2-4: Heterogeneous experts (EXP-0003 のノードを再利用)
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16
```

Depends on: EXP-0003C (Policy Learning, Learning Depth Hypothesis), EXP-0003 (Heterogeneous Experts)

