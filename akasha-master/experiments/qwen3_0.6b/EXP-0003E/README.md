# EXP-0003E — Benchmark Expansion (Model Generalization)

> **0003D で確立した「LinUCB-Shadow > Fixed」がモデル・タスクに依存しないことを、
> 完全に異なるモデルセット (Set B) + 追加タスク (reasoning) で検証する。**

## Core Concept

```
Set A (0003D, 検証済み): Qwen3-0.6B / SmolLM2-360M / Gemma-3-1B  (coding/math)
Set B (本実験)        : Qwen2.5-Coder-0.5B / SmolLM2-135M / Llama-3.2-1B (coding/math/reasoning)
```

- **モデル非依存化**: パラメータ数は model_id から解析 (既知モデルは上書き)。
- **フェーズ注入の動的解決**: latency スパイク=最小モデル, capability 低下=最大モデル
  (環境設計を全セットで統一)。
- **タスク拡張**: reasoning (論理・数列・パズル) を追加。評価は構造信号 + 拒否ペナルティ。
- **EstimatedCost**: cost は params 比例の**推定指標 (proxy)**。実測コストではないことを明示。

## Results (2026-08-02, Set B, 30 seeds × 120 steps)

### 基本統計

| Method | Mean | Std | 95% CI |
|--------|------|------|--------|
| Fixed | 13.277 | 2.224 | [12.446, 14.107] |
| UCB-P | 19.858 | 2.200 | [19.036, 20.679] |
| UCB-S | 17.803 | 2.249 | [16.963, 18.643] |
| LinUCB-P | 17.377 | 2.324 | [16.509, 18.244] |
| **LinUCB-S** | **11.686** | **2.132** | **[10.890, 12.482]** |

### 対応あり検定 (vs Fixed)

| Pair | mean diff | p | Cohen's d | Cliff's δ |
|------|-----------|------|------|------|
| UCB-P − Fixed | +6.58 | **<0.001** | +2.10 | +0.95 |
| UCB-S − Fixed | +4.53 | **<0.001** | +1.28 | +0.83 |
| LinUCB-P − Fixed | +4.10 | **<0.001** | +1.24 | +0.79 |
| **LinUCB-S − Fixed** | **−1.59** | **<0.001** | **−0.88** | **−0.43** |

### 特徴量学習の効果 (LinUCB-S vs UCB-S)

| Pair | mean diff | p | Cohen's d | Cliff's δ |
|------|-----------|------|------|------|
| LinUCB-S − UCB-S | −6.12 | **<0.001** | **−2.16** | −0.94 |

## Interpretation

1. **LinUCB-Shadow > Fixed がモデル・タスクを跨いで再現**:
   Set A (p=0.020, d=−0.49) → Set B (p<0.001, d=−0.88)。**効果量は増大**。
   完全に異なるモデルファミリー (Qwen2.5 / SmolLM2 / Llama-3.2) とタスク
   (coding/math/reasoning) でも、学習されたルーティングが手設計 composite を上回る。

2. **新発見 — Set B では素朴な報酬最大化が危険**:
   UCB-S は Set A で Fixed と同等だったが、**Set B では有意に悪い** (p<0.001, d=+1.28)。
   原因: Set B は品質分散が大きく (SmolLM2-135M は安く・速いが弱い)、報酬の
   cost/latency 項 (各 0.10) が「安くて速いが弱い」モデルへ誘導する。
   → 品質重み 0.60 の Fixed の方が素朴な報酬最大化より堅牢。

3. **LinUCB は Set B でも補正を学習**:
   学習された特徴重みが capability を強く重み付けし、弱いが安いモデルを回避。
   その結果 UCB-S より 6.12 低い (d=−2.16, 巨大効果)。
   → **特徴量学習は「贅沢」ではなく「異質環境で必要」**。これは論文の強い主張になる。

4. **三段階の因果連鎖は Set B でも成立** (Set A と逆転はしない):
   UCB-S は Set B では Fixed 未満だが、LinUCB-S はその上を行く。
   「シャドウ + 特徴量学習」が一貫して最良。

## Set A vs Set B (一般化サマリ)

| 指標 | Set A (0003D) | Set B (0003E) |
|------|------|------|
| モデル | Qwen3-0.6B/SmolLM2-360M/Gemma-3-1B | Qwen2.5-Coder-0.5B/SmolLM2-135M/Llama-3.2-1B |
| タスク | coding/math | coding/math/**reasoning** |
| LinUCB-S vs Fixed | p=0.020, d=−0.49 | **p<0.001, d=−0.88** |
| LinUCB-S vs UCB-S | p<0.001, d=−1.10 | **p<0.001, d=−2.16** |
| UCB-S vs Fixed | 同等 (p=0.41) | 有意に悪い (p<0.001) |
| 結論 | LinUCB-S が有意に良い | **一般化 + 効果量増大** |

## Caveats

- Set B は小型モデル中心 (135M〜1.2B)。大規模モデルでの再現は今後の課題。
- cost は EstimatedCost (params 比例 proxy)。実測コスト (電力等) は対象外。
- 評価はルールベース (構造信号)。アノテーション評価との併用は今後の課題。

## 次

```
① 理論整理 (Observation → State → Belief → Weight → Routing の統一フレームワーク) ← 次
② 論文執筆 (arXiv)
③ Neural Bandit (0003C.5)
```

## Files

- `run_master.ts` — モデル非依存 + 3タスク + 動的フェーズ注入, multi-seed + cache
- `prompts.jsonl` (+8 reasoning) — タスク拡張
- `output/summary.json` — 30 seeds (Set B)
- 分析: `EXP-0003D/analyze_statistics.py --input EXP-0003E/output/summary.json`

## Running

```bash
# Terminal 1: Master (Set B)
npx tsx experiments/qwen3_0.6b/EXP-0003E/run_master.ts --port 8080 --seeds 30

# Terminal 2-4: Set B experts
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen2coder --model Qwen/Qwen2.5-Coder-0.5B --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-smol135 --model HuggingFaceTB/SmolLM2-135M-Instruct --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-llama --model unsloth/Llama-3.2-1B-Instruct --precision fp16

# 統計分析
python experiments/qwen3_0.6b/EXP-0003D/analyze_statistics.py \
  --input experiments/qwen3_0.6b/EXP-0003E/output/summary.json
```

Depends on: EXP-0003D (statistical validation), EXP-0003C.4 (LinUCB)

