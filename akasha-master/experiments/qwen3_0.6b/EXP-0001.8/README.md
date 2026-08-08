# EXP-0001.8 — Replication

> **BF16 の 20.9% 分岐は再現するか？ 同一条件で複数回実行して検証する。**

## Objective

EXP-0001.7 で観測された MPS 上の BF16 分岐率 20.9% の再現性を確認する。

同一 Mac・同一モデル・同一プロンプトで 5〜10 run 実行し、分岐率の分散を測定する。

## Hypothesis

BF16 divergence rate on MPS is stable across runs (σ < 2%).

If confirmed → the measurement is reliable and can be used as a Node profile.  
If not confirmed → platform variability is higher than expected; need per-run calibration.

## Design

### Fixed Conditions
- Model: `Qwen/Qwen3-0.6B`
- Platform: macOS arm64, Apple Silicon MPS
- Prompts: 50 (same as EXP-0001.7)
- Temperature: 0 (greedy, deterministic)
- Max tokens: 32

### Runs
- 5 runs minimum, 10 runs preferred
- Each run: FP32 reference + BF16 + FP16
- Compare: FP32→BF16, FP32→FP16 for each run

### Metrics per Run
```
run_id
bf16_divergence_rate
bf16_mean_first_divergence
bf16_top5_overlap
bf16_kl_mean
fp16_divergence_rate
fp16_top5_overlap
```

### Analysis
```
bf16_div_rate: mean, std, min, max across runs
fp16_div_rate: mean, std, min, max across runs
→ Is σ < 2%?
→ Are the rankings (fp16 < bf16) stable?
```

## Output

```
EXP-0001.8/output/
├── manifest.json
├── replication.json        # All runs summary
├── run_001/
│   ├── bf16_vs_fp32/summary.json
│   └── fp16_vs_fp32/summary.json
├── run_002/ ...
└── RESULTS.md
```

## Success Criteria

- [ ] 5+ runs completed
- [ ] BF16 divergence rate σ < 2% across runs
- [ ] FP16 consistently outperforms BF16 on all runs
- [ ] Platform profile is stable enough for Router integration

## Running

```bash
cd experiments/qwen3_0.6b/EXP-0001.8
python run_replication.py --runs 10 --prompts ../EXP-0001.7/prompts_50.jsonl
```

