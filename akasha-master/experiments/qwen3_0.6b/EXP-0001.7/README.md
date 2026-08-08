# EXP-0001.7 — Precision Ladder

> **全精度レベル × 全バックエンドの系統的比較。ArcAsha が「この Node は FP16 だが今のタスクでは安全」と判断できる基盤データ。**

## Objective

```
Parameter precision (FP32 / BF16 / FP16 / INT8 / INT4)
  ×
Backend (PyTorch / ONNX)
  ×
Kernel (matmul implementation)
  ×
logit_margin
  ×
divergence
```

この5次元の関係を定量化する。

## Precision Ladder Matrix

| # | Label | Backend | Precision | How |
|---|-------|---------|-----------|-----|
| A | `pt_fp32` | PyTorch | FP32 | Baseline (EXP-0000 golden) |
| B | `pt_bf16` | PyTorch | BF16 | `dtype=torch.bfloat16` |
| C | `pt_fp16` | PyTorch | FP16 | `dtype=torch.float16` |
| D | `onnx_fp32` | ONNX | FP32 | `onnx-community/Qwen3-0.6B-ONNX` + dtype fp32 |
| E | `onnx_fp16` | ONNX | FP16 | `onnx-community/Qwen3-0.6B-ONNX` + dtype fp16 |
| F | `onnx_int8` | ONNX | INT8 | Dynamic quantization (if supported) |
| G | `onnx_int4` | ONNX | INT4 | `dtype: "q4f16"` (if supported) |

## Comparison Pairs

全ペアではなく、Baseline (A) 対 各バックエンドの比較を優先：

### Primary (Baseline vs Each)
```
A vs B  (FP32 vs BF16)     ← PyTorch internal
A vs C  (FP32 vs FP16)     ← PyTorch internal ✅ done in 0001.5
A vs D  (FP32 vs ONNX FP32) ← Cross-runtime, same precision
A vs E  (FP32 vs ONNX FP16) ← Cross-runtime, different precision
A vs F  (FP32 vs ONNX INT8) ← Extreme quantization
A vs G  (FP32 vs ONNX INT4) ← Extreme quantization
```

### Secondary (Within ONNX)
```
D vs E  (ONNX FP32 vs ONNX FP16)
D vs F  (ONNX FP32 vs ONNX INT8)
```

## Metrics (Same as EXP-0001.5, Extended)

Per position:
- `top1_match`, `top5_overlap`, `top10_overlap`
- `kl_divergence`, `logit_correlation`
- `logit_margin` (both sides)
- **NEW**: `token_embedding_distance` — cosine similarity between token embeddings of top-1 choices
- **NEW**: `semantic_divergence` — whether the continuation changes topic/meaning

Per pair summary:
- `first_divergence_mean`, `first_divergence_median`
- `top1_match_rate`
- `mean_kl`, `mean_top5_overlap`
- `mean_logit_correlation`
- **NEW**: `precision_efficiency_ratio` — (speed_B / speed_A) / (quality_B / quality_A)

## Output

```
EXP-0001.7/output/
├── manifest.json
├── precision_ladder.json    # Summary across all pairs
├── A_vs_B/
│   ├── summary.json
│   └── per_position/
├── A_vs_D/
│   └── ...
└── RESULTS.md
```

### Precision Ladder Summary

```json
{
  "baseline": "pt_fp32",
  "num_prompts": 50,
  "ladder": [
    {
      "pair": "A_vs_C",
      "label": "FP32 vs FP16 (PyTorch)",
      "top1_match_rate": 0.9375,
      "mean_first_divergence": 12.0,
      "mean_top5_overlap": 4.7,
      "mean_kl": 0.632,
      "mean_logit_correlation": 0.9731,
      "relative_speed": 0.78,
      "precision_efficiency_ratio": 1.21
    }
  ]
}
```

## Expected Findings (Hypothesis)

```
Same Runtime (PyTorch):
  FP32 ─── BF16:  divergence ~0 tokens   (BF16 ~= FP32 for inference)
  FP32 ─── FP16:  divergence ~12 tokens  (measured in 0001.5)
  
Cross Runtime:
  FP32 ─── ONNX FP32: divergence ~8 tokens  (same precision, different kernel)
  FP32 ─── ONNX FP16: divergence ~5 tokens  (already diverged by kernel)
  
Extreme Quantization:
  FP32 ─── ONNX INT8: divergence ~15 tokens
  FP32 ─── ONNX INT4: divergence ~? tokens  (TBD)
```

## ArcAsha Integration

このデータがあれば、ArcAsha Router は各 Node のバックエンド・精度に基づいて
**Numerical Reliability Score** を計算できる：

```
Node A: PyTorch FP16 → reliability = 0.9375  (top-1 match rate vs baseline)
Node B: ONNX INT8    → reliability = 0.72     (estimated)
Node C: PyTorch FP32 → reliability = 1.000    (baseline)

Routing decision:
  Critical task   → Node C (FP32, highest reliability)
  Throughput task → Node A (FP16, 0.78× faster, 0.9375 reliability)
  Energy task     → Node B (INT8, fastest, acceptable reliability)
```

## Running

```bash
cd experiments/qwen3_0.6b/EXP-0001.7

# All pairs
python run_precision_ladder.py --all --prompts prompts_50.jsonl

# Single pair
python run_precision_ladder.py --pair A_vs_D --prompts ../golden/prompts.jsonl
```

