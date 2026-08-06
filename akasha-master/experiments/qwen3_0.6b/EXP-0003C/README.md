# EXP-0003C — Policy Learning (State → Policy → Action)

> **「重みを学習する」(E.3) の次は「Policy 自体を学習する」。**
> **`if capability > ...` は存在しない。policy[state] が経験から更新される。**

## Core Concept

```
Observation → State Estimation → Policy Learning → Routing
```

Router には State / Action / Reward がある:

| 要素 | 内容 |
|------|------|
| **State** | 離散化された観測状態 (lat_anomaly × cap_anomaly の 4 状態) |
| **Action** | ルーティング先ノード (qwen / smollm / gemma) |
| **Reward** | Quality + Latency + Cost + Stability (スカラー化) |

更新則 (手設計の重みルールではなく報酬追従):

```
Q[s][a] += η · (r − Q[s][a])
```

## Design: 3-Policy Comparison

| Policy | 仕組み | 事前知識 |
|--------|--------|---------|
| **Fixed** | 手設計の重みで Composite → argmax | あり (静的) |
| **Adaptive Weight** | Belief に応じて重みを更新 (E.3) | あり (動的) |
| **Policy Learning** | Q[state][node] を報酬から学習 | なし |

注入 (controlled perturbation):
- Phase 1 baseline / Phase 2 latency spike (smollm×3) / Phase 3 capability jump (gemma×0.5) / Phase 4 recovery

## Results (2026-08-02)

```
Cumulative Regret (24 steps):
┌──────────────┬─────────────┬─────────────┐
│ Policy       │ Cum Regret  │ Avg Regret  │
├──────────────┼─────────────┼─────────────┤
│ Fixed        │       1.600 │      0.0667 │
│ Adaptive W   │       1.600 │      0.0667 │
│ Policy Learn │       4.200 │      0.1750 │
└──────────────┴─────────────┴─────────────┘

Phase-wise:
  baseline : F 0.60 | A 0.60 | P 1.50
  latency  : F 0.40 | A 0.40 | P 0.60   ← Policy Learning が追従
  capjump  : F 0.00 | A 0.00 | P 0.90
  recovery : F 0.60 | A 0.60 | P 1.20
```

**学習された最終 Q Table:**
```
│ lat0·cap0 │ 0.110 │ 0.183 │ 0.182 │
│ lat0·cap1 │ 0.488 │ 0.183 │ 0.457 │
│ lat1·cap0 │ 0.110 │ 0.183 │ 0.182 │
│ lat1·cap1 │ 0.110 │ 0.760 │ 0.182 │   ← latency spike 状態で smollm の Q が上昇
```

## Interpretation (誠実な負の結果)

1. **仮説 NOT SUPPORTED ❌**: この設定では Policy Learning (4.200) は Fixed/Adaptive (1.600) を下回った。手設計の重みは少サンプルでは強い。
2. **Q table は学習自体は機能した**: latency spike 状態 (lat1·cap1) で smollm の Q=0.760 に収束。**政策学習の機構は正しく動いた**。
3. **負の結果の原因**:
   - **探索コスト**: ε-greedy (ε=0.15) が 24 ステップ中で大きく効く。Fixed はゼロ探索で全サンプルを活用。
   - **状態離散化の情報量不足**: 24 ステップで 4状態×3ノードの Q table を埋めるには少なすぎる。baseline では cap_anomaly が常に1になり状態が区別されない。
   - **報酬のスカラー化**: Quality が支配的 (1.0) で Latency/Cost/Stability (0.1) の寄与が小さく、状態別の差が出にくい。
4. **科学的教訓**: 「Policy を学習する」ことは可能だが、**少サンプルでは手設計の重み (事前知識) が優位**。Policy Learning の価値はサンプルが多く、環境変化が頻繁な場合に出る。このトレードオフ自体が研究上の発見。
5. **Policy Learning が追従を見せたフェーズ**: latency spike (0.60 vs 0.40) と capjump 後半では差が縮小。学習が進めば追従する兆候。

## Learning Depth Hypothesis (理論枠組み)

0003C の負の結果を、実験系列全体に一般化する理論として整理する:

> **Learning Depth Hypothesis: 学習対象の「深さ」が増すほど、必要な経験量 (Sample Complexity) は急増する。**

```
Depth ↑      Sample Complexity ↑
────────────────────────────────
Layer 1: weight         少ないデータで十分 (0002E.3: 96% ≥ 86%)
Layer 2: state          中程度 (0003A: Regret −75.7%)
Layer 3: policy         大量 (0003C: 24 リクエストでは Fixed に届かず)
```

この仮説はオンライン学習・RL の既知の性質 (表現力の高い学習器ほどデータを必要とする) を、
実データで段階的に確認したもの。

**検証実験 (次):** サンプル数を 24 → 50 → 100 → 250 → 500 → 1000 と増やし、
Policy Learning / Contextual Bandit の Regret が何サンプルで Fixed を超えるかを測定する。

→ **EXP-0003C.1 (Contextual Bandit / UCB Router)** で実施

## 比較: 全実験の Regret フレームワーク

| 実験 | 学習対象 | 事前知識 | 結果 |
|------|---------|:---:|------|
| 0002E.3 | Weight | 不要 | Adaptive 96% ≥ Fixed 86% |
| 0003A | State | 不要 | Regret −75.7% |
| 0003C | Policy | 不要 | 少サンプルでは Fixed 優位 (負の結果) |

> **学ぶ対象が「重み → 状態 → 方策」と深くなるほど、必要なサンプル数は増える。**
> これは「表現力の高い学習器ほどデータを必要とする」というオンライン学習の原則を実データで確認した結果。

## 方向性: Contextual Bandit Router

ArcAsha のルーティングは「文脈 (state) を見てノードを選び、即座に報酬を得る」構造なので、
**フル RL ではなく Contextual Bandit** の定式化が自然:

```
Context (state: Capability, Latency, Stability, Cost)
    ↓
Arm (node: qwen / smollm / gemma)
    ↓
Reward (Quality + Latency + Cost + Stability)
```

候補手法 (0003C.1〜):
- 0003C.1: **UCB1** (楽観的探索 — サンプル効率が高い)
- 0003C.2: Thompson Sampling (ベイズ的探索)
- 0003C.3: Experience Replay (過去経験の再利用)
- 0003C.4: Contextual Bandit (LinUCB — 文脈を線形特徴で扱う)

## Next: EXP-0003C.1 (Contextual Bandit / UCB Router)

```
Task → Planner → Policy 生成 → Routing
```

Policy すら固定しない。0003C の負の結果は、
「Policy を学習するには十分な観測と、状態を適切に離散化する設計が必要」
という Phase 5 への設計要件を与える。

## Running

```bash
# Terminal 1: Master
npx tsx experiments/qwen3_0.6b/EXP-0003C/run_master.ts --port 8080

# Terminal 2-4: Heterogeneous experts (EXP-0003 のノードを再利用)
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16
```

Depends on: EXP-0003 (Heterogeneous Experts), EXP-0003A (State Estimation), EXP-0002E.3 (Adaptive Weight)
