# EXP-0001.6 — Divergence Prediction & Shadow Policy

> **「logit margin だけで、数 step 先の cross-runtime divergence を予測できるか？」**

EXP-0001.5 で発見された「logit_margin < 0.02 が分岐を引き起こす」というパターンを、
100〜1000 プロンプトで統計的に検証する。

## Objective

```
For each generation step:
  logit_margin (t)
       ↓
  Does future token divergence occur? (t+1, t+2, ..., t+k)
       ↓
  Statistical relationship: margin → divergence probability
       ↓
  Optimal margin threshold for Shadow policy
```

## Research Questions

1. **Q1**: What logit_margin threshold best predicts *immediate* (t+1) divergence?
2. **Q2**: What threshold predicts divergence within *k* steps (k=1, 3, 5, 10)?
3. **Q3**: Is the relationship backend-dependent (FP32→FP16 vs FP32→ONNX)?
4. **Q4**: Can we derive an *actionable* threshold for ArcAsha's Shadow policy?

## Design

### Comparison Pairs

| Pair | Backend A | Backend B | Type |
|------|-----------|-----------|------|
| `fp32_vs_fp16` | PyTorch FP32 | PyTorch FP16 | Same runtime, different precision |
| `fp32_vs_onnx_fp16` | PyTorch FP32 | ONNX FP16 | Different runtime |

### Prompts

- Phase 1: 100 prompts (mixed EN/JP, math/code/general)
- Phase 2: 1000 prompts (statistical significance)

### Per-Step Recording

For each generation step *t* in backend A:

```json
{
  "pos": 8,
  "token_id_a": 220,
  "token_id_b": 489,
  "top1_match": false,
  "logit_margin_a": 0.018,
  "logit_margin_b": 0.002,
  "top5_overlap": 4,
  "kl_divergence": 0.000038,
  "logit_correlation": 0.9998,
  "backend_a": "pytorch_fp32",
  "backend_b": "pytorch_fp16",
  "diverged_at_t_plus_1": false,
  "diverged_at_t_plus_3": false,
  "diverged_at_t_plus_5": false,
  "diverged_at_t_plus_10": true
}
```

### Analysis Metrics

| Metric | Formula | Interpretation |
|--------|---------|----------------|
| Precision@k | TP / (TP + FP) at threshold | How many flagged positions actually diverge |
| Recall@k | TP / (TP + FN) at threshold | How many divergences did we catch |
| F1@k | Harmonic mean of P and R | Overall threshold quality |
| ROC AUC | Area under ROC curve | Discriminative power of margin |
| Optimal threshold | argmax F1 | Best margin for policy |

## Output

```
EXP-0001.6/output/
├── manifest.json
├── predictions.jsonl        # All per-step records (streaming JSONL)
├── fp32_vs_fp16/
│   ├── summary.json         # Aggregate stats
│   ├── roc_curve.json       # ROC data points
│   ├── threshold_analysis.json  # Precision/Recall/F1 per threshold
│   └── divergence_lag.json  # Divergence probability vs steps-ahead
├── fp32_vs_onnx_fp16/
│   └── (same structure)
└── RESULTS.md
```

### Threshold Analysis Output

```json
{
  "pair": "fp32_vs_fp16",
  "total_positions": 32000,
  "divergent_positions": 640,
  "thresholds": [
    {
      "margin_threshold": 0.001,
      "precision_immediate": 0.85,
      "recall_immediate": 0.42,
      "f1_immediate": 0.56,
      "precision_k5": 0.92,
      "recall_k5": 0.78,
      "f1_k5": 0.84
    }
  ],
  "best_threshold": {
    "margin": 0.015,
    "f1_immediate": 0.72,
    "f1_k5": 0.91
  },
  "roc_auc": 0.94
}
```

## Success Criteria

- [ ] ROC AUC > 0.75 (margin is a meaningful predictor)
- [ ] Optimal threshold identified with F1 > 0.7
- [ ] Threshold generalizes across prompt types (EN/JP, math/code)
- [ ] Backend-dependent threshold comparison (FP16 vs ONNX)

## ArcAsha Integration Target

If successful, the `logit_margin` threshold feeds into:

```
ArcAsha Router
  └── Numerical Stability Score
        └── Per-node, per-backend divergence risk
              └── Shadow policy:
                    margin > threshold  → Exact Shadow (safe)
                    margin ≤ threshold  → Independent Shadow (verify)
```

## Running

```bash
cd experiments/qwen3_0.6b/EXP-0001.6

# Phase 1: 100 prompts
python run_divergence_predict.py \
  --pair fp32_vs_fp16 \
  --prompts prompts_100.jsonl \
  --max-tokens 32

# Phase 2: 1000 prompts
python run_divergence_predict.py \
  --pair fp32_vs_fp16 \
  --prompts prompts_1000.jsonl \
  --max-tokens 32 \
  --output output_1k/
```

## Relation to Other Experiments

```
EXP-0000:    Golden Reference (PyTorch FP32)
EXP-0001:    Python vs JS/ONNX token comparison
EXP-0001.5:  Logit-level precision analysis (divergence mechanism)
EXP-0001.6:  Divergence PREDICTION ← this
EXP-0001.7:  Precision Ladder (all precision levels)
```

## Research Value

If `logit_margin < threshold` robustly predicts future divergence:
- **Novel finding**: precision-induced divergence is *predictable*, not random
- **ArcAsha Router**: adds Numerical Reliability as a routing dimension
- **Shadow policy**: adaptive Shadow mode selection based on runtime margin
- **Paper material**: "Predicting Numerical Divergence in Distributed LLM Inference"

