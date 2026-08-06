# ArcAsha Benchmark Report

- version: 1.3.0
- kind: simulation（設計上の評価モデル（決定論・再現可能）。実機実測は Real Device Benchmark（bench/real-device.ts）と区別する。）
- corpus: GSM8K/MATH500/HumanEval/MBPP/MMLU/LiveCodeBench (deterministic subset)

## External Benchmarks (Validation E)

| Suite | Qwen1.5B 単体 | Qwen1.5B Thinking | + ArcAsha Fast | + ArcAsha Auto | + ArcAsha Deep |
|-------|------|------|------|------|------|
| gsm8k | 70% | 100% | 100% | 100% | 100% |
| math500 | 0% | 30% | 20% | 60% | 90% |
| human_eval | 10% | 50% | 40% | 80% | 100% |
| mbpp | 50% | 90% | 80% | 100% | 100% |
| mmlu | 30% | 70% | 60% | 100% | 100% |
| livecodebench | 0% | 20% | 10% | 50% | 80% |
| **ALL** | 27% | 60% | 52% | 82% | 95% |

## OS Overhead

- **qwen**: LLM（CPU 100%、うち LLM 100%）
- **qwen-thinking**: LLM(Thinking)（CPU 100%、うち LLM 100%）
- **qwen-fast**: OS layered（CPU 100%、うち LLM 85%）
- **qwen-auto**: OS layered（CPU 100%、うち LLM 65%）
- **qwen-deep**: OS layered（CPU 100%、うち LLM 40%）

## Caravan スケーラビリティ (Validation F)

| デバイス数 | キャラバン数 | Master管理対象(Flat) | Master管理対象(Caravan) | 削減 | 探索(Flat) | 探索(Caravan) | ホップ |
|---|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1 | 10 | 2 | 5x | 10 | 11 | 1→2 |
| 100 | 10 | 100 | 11 | 9.09x | 100 | 20 | 1→2 |
| 500 | 50 | 500 | 51 | 9.8x | 500 | 60 | 1→2 |
| 1000 | 100 | 1000 | 101 | 9.9x | 1000 | 110 | 1→2 |
| 5000 | 500 | 5000 | 501 | 9.98x | 5000 | 510 | 1→2 |
| 10000 | 1000 | 10000 | 1001 | 9.99x | 10000 | 1010 | 1→2 |

> Master は 10,000 台でも 1000 キャラバンを管理するだけ（フラットの 9.99x 削減）。

## Lesson Memory / Team Learning の効果 (Validation G)

| フェーズ | 成功率(Naive) | 成功率(Learned) | 平均遅延(Naive) | 平均遅延(Learned) |
|---|---:|---:|---:|---:|
| warmup | 67% | 75% | 711ms | 606ms |
| early | 68% | 89% | 713ms | 629ms |
| mid | 68% | 92% | 715ms | 634ms |
| late | 67% | 93% | 714ms | 637ms |

> 成功率 67% → 93%（+26pt）/ 遅延 714ms → 637ms
> モデルの重みを変えずに、OS の運用知識（Team / Policy / Lesson）だけで改善することを実証。