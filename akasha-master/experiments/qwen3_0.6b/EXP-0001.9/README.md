# EXP-0001.9 — Platform Matrix

> **「BF16 が悪い」のではなく「どの環境でどうなるのか」を明らかにする。**

同一モデル・同一プロンプトを Apple Silicon / CUDA / CPU で比較。

## Objective

Precision Ladder (EXP-0001.7) を複数プラットフォームに拡張し、プラットフォーム依存性を定量化する。

## Platform × Precision Matrix

| Platform | Backend | FP32 | BF16 | FP16 | INT8 |
|----------|---------|:---:|:---:|:---:|:---:|
| Apple Silicon (M1/M2/M3) | PyTorch MPS | ✅ done | ✅ done | ✅ done | — |
| NVIDIA GPU (T4/A100) | PyTorch CUDA | ⌛ | ⌛ | ⌛ | ⌛ |
| x86 CPU | PyTorch CPU | ⌛ | ⌛ | ⌛ | — |
| Apple Silicon | ONNX (CoreML) | ⌛ | — | ⌛ | ⌛ |
| Web Browser | WebGPU/ONNX | ⌛ | — | ⌛ | ⌛ |

## Metrics (per cell)

Same as Numerical Stability Profile:
- `top1_agreement`, `top5_overlap`, `logit_correlation`
- `kl_divergence_mean`, `first_divergence_position_mean`
- `divergence_rate`, `relative_speed`, `precision_efficiency_ratio`

## Expected Findings (Hypothesis)

| Platform | BF16 vs FP16 Quality | Reason |
|----------|:---:|--------|
| Apple MPS | FP16 > BF16 | Measured (EXP-0001.7) |
| NVIDIA CUDA | BF16 > FP16 | BF16 native on A100/H100 |
| x86 CPU | FP16 ≈ BF16 | Both emulated |
| WebGPU | FP16 only | No BF16 support |

## Output

```
EXP-0001.9/output/
├── manifest.json
├── platform_matrix.json
├── macos_mps/       (from EXP-0001.7)
├── nvidia_cuda/     (TBD)
├── x86_cpu/         (TBD)
└── RESULTS.md
```

### Platform Matrix Schema

```json
{
  "model": "Qwen3-0.6B",
  "num_prompts": 50,
  "platforms": [
    {
      "platform": "macos-arm64",
      "backend": "pytorch-mps",
      "status": "completed",
      "precisions": {
        "fp32": { "top1_agreement": 1.000, "relative_speed": 1.00 },
        "fp16": { "top1_agreement": 0.992, "relative_speed": 1.42 },
        "bf16": { "top1_agreement": 0.791, "relative_speed": 1.30 }
      }
    },
    {
      "platform": "linux-x86_64",
      "backend": "pytorch-cuda",
      "status": "pending",
      "precisions": {}
    }
  ]
}
```

## Success Criteria

- [ ] At least 3 platforms measured
- [ ] Platform × precision interaction quantified
- [ ] Platform-specific recommendations derived
- [ ] Numerical Stability Profile populated per platform

## ArcAsha Integration Target

This matrix directly populates the Router's platform-aware Numerical Stability database:

```
Router.stabilityDB = {
  "macos-arm64:pytorch-mps:fp16:Qwen3-0.6B": { top1: 0.992, speed: 1.42 },
  "linux-x86_64:pytorch-cuda:bf16:Qwen3-0.6B": { top1: ?.???, speed: ?.?? },
  ...
}
```

