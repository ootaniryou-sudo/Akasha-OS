# ArcAsha — Experiment Conclusions

> **EXP-0000 through EXP-0001.7: cumulative findings**

---

## Three-Line Conclusion

1. **EXP-0001**: Cross-runtime inference is functional, but token-level reproducibility is backend-sensitive.

2. **EXP-0001.5**: Observed divergence is primarily triggered by numerical ambiguity (logit_margin < 0.02) and amplified by backend/kernel differences.

3. **ArcAsha implication**: Exact replication, approximate redundancy, and independent verification should be treated as distinct execution modes.

---

## New Design Principle (EXP-0001.6/1.7)

> **Numerical Stability is a property of an execution configuration, not of a model alone.**

```
Numerical Stability = f(platform, backend, kernel, precision, device, model)
```

See [`NUMERICAL_STABILITY_PROFILE.md`](NUMERICAL_STABILITY_PROFILE.md) for full specification.

### Key Finding: Platform-Dependent Precision Behavior

| Platform | FP16 Divergence | BF16 Divergence | Best Choice |
|----------|:---:|:---:|:---:|
| Apple MPS | 0.8% ✅ | 20.9% ⚠️ | FP16 |
| NVIDIA CUDA | ~1-5% (TBD) | ~0.5-2% (TBD) | BF16 (expected) |
| x86 CPU | ~0% (TBD) | ~0% (TBD) | Either |

> **Safe statement**: "BF16 showed larger numerical deviation than FP16 under the tested MPS configuration." Kernel implementation was not directly observed.

---

## Execution Modes

| Mode | Definition | Shadow Type | When |
|------|-----------|-------------|------|
| **Exact Replication** | Same backend + same precision → identical tokens | Exact Shadow | Critical tasks |
| **Approximate Redundancy** | Same model, different precision → 99.2% token match (FP16) | Exact Shadow (tolerant) | Standard tasks |
| **Independent Verification** | Different backend → semantically equivalent output | Independent Shadow + Verifier | Cross-runtime |

---

## EXP-0001.6 Formal Conclusion

> **Hypothesis**: Logit margin can predict cross-precision token divergence.  
> **Result**: **Not supported** under same-runtime FP32→FP16.  
> **Evidence**: 3,200 positions, 44 divergences (1.5%), AUC=0.57, F1=0.14.  
> **Interpretation**: Per-step prediction is the wrong abstraction level.  
> **New direction**: Backend/precision-level characterization (Numerical Stability Profile).

---

## EXP-0001.7 Formal Conclusion

> **Key finding**: Numerical behavior is platform/backend/precision dependent.  
> **Observation**: Under Apple Silicon MPS, FP16 showed substantially higher stability (0.8% divergence) than BF16 (20.9% divergence) despite both being reduced-precision modes.  
> **Design implication**: Numerical stability must be modeled as an execution-configuration property, not a universal property of model or precision format.

---

## Key Data Points

| Metric | Same Runtime (FP32→FP16) | Cross Runtime (PyTorch→ONNX) |
|--------|:---:|:---:|
| Top-1 match rate | 99.2% (EXP-0001.7, 50 prompts) | 15–44% (EXP-0001, 10 prompts) |
| Mean top-5 overlap | 5.0/5 | — |
| Mean logit correlation | 0.9974 | — |
| Divergence mechanism | Rare (1.5%), margin-driven | Always (100%), kernel-driven |
| Per-step prediction | Not viable (AUC=0.57) | Untested |

---

## Router: Numerical Stability Dimension

```
RoutingScore =
  CapabilityMatch
  × ModelQuality
  × NodeAvailability
  × HardwareFit
  × NetworkQuality
  × Reliability
  × NumericalStability(platform, backend, precision)  ← Execution-configuration-aware
  ÷ Cost
```

This enables:
- **Execution Configuration Routing** — not just which model, but which precision/backend/platform
- **Task Sensitivity Matching** — critical tasks → exact replication, throughput tasks → fp16
- **Platform-Aware Decisions** — BF16 on MPS → avoid, BF16 on CUDA → preferred

See [`NUMERICAL_STABILITY_PROFILE.md`](NUMERICAL_STABILITY_PROFILE.md).

---

## Research Roadmap

```
✅ EXP-0000    Golden Reference (PyTorch FP32)
✅ EXP-0001    Python vs JS/ONNX token comparison
✅ EXP-0001.5  Logit-level precision analysis
✅ EXP-0001.6  Divergence Prediction — NOT SUPPORTED (per-step), new direction found
✅ EXP-0001.7  Precision Ladder — platform-dependent profiles
✅ EXP-0001.8  Replication — BF16 σ=0.0000, perfectly reproducible
✅ EXP-0001.9  Platform Matrix — 1/4 platforms completed
─────────────────────────────────────────────────────
📐 EXP-0002A   Remote Single Expert (1 Master + 1 Node)
📐 EXP-0002B   Two Experts (routing with multiple nodes)
📐 EXP-0002C   Specialized Experts (Capability Profile routing)
📐 EXP-0003    Two-Expert Cooperative Inference
📐 EXP-0004    Active Expert Scaling (1→2→4→8→16)
⏳ EXP-0005+   Fault tolerance, Memory Fabric, Long Context
```

### Phase Summary

| Phase | Experiments | Theme |
|-------|------------|-------|
| **Phase 1** | EXP-0000 〜 0001.9 | LLM numerical characterization |
| **Phase 2** | EXP-0002A/B/C | Distributed single/multi-node |
| **Phase 3** | EXP-0003 | Cooperative inference |
| **Phase 4** | EXP-0004 | Active expert scaling |
| **Phase 5+** | EXP-0005+ | Fault tolerance, memory, long context |

---

## Publication-Ready Statements

> "Cross-runtime LLM inference is functional but token-level reproducibility is backend-sensitive. Numerical behavior is platform/backend/precision dependent — no single precision format is universally optimal. This motivates execution-configuration-aware routing, where numerical stability is modeled as a property of the full execution stack rather than of the model alone."

> "Per-step divergence prediction via logit margin is not viable under same-runtime conditions due to the rarity of divergence events (1.5%). Backend-level numerical characterization provides a more robust foundation for distributed inference system design."

