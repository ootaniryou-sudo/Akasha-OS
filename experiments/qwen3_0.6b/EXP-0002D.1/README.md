# EXP-0002D.1 — Task Evaluator: Heuristic → Measured

> **評価関数の忠実度が Routing Quality の上限を決定する。**
> **EXP-0002D で発見された Score Inversion の根本原因に対処する。**

## Problem (from EXP-0002D)

```
Heuristic Evaluator:
  Prompt → keyword match + length bonus → Score 0.3-0.5
  Result: math expert 0.94 → 0.545 in 3 steps
  Cause: 評価が粗すぎて、単一タスクで急激に変動
```

## Solution: Capability-Specific Real Evaluators

### Coding Evaluator

```
Prompt → LLM generates code → Extract code block →
  ├── Syntax check (AST parse)
  ├── Run with test cases → Pass/Fail
  └── Capability Score = pass_rate
```

### Math Evaluator

```
Prompt → LLM generates answer → Extract expression →
  ├── SymPy evaluation
  ├── Compare with ground truth
  └── Capability Score = correct_rate
```

### General Evaluator

```
Prompt → LLM generates answer →
  ├── Semantic similarity to reference
  ├── Length / coherence heuristics
  └── Capability Score = similarity_score
```

## Confidence-Aware Update

### Current (EXP-0002D)

```
new_score = α × task_score + (1-α) × old_score
α = 0.3 (fixed)
→ 単一タスクで大きく変動
```

### Target: Bayesian Update with Confidence

```
n = sample_count
μ = current_mean
σ² = current_variance

After new observation x:
  μ_new = (n × μ + x) / (n + 1)
  σ²_new = σ² × n/(n+1) + (x - μ_new)² / (n+1)
  n_new = n + 1

Confidence = 1 - exp(-n / min_samples)
Effective Score = μ × confidence
```

### Effect

```
Before (SMA, 3 samples):
  math: 0.545 (point estimate only)

After (Bayesian, 3 samples):
  math: 0.70 ± 0.15, confidence=0.45
  Effective: 0.70 × 0.45 = 0.315  ← 信頼性が低いので割り引かれる
```

## Success Criteria

- [ ] Coding evaluator: AST parse + test execution
- [ ] Math evaluator: SymPy verification
- [ ] General evaluator: semantic similarity
- [ ] Bayesian update replaces SMA
- [ ] Confidence intervals computed per-capability
- [ ] Router uses Effective Score = Score × Confidence
- [ ] Score inversion eliminated or significantly reduced

## Running

```bash
npx tsx experiments/qwen3_0.6b/EXP-0002D.1/run_master.ts --port 8080 \
  --evaluator measured --update bayesian
```

Depends on: EXP-0002D (Adaptive Capability)
