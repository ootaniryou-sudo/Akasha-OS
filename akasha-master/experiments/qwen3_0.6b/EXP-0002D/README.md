# EXP-0002D — Adaptive Capability Profile

> **Static Profile → Measured Performance → Adaptive Profile**
> **仮説と異なる挙動（Score Inversion）が観測され、その原因が特定できたことで、より深い研究課題が明らかになった。**

## Research Conclusion

> **Adaptive routing itself behaves correctly.**
> **However, routing quality is fundamentally bounded by the fidelity of the task evaluation function.**
> **An inaccurate evaluator can cause capability inversion, leading the router to consistently select suboptimal experts.**

This is a well-known issue in:
- Online Learning
- Multi-Armed Bandits
- RLHF
- AutoML
- MoE Routing

ArcAsha has now empirically replicated this phenomenon in a multi-LLM orchestration context.

## Observed Phenomenon: Score Inversion

```
Initial State:
  node-coding: math = 0.65
  node-math:   math = 0.94  ← clearly the math expert

After 3 math evaluations (heuristic scoring ~0.3-0.5):
  node-coding: math = 0.65  ← unchanged (no math tasks yet)
  node-math:   math = 0.545 ← dragged down by heuristic

Result at req #8:
  math task → node-coding (0.65 > 0.545) ⚡ INVERSION
```

### Why This Is NOT a Bug

```
Router は score(node) だけを見ている。
node-coding math=0.65 > node-math math=0.545 → coding を選ぶ。
アルゴリズムとしては完全に正しい。
```

### Root Cause

```
Capability Update の評価関数が粗い:

  Prompt → Heuristic (keyword match + length) → Score
  0.94   →                                    → 0.54

単一タスクで急激にスコアが変動する。
SMA (α=0.3) では smoothing が不十分。
```

## What This Reveals

```
ArcAsha の Adaptive Routing には以下の階層構造がある:

  Capability Profile
       ↓
  Evaluation Function    ← 今回の問題箇所
       ↓
  Score Update Rule      ← SMA α=0.3
       ↓
  Routing Decision       ← 正しく動作
```

**Evaluation Function の忠実度が Routing Quality の上限を決定する。**

## Next: Task Evaluator Improvement

| Current (Heuristic) | Target (Measured) |
|-----|-----|
| Keyword match | Compile + Unit Test (coding) |
| Length bonus | SymPy correctness (math) |
| Refusal detection | Semantic similarity (general) |
| Point estimate (0.588) | Confidence interval (0.58 ± 0.09) |
| SMA (α=0.3) | Bayesian update with uncertainty |

### Confidence-Aware Routing

```
Router は Score × Confidence を評価:

  node-coding: math = 0.65, confidence = 0.30 (1 sample)  → effective = 0.195
  node-math:   math = 0.55, confidence = 0.80 (3 samples) → effective = 0.440

⇒ node-math が選ばれる（サンプル数が少ない推定値は割り引かれる）
```

## Results (2026-08-01)

```
Capability Score Evolution:
  ┌──────────────┬───────────┬──────────────────────────────────────┐
  │ node-coding  │ coding    │ 0.95 → 0.588 (4 tasks) 🔄            │
  │              │ math      │ 0.65 → 0.588 (1 task)  🔄            │
  │              │ general   │ 0.80 → 0.705 (1 task)  🔄            │
  │ node-math    │ math      │ 0.94 → 0.545 (3 tasks) ⚡ INVERTED   │
  │              │ general   │ 0.80 → 0.821 (1 task)  ✅            │
  └──────────────┴───────────┴──────────────────────────────────────┘

  Total Δ: node-coding=0.519, node-math=0.416
  Score Inversion at req #8: math → node-coding
```

Full results: [`output/summary.json`](output/summary.json)

