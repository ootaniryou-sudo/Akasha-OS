# EXP-0003D — Statistical Validation (multi-seed)

> **0003C.4 の「LinUCB-Shadow が Fixed を上回る (gap=-0.40)」が偶然でないことを、
> 30 シード + 対応あり Wilcoxon 検定 + 効果量で統計的に検証する。**

## Core Concept

本実験の LLM 生成は温度 0 で決定論的、UCB/LinUCB の選択も決定論的なため、
「シード」は**ワークロードの乱数化**として導入する:

```
seed = {
  (a) タスク順序 (coding/math を 0.5/0.5 でランダム)
  (b) プロンプト選択 (プールからランダム)
  (c) 初期アーム順 (タイブレークを乱数化)
}
```

LLM 出力キャッシュ (決定論的生成のため 48 ペア = 3 ノード × 16 プロンプト を一度だけ推論):
→ 30 シードを数分で実行可能。ばらつきはワークロード系列の違いに由来する。

## Results (2026-08-02, 30 seeds × 120 steps)

### 基本統計

| Method | Mean | Std | 95% CI |
|--------|------|------|--------|
| Fixed | 6.230 | 1.632 | [5.621, 6.839] |
| UCB-P | 15.860 | 1.716 | [15.219, 16.501] |
| UCB-S | 6.395 | 1.233 | [5.935, 6.855] |
| LinUCB-P | 6.157 | 1.288 | [5.676, 6.638] |
| **LinUCB-S** | **5.534** | **0.995** | **[5.162, 5.906]** |

### 対応あり検定 (vs Fixed, Wilcoxon signed-rank)

| Pair | mean diff | p | Cohen's d | Cliff's δ |
|------|-----------|------|------|------|
| UCB-P − Fixed | +9.63 | **<0.001** | +4.86 | +1.00 |
| UCB-S − Fixed | +0.17 | 0.411 | +0.13 | +0.08 |
| LinUCB-P − Fixed | −0.07 | 0.877 | −0.06 | −0.02 |
| **LinUCB-S − Fixed** | **−0.70** | **0.020** | **−0.49** | **−0.28** |

### 特徴量学習の効果 (LinUCB-S vs UCB-S)

| Pair | mean diff | p | Cohen's d | Cliff's δ |
|------|-----------|------|------|------|
| LinUCB-S − UCB-S | −0.86 | **<0.001** | **−1.10** | −0.40 |

## Interpretation

1. **LinUCB-Shadow は Fixed より統計的に有意に良い**:
   p=0.020, d=−0.49 (中程度の効果量), Cliff's δ=−0.28。
   30 シードで平均 regret が 11% 低い (5.53 vs 6.23)。

2. **サンプル数の重要性 (ユーザーの予測を実証)**:
   10 シードでは p=0.77 (非有意) → 30 シードで p=0.020 (有意)。
   「0.4 差は偶然かもしれない」という懸念は正しく、検出力の不足だった。
   → 論文では「多シードで効果を確認する」ことの価値を明示できる。

3. **因果関係の三段階が統計的に確立**:
   ```
   Partial Feedback  : 有意に悪い (p<0.001, d=+4.9)
   Shadow (Full Info) : Fixed と同等 (p=0.41, パリティ) — 0003C.3 の「追いつく」
   Shadow + Features  : 有意に良い (p=0.020) — 0003C.4 の「超える」
   ```
   0003C.2→C.3→C.4 のストーリーが「観測事実」として検証された。

4. **LinUCB-P は Fixed と同等 (p=0.88)**: 部分フィードバックでは特徴量学習の
   利点が発揮されない (8 次元モデルを 3 アームから学習不能)。→ フル情報が前提。

5. **LinUCB-S vs UCB-S は p<0.001, d=−1.10 (大効果)**:
   「特徴量学習の付加価値」が最も強い統計的シグナル。

## Caveats

- シード = ワークロード乱数化 (タスク順・プロンプト・初期順)。モデル出力の
  確率的揺らぎ (T>0) は含まない (別の検証課題)。
- 単一モデルセット (Qwen/SmolLM/Gemma)。異なるモデルでの再現性は次の課題。
- 環境は 2 環境サイクル (baseline/latency/capjump)。

## 次 (ユーザー優先順位)

```
① ベンチマーク拡張 (Phi-3 Mini, Qwen2.5-1.5B, TinyLlama 追加) ← 次
② 理論整理 (Observation → State → Belief → Weight → Routing の統一フレームワーク)
③ 論文執筆 (arXiv)
```

## Files

- `run_master.ts` — multi-seed (ワークロード乱数化 + LLM 出力キャッシュ), --seeds N
- `analyze_statistics.py` — mean/std/95%CI, Wilcoxon, Cohen's d, Cliff's delta
- `output/summary.json` — シード毎の累積 Regret
- `output/statistics.json` — 統計結果

## Running

```bash
# Terminal 1: Master (30 seeds)
npx tsx experiments/qwen3_0.6b/EXP-0003D/run_master.ts --port 8080 --seeds 30

# Terminal 2-4: Heterogeneous experts (EXP-0003 のノードを再利用)
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16

# 統計分析
python experiments/qwen3_0.6b/EXP-0003D/analyze_statistics.py
```

Depends on: EXP-0003C.4 (LinUCB), EXP-0003C.3 (Shadow), EXP-0003C.2 (Sample Complexity)
