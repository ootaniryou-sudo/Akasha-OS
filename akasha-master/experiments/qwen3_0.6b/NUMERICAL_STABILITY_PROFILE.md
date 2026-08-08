# Numerical Stability Profile — ArcAsha Design Spec

> **Numerical Stability is a property of an execution configuration, not of a model alone.**

Derived from EXP-0001 through EXP-0001.7. See [`CONCLUSIONS.md`](../CONCLUSIONS.md).

---

## Design Principle

```
Numerical Stability
  depends on:
    Platform      (macOS-arm64, linux-x86_64, ...)
    Backend       (PyTorch, ONNX, WebGPU, ...)
    Kernel        (MPS, CUDA, CPU, ...)
    Precision     (FP32, BF16, FP16, INT8, INT4)
    Device        (Apple Silicon, NVIDIA GPU, ...)
    Model         (Qwen3-0.6B, Llama-3.2-1B, ...)
```

**Not**: `stability = universal_constant`  
**But**: `stability = f(platform, backend, kernel, precision, device, model)`

---

## Multi-Dimensional Profile

A single scalar (`stability = 1 - divergence_rate`) is useful as a research proxy but insufficient for production routing.

### Full Profile

```json
{
  "execution_config": {
    "platform": "macos-arm64",
    "backend": "pytorch-mps",
    "precision": "fp16",
    "model": "Qwen3-0.6B"
  },
  "numerical_profile": {
    "sequence_exact_match": 0.982,
    "top1_agreement": 0.992,
    "top5_overlap": 5.0,
    "logit_correlation": 0.9974,
    "kl_divergence_mean": 0.069,
    "kl_divergence_p95": 0.012,
    "first_divergence_position_mean": 25.5,
    "first_divergence_position_median": 32,
    "divergence_rate": 0.008,
    "output_length_ratio": 1.000
  },
  "performance_profile": {
    "throughput_tokens_per_sec": 16.1,
    "relative_speed": 1.42,
    "precision_efficiency_ratio": 1.41
  }
}
```

### Dimension Definitions

| Dimension | Range | Description | Higher = |
|-----------|-------|-------------|----------|
| `sequence_exact_match` | 0–1 | Full output token sequence matches baseline exactly | Better |
| `top1_agreement` | 0–1 | Fraction of positions where top-1 token matches | Better |
| `top5_overlap` | 0–5 | Average number of shared tokens in top-5 | Better |
| `logit_correlation` | 0–1 | Pearson r between logit vectors | Better |
| `kl_divergence_mean` | 0–∞ | Mean KL(P_ref ‖ P_backend) | Lower |
| `first_divergence_position_mean` | 0–max_tokens | Average position of first token mismatch | Higher (later divergence) |
| `divergence_rate` | 0–1 | Fraction of positions with token mismatch | Lower |
| `precision_efficiency_ratio` | 0–∞ | top1_agreement / relative_speed | Higher |

---

## Stability Score Derivation

> **⚠️ `stability = 1 − divergence_rate` is a RESEARCH PROXY only, NOT the final metric.**

A single scalar (`stability = 1 - divergence_rate`) is useful for quick comparisons during experiments, but it collapses too much information. A single token difference counts as "diverged" regardless of severity — a near-synonym at position 30 is treated the same as a completely different continuation at position 2.

### Composite Stability Score

The production **Stability Score** (0–1) is derived from the full Numerical Profile:

```
Stability Score = w1 × sequence_exact_match
                + w2 × top1_agreement
                + w3 × top5_overlap / 5
                + w4 × logit_correlation
                + w5 × (1 − normalized_kl)
                + w6 × first_divergence_position / max_tokens

Where weights depend on task sensitivity:
  - Critical verification: w1=0.4, w2=0.3, w4=0.2, w6=0.1
  - General chat:        w2=0.3, w3=0.3, w1=0.2, w6=0.2
  - Throughput:          w3=0.3, w2=0.3, precision_efficiency=0.4
```

---

## Platform-Specific Profiles (Measured)

### Apple Silicon MPS (EXP-0001.7)

| Precision | Top-1 Agree | Seq Match | Top-5 Overlap | KL Mean | 1st Div Pos | Div Rate | Speed | Eff. |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| fp32 | 1.000 | 1.000 | 5.0 | 0.000 | 32.0 | 0.000 | 1.00× | 1.00 |
| fp16 | 0.992 | 0.982 | 5.0 | 0.069 | 25.5 | 0.008 | 1.42× | 1.41 |
| bf16 | 0.791 | — | 4.0 | 2.216 | 13.8 | 0.209 | 1.30× | 1.03 |

### Future: NVIDIA CUDA, CPU, ONNX, INT8, INT4

To be measured in EXP-0001.9 (Platform Matrix) and EXP-0001.7 Phase 2.

---

## Node Registration with Numerical Profile

Each ArcAsha Node registers its execution configuration:

```typescript
interface NodeNumericalProfile {
  platform: string;
  backend: string;
  precision: string;
  model: string;
  profile: {
    top1Agreement: number;
    sequenceExactMatch: number;
    top5Overlap: number;
    logitCorrelation: number;
    klDivergenceMean: number;
    firstDivergencePosMean: number;
    divergenceRate: number;
    relativeSpeed: number;
    precisionEfficiency: number;
  };
}

// Example: Node 001
const node001: NodeNumericalProfile = {
  platform: "macos-arm64",
  backend: "pytorch-mps",
  precision: "fp16",
  model: "Qwen3-0.6B",
  profile: {
    top1Agreement: 0.992,
    sequenceExactMatch: 0.982,
    top5Overlap: 5.0,
    logitCorrelation: 0.9974,
    klDivergenceMean: 0.069,
    firstDivergencePosMean: 25.5,
    divergenceRate: 0.008,
    relativeSpeed: 1.42,
    precisionEfficiency: 1.41,
  },
};
```

---

## Router Integration

The Eye of Wisdom uses Numerical Profiles to make routing decisions:

```
For task with sensitivity = CRITICAL:
  → prefer nodes with sequence_exact_match > 0.99
  → acceptable: fp32 on any platform

For task with sensitivity = STANDARD:
  → prefer nodes with precision_efficiency > 1.2
  → acceptable: fp16 on MPS, fp16 on CUDA

For task with sensitivity = THROUGHPUT:
  → prefer nodes with highest relative_speed
  → acceptable: fp16 on MPS (1.42×), INT8 on CUDA (TBD)
```

### Task Sensitivity Levels

| Level | Example Tasks | Required Stability |
|-------|---------------|-------------------|
| VERY_HIGH | Scientific computation, safety verification | sequence_exact_match > 0.99 |
| HIGH | Code generation, math reasoning | top1_agreement > 0.99 |
| MEDIUM | General conversation, summarization | top1_agreement > 0.95 |
| LOW | Casual chat, brainstorming | top5_overlap > 4.0 |
| THROUGHPUT | Batch processing, non-critical | precision_efficiency > 1.3 |

