# EXP-0004 — Active Expert Scaling

> **「Active 層可変」— Expert 数を動的に変えて品質とコストの関係を測る。**

## Objective

同一ベンチマークを 1/2/4/8/16 Experts で解き、品質・遅延・コストの scaling 特性を定量化する。

## Design

```
Expert Count → Quality, Latency, Network, Cost, Active Params

1 Expert
2 Experts
4 Experts
8 Experts
16 Experts
```

## Metrics

| Metric | Description |
|--------|-------------|
| `quality_score` | Benchmark accuracy / F1 / BLEU |
| `latency_p50/p95/p99` | End-to-end latency distribution |
| `network_bytes` | Total bytes transferred |
| `active_params` | Sum of active parameters across experts |
| `cost_per_query` | Estimated compute cost |
| `scaling_efficiency` | quality_gain / expert_count_increase |

## Hypothesis

```
More experts → higher quality (diminishing returns)
More experts → higher latency (parallel → sub-linear)
More experts → higher cost (linear)
Optimal point: quality/latency knee
```

## Running

```bash
npx tsx experiments/qwen3_0.6b/EXP-0004/run_scaling.ts \
  --expert-counts 1,2,4,8,16 \
  --benchmark mmlu_subset
```
