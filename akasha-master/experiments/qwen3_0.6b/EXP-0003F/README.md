# EXP-0003F — Feature Ablation for LinUCB

> **「なぜ LinUCB-Shadow が Fixed を超えるのか」のメカニズムを、
> フィーチャを 1 つずつ除去して定量化する。査読が最も重視するメカニズムの説明。**

## Core Concept

LinUCB のフィーチャベクトルから特徴を 1 つずつ除去し、Regret への影響を測る。
「除去で Regret が増える特徴」ほど、LinUCB の優位への寄与が大きい。

```
x = [1, capability, latency, cost, stability, confidence, memory, temperature]
      └ 各特徴を 1 つ除去した 7 次元バリアント × 7 + フル
```

- 全バリアントは同一の毎ステップ評価 (オラクル/シャドウ) と同一ワークロード (シード) を共有
- LLM 出力キャッシュ (T=0 決定論) → 8 バリアント × 30 シードを一度の実行で完了
- Set A (Qwen3-0.6B/SmolLM2-360M/Gemma-3-1B), 3 タスク (coding/math/reasoning)

## Results (2026-08-02, 30 seeds × 120 steps)

### 基本統計

| Method | Mean | 95% CI | Δ vs full |
|--------|------|--------|-----------|
| fixed | 7.822 | [7.339, 8.305] | — |
| linucb_full | 7.756 | [7.282, 8.230] | baseline |
| linucb_nocap | **10.674** | [9.975, 11.373] | **+2.918 (+37.6%)** |
| linucb_nolat | 7.623 | [7.205, 8.041] | −0.132 (−1.7%) |
| linucb_nocost | 7.749 | [7.281, 8.217] | −0.007 (−0.1%) |
| linucb_nostab | 7.567 | [7.094, 8.040] | −0.189 (−2.4%) |
| linucb_noconf | 7.781 | [7.354, 8.208] | +0.025 (+0.3%) |
| linucb_nomem | 7.749 | [7.281, 8.217] | −0.007 (−0.1%) |
| linucb_notemp | 7.726 | [7.265, 8.187] | −0.030 (−0.4%) |

### アブレーション (重要度ランキング)

| Feature removed | ΔRegret | Δ% | p (vs full) | rank |
|-----------------|---------|-----|-------------|------|
| **capability** | **+2.918** | **+37.6%** | **<0.001** | **#1** |
| confidence | +0.025 | +0.3% | 0.657 | #2 |
| cost | −0.007 | −0.1% | 1.000 | #3 |
| memory | −0.007 | −0.1% | 1.000 | #4 |
| temperature | −0.030 | −0.4% | 0.528 | #5 |
| latency | −0.132 | −1.7% | 0.220 | #6 |
| stability | −0.189 | −2.4% | 0.018 | #7 |

## Interpretation

1. **capability (信念からの能力推定) が圧倒的に重要**:
   除去で Regret が **+37.6% 悪化 (p<0.001)**。LinUCB の優位は
   「観測 → 信念 → capability 特徴 → 学習重み」のパイプラインに由来する。
   つまり **Observation-Driven Routing の本質は「能力の観測推定」**。

2. **他の特徴は Set A ではほぼ無影響 (〜無害)**:
   latency/stability 除去はむしろ僅かに改善 (−1.7% / −2.4%) — この設定では
   ノイズ源か微調整に過ぎない。memory/temperature (静的属性) はバイアスで補償され無影響。

3. **Set B との整合**:
   Set B は品質分散が大きいため、capability の重要度がさらに増す
   (素朴な報酬最大化が弱いモデルに誘惑される問題を capability 重みが防ぐ)。

4. **設計への示唆**: 特徴量セットは「capability が主役、他は補助」。
   実運用では capability 推定の精度向上がルーティング性能に直結する。

## Caveats

- Set A の本設定では linucb_full (7.756) と fixed (7.822) の差は小さい
  (reasoning 追加で小型モデルの能力差が縮小した影響)。能力差が大きい Set B では
  差が明確 (p<0.001, d=−0.88)。
- ablation の「除去で改善」はノイズ/過学習の可能性も含む (報告の透明性のため記載)。

## 次

```
① 理論整理 (Observation → State → Belief → Confidence → Features → Routing) ← 次
② 論文執筆 (arXiv)
③ Neural Bandit (0003C.5)
```

## Files

- `run_master.ts` — 8 バリアント (full + 7 除去), multi-seed + cache
- `analyze_ablation.py` — ΔRegret / % / Wilcoxon / 重要度ランキング
- `output/summary.json` — 30 seeds × 8 variants
- `output/ablation.json` — アブレーション結果

## Running

```bash
# Terminal 1: Master (Set A)
npx tsx experiments/qwen3_0.6b/EXP-0003F/run_master.ts --port 8080 --seeds 30

# Terminal 2-4: Set A experts (EXP-0003 のノード)
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16

# アブレーション分析
python experiments/qwen3_0.6b/EXP-0003F/analyze_ablation.py
```

Depends on: EXP-0003C.4 (LinUCB), EXP-0003D (statistical validation)
