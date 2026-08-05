# ArcAsha Benchmark Report

- version: 1.0.0
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