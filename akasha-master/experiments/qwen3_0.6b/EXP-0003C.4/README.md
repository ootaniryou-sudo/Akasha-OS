# EXP-0003C.4 — LinUCB (Contextual Bandit with Continuous Features)

> **0003C.3 の残差 (0.60) を「重みキャリブレーション」と特定し、LinUCB の特徴量学習で
> どこまで縮められるかを検証する。結果: 残差を解消するだけでなく Fixed を超えた。**

## Core Concept

研究全体の統一パイプライン (論文 Figure 2 相当):

```
Observation
    ↓
State Estimation
    ↓
Belief (μ, n)
    ↓
Confidence (1-exp(-n/8), EXP-0002D.1)
    ↓
Feature Vector
    ↓
LinUCB (θ^T x + α√(x^T A⁻¹ x))
    ↓
Routing
```

フィーチャベクトル (7次元 + バイアス = 8次元):

```
x = [ 1, capability, latency, cost, stability, confidence, memory, temperature ]
```

- capability  : 信念平均 μ (タスク別) — Belief から
- confidence  : 信念信頼度 — 0002D.1 から
- latency/cost: 正規化観測値
- stability   : 状態安定度
- memory/temperature: 静的属性 (設定値; 実運用で測定対象)

## Methods

| 手法 | 選択則 | フィードバック |
|------|--------|--------------|
| Fixed | 手設計 composite + Belief | フル情報 (ベースライン) |
| UCB Shadow | 平均 + √(2ln t/n) | 全アーム (0003C.3 参照) |
| LinUCB Partial | θ^T x + α√(x^T A⁻¹ x) | 選択アームのみ |
| **LinUCB Shadow** | θ^T x + α√(x^T A⁻¹ x) | **全アーム** ← 処置 |

LinUCB (Li et al. 2010, disjoint): $A_a = \lambda I + \sum x x^T$, $b_a = \sum r x$,
$\theta_a = A_a^{-1} b_a$. 探索 α=0.3, 正則化 λ=1.0。

## Results (2026-08-02)

### 実測チェックポイント

```
┌─────────┬─────────┬─────────┬───────────┬───────────┐
│ Samples │ Fixed   │ UCB-S   │ LinUCB-P  │ LinUCB-S  │
├─────────┼─────────┼─────────┼───────────┼───────────┤
│      24 │    2.10 │    1.70 │      1.70 │      1.40 │
│      60 │    3.35 │    2.95 │      2.95 │      2.35 │
│     100 │    6.05 │    6.25 │      6.25 │      5.65 │
│     120 │    6.20 │    6.40 │      6.40 │      5.80 │
└─────────┴─────────┴─────────┴───────────┴───────────┘

Gap to Fixed @120:
  ucb_shadow        : gap=+0.20
  linucb_partial    : gap=+0.20
  linucb_shadow     : gap=-0.40   ← Fixed を下回る (regret 6.5% 減)
```

### 学習された重み (LinUCB Shadow, 最終)

```
node-qwen   : [bias=0.103, capability=0.675, latency=0.052, cost=0.042, stability=0.103, confidence=0.026, memory=0.041, temperature=0.052]
node-smollm : [bias=0.140, capability=0.694, latency=-0.010, cost=0.089, stability=0.140, confidence=-0.019, memory=0.091, temperature=0.042]
node-gemma  : [bias=0.100, capability=0.799, latency=0.379, cost=0.000, stability=0.100, confidence=-0.109, memory=0.000, temperature=0.040]
```

### 冪則フィット & 限界増加率

| Method | a | b | dRegret/dN @120 |
|--------|------|------|------|
| Fixed | 0.1801 | 0.7497 | 0.0211/step |
| UCB-S | 0.0815 | 0.9206 | 0.0383/step |
| LinUCB-P | 0.0815 | 0.9206 | 0.0383/step |
| LinUCB-S | 0.0413 | 1.0434 | 0.0383/step |

## Interpretation

1. **LinUCB-Shadow は Fixed を上回る (gap = -0.40)**:
   研究プログラム全体で**初めて学習器が手設計 composite を超えた**。
   B-020 以降ほぼ全チェックポイントで Fixed 未満 (1.40<1.70, 2.35<3.35, 5.65<6.05)。

2. **学習された重みが「重みキャリブレーション」のメカニズムを実証**:
   gemma の latency 重み **0.379** は報酬の名目値 (0.10) や Fixed (0.20) を大きく上回る。
   遅延スパイク・フェーズで遅いノードをより強く回避するよう自ら学習した。
   capability 重み (0.799) も最大で「能力を最重視」する方針を獲得。

3. **0003C.3 の残差 0.60 を解消し、さらに Fixed を 0.40 下回る**:
   UCB-S (6.40) → LinUCB-S (5.80)。重み学習の価値を定量化。

4. **LinUCB-Partial = UCB-Shadow (6.40)**: 部分フィードバックでは 8 次元モデルを
   3 アーム・120 ステップで学習できず、UCB と同等に留まる。
   → **フル情報 (シャドウ) と特徴量学習の組み合わせが必須**。

5. **統一パイプラインの検証**: Observation → State → Belief → Confidence → Features →
   LinUCB → Routing が、手設計の事前知識 (Fixed) に**事前知識なしで**並ぶ・超える。

## Caveats

- 単一シード・単一環境構成。**統計的再現性の確認が必要** (次フェーズ)。
- memory / temperature は静的設定値 (測定対象は実運用)。
- 冪則の漸近指数は LinUCB-S が b=1.04 と Fixed (0.75) より大きい — 周期環境での
  長期的な漸近挙動は更なる実測が必要。

## 次 (ユーザー優先順位)

```
① 統計的検証 (multi-seed, 95%CI, Wilcoxon / 対応t検定, Cohen's d) ← 次
② ベンチマーク拡張 (Phi-3 Mini, Qwen2.5-1.5B, TinyLlama など)
③ 理論整理 (Observation → State → Belief → Weight → Routing の統一フレームワーク)
④ 論文執筆 (arXiv)
```

## Files

- `run_master.ts` — LinUCB (8次元), 4手法, 120 steps, 5刻み記録, 学習済みθ出力
- `output/summary.json` — 実測 series + learned theta
- `output/complexity_estimates.json` / `output/complexity_curve.png` — 冪則分析

## Running

```bash
# Terminal 1: Master
npx tsx experiments/qwen3_0.6b/EXP-0003C.4/run_master.ts --port 8080

# Terminal 2-4: Heterogeneous experts (EXP-0003 のノードを再利用)
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16

# 分析
python experiments/qwen3_0.6b/EXP-0003C.2/analyze_complexity.py \
  --input experiments/qwen3_0.6b/EXP-0003C.4/output/summary.json --plot
```

Depends on: EXP-0003C.3 (Shadow Feedback), EXP-0002D.1 (Confidence), EXP-0003 (Heterogeneous Experts)

