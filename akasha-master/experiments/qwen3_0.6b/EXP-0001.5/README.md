# EXP-0001.5 — Backend Numerical Consistency

> **「いつ、どれくらい数値的に分岐したのか」を定量化する。**

EXP-0001 で Python (PyTorch float32) と JS (ONNX fp16) の間でトークン分岐が観測された。
EXP-0001.5 では、トークン一致率ではなく **logit レベル** で比較し、分岐のメカニズムを解明する。

## Objective

```
Precision/backend
        ↓
Numerical deviation   ← ここを測る
        ↓
Top-k deviation       ← ここも測る
        ↓
Token divergence      ← EXP-0001 で観測済み
        ↓
Sequence divergence   ← EXP-0001 で観測済み
```

## Comparison Matrix

| Label | Backend | Precision | How |
|-------|---------|-----------|-----|
| **A** | PyTorch | FP32 | Python `transformers` |
| **B** | PyTorch | FP16/BF16 | Python `transformers` + `dtype=torch.float16` |
| **C** | ONNX | FP32 | `onnx-community/Qwen3-0.6B-ONNX` + dtype fp32 |
| **D** | ONNX | FP16 | `onnx-community/Qwen3-0.6B-ONNX` + dtype fp16 |
| **E** | ONNX | INT8 | ONNX quantized (if available) |
| **F** | ONNX | INT4 | ONNX quantized (if available) |

## Prompts

EXP-0000 の10問 + 追加40問 = **50問**。

追加は `prompts_extended.jsonl` に格納。

## Metrics (Per Position, Per Prompt)

Each token position *t* records:

| Metric | Description | Why |
|--------|-------------|-----|
| `top1_match` | Top-1 token same between A and D? | Direct divergence indicator |
| `top5_overlap` | How many of top-5 tokens are shared? (0–5) | "Near-miss" detection |
| `top10_overlap` | How many of top-10 tokens are shared? (0–10) | Broader distribution similarity |
| `kl_divergence` | KL(P_A ‖ P_D) at position t | Distribution shift magnitude |
| `logit_margin` | logit(top-1) − logit(top-2) | Confidence gap — when small, small noise flips the token |
| `logit_correlation` | Pearson r between logit vectors of A and D | Overall logit alignment |

### Per-Run Summary

| Metric | Description |
|--------|-------------|
| `first_divergence_pos` | Position where top-1 first differs |
| `mean_kl` | Mean KL divergence across all positions |
| `mean_top5_overlap` | Mean top-5 overlap |
| `sequence_divergence_pos` | Position after which ALL subsequent tokens differ |

## Output Format

```
EXP-0001.5/output/
├── manifest.json              # Environment + run params
├── summary.json               # Per-pair summary (A-D, A-B, C-D, ...)
├── per_position/
│   ├── A_vs_D/
│   │   ├── 0000.json          # Per-position metrics for prompt 0
│   │   └── ...
│   └── A_vs_B/
│       └── ...
└── plots/
    ├── divergence_curve.png    # Top-1 match rate vs position
    ├── kl_curve.png            # KL divergence vs position
    └── margin_histogram.png    # Logit margin distribution
```

### Per-position JSON schema

```json
{
  "prompt_index": 0,
  "pair": "A_vs_D",
  "positions": [
    {
      "pos": 0,
      "token_a": 3838,
      "token_d": 3838,
      "top1_match": true,
      "top5_overlap": 5,
      "top10_overlap": 10,
      "kl_divergence": 0.0002,
      "logit_margin_a": 12.4,
      "logit_margin_d": 11.8,
      "logit_correlation": 0.9998
    },
    {
      "pos": 8,
      "token_a": 220,
      "token_d": 489,
      "top1_match": false,
      "top5_overlap": 4,
      "top10_overlap": 7,
      "kl_divergence": 0.0031,
      "logit_margin_a": 0.12,
      "logit_margin_d": 0.09,
      "logit_correlation": 0.997
    }
  ]
}
```

## Expected Findings

仮説（実測で検証する）：

```
FP32 → FP16:  平均 divergence ~8 tokens, KL ~0.001
FP32 → INT8:  平均 divergence ~13 tokens, KL ~0.005
FP32 → INT4:  平均 divergence ~? tokens, KL ~?
FP16 → FP16:   平均 divergence ~0 tokens (identical)
```

これが実測で確認できれば、ArcAsha の Runtime 設計に直結する：

- **Exact Shadow の精度要件**: 何桁まで揃えれば同一トークンが保証されるか
- **Independent Shadow の許容範囲**: どの程度の divergence が「意味的に同等」と言えるか
- **Expert Node のバックエンド選択**: 精度と速度のトレードオフ

## Running

```bash
cd experiments/qwen3_0.6b/EXP-0001.5

# Phase 1: Python backend comparison (A vs B)
python run_logit_compare.py --pair A_vs_B --prompts ../../golden/prompts.jsonl

# Phase 2: Cross-runtime comparison (A vs D)
python run_logit_compare.py --pair A_vs_D --prompts ../../golden/prompts.jsonl

# Phase 3: ONNX internal comparison (C vs D)
python run_logit_compare.py --pair C_vs_D --prompts ../../golden/prompts.jsonl

# All pairs
python run_all_pairs.py
```

## Relation to Other Experiments

```
EXP-0000: Golden Reference (PyTorch FP32)
    ↓
EXP-0001: Python vs JS/ONNX token comparison
    ↓
EXP-0001.5: Logit-level precision analysis  ← this
    ↓
EXP-0002: Multi-node with standardized runtime
```

## Research Value

この実験から得られるデータは：

1. **ArcAsha Runtime 設計の基礎データ** — どのバックエンド・精度の組み合わせが同一トークンを保証するか
2. **Shadow 戦略の定量根拠** — Exact Shadow の要件、Independent Shadow の許容範囲
3. **論文レベルの分析材料** — 「分散推論における数値精度の影響」は未開拓領域

