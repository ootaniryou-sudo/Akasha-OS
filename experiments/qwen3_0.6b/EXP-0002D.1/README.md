# EXP-0002D.1 — Confidence-Aware Adaptive Routing

> **Capability 推定に Confidence を導入し、不確実性を考慮したルーティングを実現。**
> **「Bayesianだから逆転が解消した」のではなく、「Bayesian + Confidence Weighting により、**
> **この実験条件では Score Inversion が観測されなかった」と表現するのが科学的に正確。**

## Core Innovation: Two-Stage Evaluation

```
SMA (0002D):                  Bayesian + Confidence (0002D.1):
                              
  Capability                   Capability Estimate (μ)
       │                            │
       ▼                            ▼
  Router                      Confidence Estimate (1−e^(−n/k))
                                    │
                                    ▼
                              Effective Capability (μ × confidence)
                                    │
                                    ▼
                              Router
```

**SMA 時代の問題**: Router は Capability だけを見る。
`Unknown = Strong` になってしまう（n=0 でも初期値 0.95 がそのまま使われる）。

**今回**: Router は `Capability × Confidence` を見る。
`Capability=0.65, Confidence=0.02 → Effective=0.013`
→ 「能力はありそうだが証拠が少ない」を表現できる。

## Confidence Function: Design Rationale

```
confidence(n) = 1 − exp(−n / k),  k = 8

  confidence
  1.0 │                          ●━━━━━
  0.8 │                    ●━━━━
  0.6 │              ●━━━━
  0.4 │        ●━━━━
  0.2 │  ●━━━━
  0.0 ├─────────────────────────────
       0    4    8   12   16   20   n
```

> **An exponential saturation function was selected because confidence should
> increase rapidly during early observations and asymptotically converge
> after sufficient evidence.**

- n=0: confidence=0（証拠ゼロ → 推定値は全く信頼できない）
- n=4: confidence≈0.39（半分程度の信頼）
- n=8: confidence≈0.63（k サンプルで約63%）
- n→∞: confidence→1（完全信頼）

### Future: Lower Confidence Bound

```
effective = μ − λσ  (λ ≥ 0)

  例: μ=0.90, σ=0.25 → 0.65  (安全側に割引)
      μ=0.82, σ=0.03 → 0.79  (確信度が高いので割引が小さい)
```

「平均より、安全側で選ぶ」Router への拡張が可能。

## Results (2026-08-01)

```
Inversions avoided: 7 🛡️
Inversions occurred: 0

  ┌──────────────┬───────────┬────┬───────┬────────┬──────────┐
  │ Node         │ Capability│ n  │ μ     │ conf   │ effective│
  ├──────────────┼───────────┼────┼───────┼────────┼──────────┤
  │ node-coding  │ coding    │  4 │  0.25 │  0.393 │    0.098 │
  │              │ math      │  0 │  0.65 │      0 │        0 │  ← n=0 → eff=0
  │ node-math    │ math      │  4 │ 0.338 │  0.393 │    0.133 │
  │              │ coding    │  0 │  0.62 │      0 │        0 │  ← n=0 → eff=0
  └──────────────┴───────────┴────┴───────┴────────┴──────────┘
```

### SMA vs Bayesian + Confidence

| | SMA (0002D) | Bayesian+Confidence (0002D.1) |
|---|---|---|
| 更新則 | α=0.3 固定 | (n·μ+x)/(n+1) 自然重み |
| n=0 ノード | 初期値 = 能力値 | eff=0 → 選ばれない |
| n=1 の影響 | 30% | 50%（n 増加とともに減衰）|
| 逆転発生 | 1回（req #8）| **0回** ✅ |
| 問題点 | Unknown=Strong | — |

## Router Evolution

```
EXP-0002C:  Static Capability Routing
     ↓
EXP-0002D:  Adaptive Routing (SMA)
            → Score Inversion → Evaluator limit を発見
     ↓
EXP-0002D.1: Confidence-Aware Adaptive Routing  ← 現在地
            → 二段階評価（Capability + Confidence）
            → 不確実性を考慮したルーティング
     ↓
将来:       Lower Confidence Bound (μ − λσ)
            → 「安全側で選ぶ」Router
```

## Running

```bash
npx tsx experiments/qwen3_0.6b/EXP-0002D.1/run_master.ts --port 8080
```

Full results: [`output/summary.json`](output/summary.json)

Depends on: EXP-0002D (Adaptive Capability), EXP-0002C (Capability-Aware Routing)
