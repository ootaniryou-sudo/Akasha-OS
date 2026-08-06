# EXP-0001.9 Results — 2026-07-31

## Platform Matrix (Partial — MPS completed)

**4 platforms defined, 1 measured, 3 pending.**

---

## Completed: Apple Silicon MPS

| Precision | Top-1 Agree | Top-5 Overlap | KL Mean | 1st Div Pos | Div Rate | Speed | Eff. |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **fp32** | 1.000 | 5.0 | 0.000 | 32.0 | 0.0000 | 1.00× | 1.00 |
| **fp16** | 0.992 | 5.0 | 0.069 | 25.5 | 0.0081 | 1.42× | **1.41** ✨ |
| bf16 | 0.791 | 4.0 | 2.216 | 13.8 | 0.2088 | 1.30× | 1.03 |

### Recommendations

| Task Sensitivity | Precision | Why |
|:---|:---|:---|
| CRITICAL | fp32 | Exact token reproduction |
| STANDARD | fp16 | 99.2% stable, 42% faster |
| THROUGHPUT | fp16 | Best precision_efficiency (1.41) |
| AVOID | bf16 | 20.9% divergence on MPS |

---

## Pending Platforms

| Platform | Backend | Status | Expected |
|----------|---------|--------|----------|
| NVIDIA GPU | pytorch-cuda | ⌛ | BF16 > FP16 (native BF16 on A100/H100) |
| x86 CPU | pytorch-cpu | ⌛ | FP16 ≈ BF16 (both emulated) |
| Browser | onnx-webgpu | ⌛ | Always diverges (different runtime) |

## Output

```
EXP-0001.9/output/
└── platform_matrix.json    # Full matrix (1 completed + 3 pending)
```
