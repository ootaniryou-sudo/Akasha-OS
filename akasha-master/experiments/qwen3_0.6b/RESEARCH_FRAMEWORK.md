# ArcAsha — Research Framework

> **多目的・信頼度考慮型ルーティングフレームワーク**
> **Multi-Objective, Confidence-Aware Routing for Distributed LLM Experts**

## Central Concept

> 分散 LLM におけるルーティング戦略を、多目的最適化・数値安定性・信頼度推定を用いて体系化する。

ArcAsha の独自性は、一般的な MoE Router（Capability → Top-k）とは異なり、
**Routing を最適化問題として扱う**ことにある。

## Research Pillars

### 1. Numerical Characterization (Phase 1: EXP-0000〜0001.9)

- Cross-runtime reproducibility
- Precision ladder (FP16 best, BF16 problematic on MPS)
- Numerical Stability = f(platform, backend, kernel, precision, device)

### 2. Distributed Runtime (Phase 2: EXP-0002A/B)

- Remote expert via WebSocket
- Heterogeneous nodes (PC expert + iPhone relay)
- Master Hub, Scheduler, Node Registry

### 3. Intelligent Routing (Phase 3: EXP-0002C〜0002E.3)

- Capability → Adaptive → Confidence → Composite
- Weight Space (Decision Boundary) + Objective Space (Pareto Frontier)
- Two-stage routing: Pareto Filter → Composite Score

### 4. Collaborative Intelligence (Phase 4: EXP-0002F〜0003D)

- Shadow Expert as teacher
- Planner / Critic / Verifier / Consensus

## Paper Structure (Draft)

```
Title: Confidence-Aware Multi-Objective Routing for
       Distributed Language Model Experts

1. Introduction
   - Small models × collaboration → frontier-level capability
   - Routing as optimization problem (not top-k)

2. Numerical Stability Profile (EXP-0001)
   - Cross-backend reproducibility
   - Precision ladder findings

3. Distributed Runtime (EXP-0002A/B)
   - Heterogeneous node architecture
   - Master Hub, Scheduler, Node Registry

4. Confidence-Aware Capability Routing
   4.1 Static Capability (EXP-0002C)
   4.2 Adaptive Update & Evaluator Limits (EXP-0002D)
   4.3 Bayesian Confidence (EXP-0002D.1)
   4.4 Composite Score (EXP-0002E)

5. Multi-Objective Analysis
   5.1 Decision Boundary in Weight Space (EXP-0002E.1)
   5.2 Pareto Frontier in Objective Space (EXP-0002E.2)
   5.3 Two-Stage Routing Design
       'Scalarization cannot preserve the full dominance structure
        of a multi-objective routing problem. Therefore, Pareto filtering
        is introduced before scalarization to preserve the dominance
        structure while enabling policy-driven final selection.'

6. Conclusion & Future Work
   - Adaptive weight learning within Pareto set
   - Shadow expert for dynamic stability
   - Collaborative intelligence (Phase 4)
```

## Design Principles

| # | Principle | Evidence |
|---|-----------|----------|
| 1 | Numerical Stability is config-specific, not universal | EXP-0001.7 |
| 2 | Evaluation fidelity bounds routing quality | EXP-0002D (inversion) |
| 3 | Confidence separates estimate from trust | EXP-0002D.1 |
| 4 | Stability acts as secondary objective (lexicographic-like) | EXP-0002E.1 |
| 5 | Scalarization hides dominance structure | EXP-0002E.2 |
| 6 | Pareto-filter before scalarization | EXP-0002E.2 |

## Experiment → Principle Map

```
EXP-0001      →  Stability DB for Composite Score (0002E)
EXP-0002D.1   →  Confidence mechanism (two-stage evaluation)
EXP-0002E     →  Composite Score integrates all dimensions
EXP-0002E.1   →  Weight Space: decision boundary
EXP-0002E.2   →  Objective Space: Pareto frontier, two-stage design
```

