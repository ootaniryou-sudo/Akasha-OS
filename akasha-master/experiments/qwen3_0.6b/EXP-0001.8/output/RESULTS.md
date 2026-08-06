# EXP-0001.8 Results — 2026-07-31

## Replication: BF16 Divergence Stability

**5 runs, 50 prompts each, Apple Silicon MPS, T=0 greedy.**

---

## Result: PERFECTLY REPRODUCIBLE (σ = 0.0000)

| Run | BF16 Div Rate | BF16 1st Div | FP16 Div Rate | FP16 1st Div |
|:---:|:---:|:---:|:---:|:---:|
| 1 | 0.2088 | 13.8 | 0.0081 | 25.5 |
| 2 | 0.2088 | 13.8 | 0.0081 | 25.5 |
| 3 | 0.2088 | 13.8 | 0.0081 | 25.5 |
| 4 | 0.2088 | 13.8 | 0.0081 | 25.5 |
| 5 | 0.2088 | 13.8 | 0.0081 | 25.5 |
| **μ** | **0.2088** | **13.8** | **0.0081** | **25.5** |
| **σ** | **0.0000** | **0.0** | **0.0000** | **0.0** |

## Conclusion

> **BF16 divergence rate of 20.88% on MPS is a stable, reproducible measurement.**

With greedy decoding (T=0), all runs produce identical token sequences, confirming the measurement is not a fluke. The platform profile is stable enough for Router integration.

## Implication

The measured Numerical Stability Profile for Apple Silicon MPS is:
- **fp16**: stability = 0.9919, speed = 1.42×, reproducible ✅
- **bf16**: stability = 0.7912, speed = 1.30×, reproducible ✅

These values can be used as **static node profiles** in the ArcAsha Router.
