# EXP-0002D.1 — Task Evaluator Improvement

> **評価関数の忠実度が Routing Quality の上限を決定する。**
> **EXP-0002D で発見された Score Inversion の根本原因に対処する。**
> **評価関数そのものの精度改善を独立した研究対象として扱う。**

## Research Thread

```
0002D.1 (Evaluator) → 0002E (Composite Score) → 0002F (Shadow Feedback)
     │                       │                          │
     ▼                       ▼                          ▼
 測定の精度向上         EXP-0001 Stability 活用    高品質フィードバック源
```

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

## Capability Estimation: Phased Approach

```
Phase 1: EMA / SMA (current 0002D)
  └── 単純、即時反映、ただし overshoot しやすい

Phase 2: Bayesian Mean
  └── サンプル数で自然に重み付け、overshoot 抑制

Phase 3: Bayesian + Confidence Interval
  └── 区間推定、Router が Confidence を考慮可能

Phase 4: Context-Aware Capability
  └── タスク難易度・ドメイン類似度でスコアを文脈化
```

### Phase 2: Bayesian Mean (MVP for 0002D.1)

```
n = sample_count
μ = current_mean

After new observation x:
  μ_new = (n × μ + x) / (n + 1)
  n_new = n + 1

Confidence = 1 − exp(−n / min_samples)
Effective Score = μ_new × confidence
```

### Why Phased

```
最初から複雑なベイズ推定を入れるより、段階的に進める方が
実験ごとの効果が見えやすく、各段階での知見を蓄積できる。
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
