# ArcAsha Benchmark Report

- date: 2026-08-02T13:07:10.484Z
- experts: Qwen/Qwen3-0.6B, HuggingFaceTB/SmolLM2-360M-Instruct, unsloth/gemma-3-1b-it
- seeds: 3
- warmup: 24 | eval: 9

#### seed=0 (warmup=24, eval=9)

| 手法 | meanScore | passRate | cumRegret | lat(ms) |
|---|---|---|---|---|
| LinUCB-Shadow (ArcAsha) | 0.646 | 0.861 | 1.200 | 2138 |
| Fixed | 0.632 | 0.917 | 1.450 | 2018 |
| Random | 0.542 | 0.778 | 4.650 | 2190 |
| RoundRobin | 0.542 | 0.861 | 4.350 | 2353 |
| UCB-Shadow | 0.514 | 0.917 | 4.400 | 1835 |

#### seed=1 (warmup=24, eval=9)

| 手法 | meanScore | passRate | cumRegret | lat(ms) |
|---|---|---|---|---|
| LinUCB-Shadow (ArcAsha) | 0.646 | 0.861 | 1.200 | 2138 |
| Fixed | 0.632 | 0.917 | 1.450 | 2018 |
| Random | 0.542 | 0.778 | 4.650 | 2190 |
| RoundRobin | 0.542 | 0.861 | 4.350 | 2353 |
| UCB-Shadow | 0.514 | 0.917 | 4.400 | 1835 |

#### seed=2 (warmup=24, eval=9)

| 手法 | meanScore | passRate | cumRegret | lat(ms) |
|---|---|---|---|---|
| LinUCB-Shadow (ArcAsha) | 0.646 | 0.861 | 1.200 | 2138 |
| Fixed | 0.632 | 0.917 | 1.450 | 2018 |
| Random | 0.542 | 0.778 | 4.650 | 2190 |
| RoundRobin | 0.542 | 0.861 | 4.350 | 2353 |
| UCB-Shadow | 0.514 | 0.917 | 4.400 | 1835 |

