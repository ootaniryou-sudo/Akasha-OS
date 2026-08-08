# EXP-0001.7 Results — 2026-07-31

## Experiment: Precision Ladder (PyTorch FP32 / BF16 / FP16)

**Model**: `Qwen/Qwen3-0.6B` (base), greedy decoding (T=0), 32 tokens/prompt  
**Device**: MPS (Apple Silicon GPU)  
**Prompts**: 50 (mixed EN/JP, math/code/general)

---

## Precision Ladder

| Precision | Speed (50 prompts) | Rel Speed | Div Rate vs FP32 | Stability Score |
|:---|:---:|:---:|:---:|:---:|
| **pt_fp32** | 70,925ms | 1.000× | (baseline) | **1.0000** |
| **pt_bf16** | 54,707ms | 1.297× | 0.2087 ⚠️ | **0.7913** |
| **pt_fp16** | 49,943ms | 1.420× | 0.0081 ✅ | **0.9919** |

## Pairwise Comparison

| Pair | Top-1 Match | Div Rate | Top-5 Overlap | KL | Logit Corr | Speed Ratio | Precision Eff. |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| FP32 vs BF16 | 79.1% | 20.9% | 4.0/5 | 2.216 | 0.9170 | 0.771 | 1.03 |
| **FP32 vs FP16** | **99.2%** | **0.8%** | **5.0/5** | **0.069** | **0.9974** | **0.704** | **1.41** ✨ |
| BF16 vs FP16 | 79.9% | 20.1% | 4.0/5 | 2.210 | 0.9196 | 0.913 | 0.88 |

---

## 🔬 Critical Finding: BF16 Shows Platform-Dependent Divergence

### Observation

BF16 (Brain Float 16) is designed to preserve FP32's exponent range. On NVIDIA/x86, it typically shows lower divergence than FP16.

**Under the tested Apple Silicon MPS configuration, BF16 showed 20.9% divergence vs FP32 — substantially higher than FP16's 0.8% under the same configuration.**

### Interpretation (with appropriate caution)

- MPS on Apple Silicon showed different numerical behavior for BF16 vs FP16
- The internal kernel implementation was not directly observed — we measure only external behavior
- **Safe statement**: "BF16 showed larger numerical deviation than FP16 under the tested MPS configuration"
- **Avoid**: claiming specific kernel causes without direct observation

### Comparison: Observed Results

| | Observed (Apple MPS) | Expected (NVIDIA CUDA, literature) |
|---|---|---|
| FP16 divergence | **0.8%** | ~1-5% |
| BF16 divergence | **20.9%** | ~0.5-2% |

**Key insight**: Numerical behavior is platform/backend/precision dependent. No single precision format is universally optimal — it depends on the execution configuration.

---

## 🎯 Precision Efficiency — The Key Metric

```
Precision Efficiency = Top-1 Match Rate / Relative Speed
                     = "How much quality per unit of speed?"

pt_fp16:  efficiency = 0.992 / 0.704 = 1.41  ← BEST
pt_bf16:  efficiency = 0.791 / 0.771 = 1.03
pt_fp32:  efficiency = 1.000 / 1.000 = 1.00  (baseline)
```

FP16 delivers **41% more quality per unit of compute time** than FP32 baseline.

---

## ArcAsha Router: Numerical Stability Scores

### Recommended Per-Backend Scores

```json
{
  "numerical_stability": {
    "pytorch_fp32_mps": 1.000,
    "pytorch_fp16_mps": 0.992,
    "pytorch_bf16_mps": 0.791
  },
  "relative_speed": {
    "pytorch_fp32_mps": 1.00,
    "pytorch_fp16_mps": 1.42,
    "pytorch_bf16_mps": 1.30
  },
  "recommended": {
    "critical_tasks": "pytorch_fp32",
    "throughput_tasks": "pytorch_fp16",
    "avoid_on_mps": "pytorch_bf16"
  }
}
```

### Router Decision Logic

```
if task.precision_requirement == "exact":
    → use fp32 (stability = 1.000)

elif task.precision_requirement == "high":
    → use fp16 (stability = 0.992, 42% faster)

elif task.precision_requirement == "throughput":
    → use fp16 (best precision_efficiency = 1.41)

else:
    → DO NOT use bf16 on MPS (stability = 0.791, too low)
```

---

## Platform-Specific Precision Profiles

This experiment reveals that **precision profiles are platform-dependent**:

| Platform | FP16 Divergence | BF16 Divergence | Best Choice |
|----------|:---:|:---:|:---:|
| Apple MPS | 0.8% ✅ | 20.9% ❌ | FP16 |
| NVIDIA CUDA | ~1-5% | ~0.5-2% | BF16 |
| CPU | ~0% | ~0% | Either |

**Implication**: The Router must maintain **platform-specific stability scores**, not universal ones.
Each Node registers its `backend + precision + platform` tuple, and the Router computes a platform-aware NumericalStability score.

---

## Next Steps

1. **ONNX Ladder**: Add `onnx_fp32`, `onnx_fp16` to the ladder (requires ONNX model)
2. **Multi-platform**: Run on CUDA, CPU for comparison
3. **INT8/INT4**: Extreme quantization levels
4. **Router Integration**: Implement platform-aware stability scoring in `AkashaRouter`

## Output Files

```
EXP-0001.7/output/
├── manifest.json
├── precision_ladder.json
├── pt_fp32_vs_pt_bf16/summary.json
├── pt_fp32_vs_pt_fp16/summary.json
└── pt_bf16_vs_pt_fp16/summary.json
```

