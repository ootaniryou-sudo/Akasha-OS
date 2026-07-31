# ArcAsha — Experiment Conclusions

> **EXP-0001 through EXP-0001.5: three-line summary**

---

## Three-Line Conclusion

1. **EXP-0001**: Cross-runtime inference is functional, but token-level reproducibility is backend-sensitive.

2. **EXP-0001.5**: Observed divergence is primarily triggered by numerical ambiguity (logit_margin < 0.02) and amplified by backend/kernel differences.

3. **ArcAsha implication**: Exact replication, approximate redundancy, and independent verification should be treated as distinct execution modes.

---

## Execution Modes

| Mode | Definition | Shadow Type | When |
|------|-----------|-------------|------|
| **Exact Replication** | Same backend + same precision → identical tokens | Exact Shadow | logit_margin > threshold |
| **Approximate Redundancy** | Same model, different precision → ~93.75% token match | Exact Shadow (with tolerance) | FP32/FP16 within same runtime |
| **Independent Verification** | Different backend → semantically equivalent output | Independent Shadow + Verifier | Cross-runtime, critical tasks |

---

## Key Data Points

| Metric | Same Runtime (FP32→FP16) | Cross Runtime (PyTorch→ONNX) |
|--------|:---:|:---:|
| Top-1 match rate | 93.75% | 15–44% |
| Mean top-5 overlap | 4.7/5 | — |
| Mean logit correlation | 0.9731 | — |
| Divergence trigger | logit_margin < 0.02 | Different matmul kernel |
| Divergence predictability | High (margin-based) | Deterministic (always diverges) |

---

## Router: New Dimension — Numerical Reliability

```
RoutingScore =
  CapabilityMatch
  × ModelQuality
  × NodeAvailability
  × HardwareFit
  × NetworkQuality
  × Reliability
  × NumericalStability  ← NEW
  ÷ Cost
```

Where **NumericalStability** is derived from:
- Backend (PyTorch / ONNX / WebGPU)
- Precision (FP32 / BF16 / FP16 / INT8 / INT4)
- Measured divergence rate vs baseline
- logit_margin distribution at runtime

This enables ArcAsha to distinguish:
- **"Fast but numerically unstable"** nodes (INT8 ONNX)
- **"Slow but exactly reproducible"** nodes (FP32 PyTorch)
- And route tasks accordingly based on precision requirements.

---

## Research Roadmap

```
EXP-0000:    Golden Reference ✅
EXP-0001:    Python vs JS/ONNX token comparison ✅
EXP-0001.5:  Logit-level precision analysis ✅
EXP-0001.6:  Divergence PREDICTION (margin → future divergence?)
EXP-0001.7:  Precision Ladder (all precisions × all backends)
EXP-0002:    Multi-node with standardized runtime
```

---

## Publication-Ready Statements

> "Cross-runtime LLM inference is functional but token-level reproducibility is backend-sensitive. Numerical divergence is triggered by small logit margins (< 0.02) and amplified by backend-specific kernel implementations. This motivates distinct execution modes — exact replication, approximate redundancy, and independent verification — as first-class primitives in distributed inference systems."
