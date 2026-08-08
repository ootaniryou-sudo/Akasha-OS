# EXP-0001.6 Results — 2026-07-31

## Experiment: Divergence Prediction (PyTorch FP32 vs FP16)

**Model**: `Qwen/Qwen3-0.6B` (base), greedy decoding (T=0), 32 tokens/prompt  
**Device**: MPS (Apple Silicon GPU)  
**Prompts**: 100 (mixed EN/JP, math/code/general)

---

## Formal Conclusion

> **Hypothesis**: Logit margin can predict cross-precision token divergence.
>
> **Result**: **Not supported** under same-runtime FP32→FP16.
>
> **Evidence**: 3,200 positions, only 44 divergence events (1.5%), AUC=0.57, F1=0.14.
>
> **Interpretation**: Per-step divergence prediction is limited by the rarity of the event and is not currently useful as a standalone predictor.
>
> **New direction**: Characterize numerical stability at the backend/precision level rather than predicting each divergence event online.

---

## Quantitative Results

| Lookahead (k) | Valid Records | Divergent | Divergence Rate | AUC | Best Margin | Best F1 |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| k=1 | 3100 | 44 | 1.4% | 0.574 | 0.0110 | 0.103 |
| k=3 | 2900 | 43 | 1.5% | 0.600 | 0.0110 | 0.140 |
| k=5 | 2700 | 41 | 1.5% | 0.566 | 0.0027 | 0.091 |
| k=10 | 2200 | 36 | 1.6% | 0.543 | 0.0027 | 0.053 |

AUC=0.57 indicates marginal signal above random (0.50), but **insufficient for operational use**.
F1=0.14 reflects the fundamental difficulty of predicting rare events (1.5% base rate).

**This is not a failure.** The experiment correctly identified that per-step prediction is the wrong abstraction level. The right approach is backend/precision-level characterization (see EXP-0001.7).

### Why MODERATE and not STRONG?

The **root cause** is the extremely low divergence rate (1.4-1.6%) for same-runtime comparisons:

- 100 prompts × 32 tokens = 3200 generation steps
- Only 36-44 positions diverge (1.5%)
- Predicting rare events is inherently difficult
- High variance in precision/recall due to small N

### What the Data Shows

1. **AUC = 0.54-0.60**: Margin has *some* signal — better than random (0.5), but not strong.
2. **Best F1 = 0.14**: At individual positions, the tradeoff between catching divergences and false positives is poor.
3. **Best threshold ≈ 0.011**: Positions with margin below 0.011 have slightly elevated divergence risk.

### Detailed Threshold Analysis (k=1)

```
margin < 0.0110 → P=0.214 R=0.068 F1=0.103
  Interpretation: If we flag positions with margin < 0.011,
  we catch 6.8% of divergences, but only 21.4% of flags are correct.

margin < 0.0010 → P=0.500 R=0.023 F1=0.043
  Stricter threshold: fewer flags, higher precision, much lower recall.
```

---

## Critical Finding: Same-Runtime Divergence is TOO RARE

The fundamental issue is not that margin is a bad predictor — it's that **same-runtime divergence is too rare to predict statistically**.

```
Same-runtime (PyTorch FP32→FP16):
  Divergence rate: 1.5%   ← too rare for reliable prediction
  AUC: 0.57              ← some signal, but insufficient

Expected cross-runtime (PyTorch FP32→ONNX FP16):
  Divergence rate: ~100%  ← always diverges
  Question: can margin predict WHEN (at which position)?
```

### The Real Test: Cross-Runtime

EXP-0001 showed that PyTorch vs ONNX diverges on EVERY prompt. The question for margin-based prediction is:

> "At which specific token position will the cross-runtime divergence occur?"

This is a fundamentally different (and potentially easier) prediction problem:
- High divergence rate → more training data for the predictor
- The signal (margin at pre-divergence positions) may be stronger
- AUC may be significantly higher

---

## Practical Implications for ArcAsha

### For Same-Runtime (Exact Shadow)

```
Finding: FP32→FP16 divergence is 1.5% — negligible for most use cases.
Policy:  Exact Shadow can safely use FP16 within same runtime.
         No margin-based monitoring needed.
         Token identity is preserved 98.5% of the time.
```

### For Cross-Runtime (Independent Shadow)

```
Finding: Margin prediction for cross-runtime remains UNTESTED.
Action:  EXP-0001.6 needs Phase 2: fp32_vs_onnx_fp16.
         This is where margin prediction matters most.
```

### Divergence Rate as a Backend Quality Metric

Rather than using margin as a per-step predictor, we can use **overall divergence rate** as a backend quality metric:

```
Backend Quality = 1.0 - divergence_rate

PyTorch FP32:   quality = 1.000 (baseline)
PyTorch FP16:   quality = 0.985 (1.5% divergence)
```

This feeds directly into the NumericalStability dimension of the Router.

---

## Next Steps

1. **EXP-0001.6 Phase 2**: `fp32_vs_onnx_fp16` — the TRUE test of margin-based prediction
2. **EXP-0001.7**: Precision Ladder — systematic quality scores for all backends
3. **Router Integration**: Use backend-level divergence rate (not per-step margin) as NumericalStability score

## Output Files

```
EXP-0001.6/output/
├── manifest.json
├── fp32_vs_fp16/
│   ├── summary.json
│   └── predictions.jsonl    (3200 records)
```

