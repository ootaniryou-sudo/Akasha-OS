#!/usr/bin/env python3
"""
EXP-0003D — Statistical Validation

run_master.ts の multi-seed 出力 (output/summary.json) から、
各手法の累積 Regret の統計を計算する:

  - 平均 / 標準偏差 / 95% 信頼区間 (t 分布, 小標本)
  - 対応あり Wilcoxon signed-rank test (各学習器 vs Fixed, および vs UCB-Shadow)
  - 効果量: Cohen's d (paired), Cliff's delta

シード = ワークロード乱数化 (タスク順 / プロンプト / 初期アーム順)。
LLM 出力は決定論的 (T=0) のためキャッシュされており、
ばらつきはワークロード系列の違いに由来する。

Usage:
  python experiments/qwen3_0.6b/EXP-0003D/analyze_statistics.py \
      [--input experiments/qwen3_0.6b/EXP-0003D/output/summary.json]
"""

import argparse
import json
import os

import numpy as np
from scipy import stats


def t_ci(x, alpha=0.05):
    """mean, std, and (1-alpha) CI via t-distribution."""
    x = np.asarray(x, dtype=float)
    n = len(x)
    mean = float(np.mean(x))
    std = float(np.std(x, ddof=1)) if n > 1 else 0.0
    if n <= 1:
        return mean, std, mean, mean
    tval = stats.t.ppf(1 - alpha / 2, df=n - 1)
    se = std / np.sqrt(n)
    return mean, std, mean - tval * se, mean + tval * se


def cohens_d_paired(a, b):
    a = np.asarray(a, dtype=float); b = np.asarray(b, dtype=float)
    d = a - b
    sd = np.std(d, ddof=1)
    if sd == 0:
        return 0.0
    return float(np.mean(d) / sd)


def cliffs_delta(a, b):
    a = np.asarray(a, dtype=float); b = np.asarray(b, dtype=float)
    n = len(a)
    if n == 0:
        return 0.0
    gt = sum(1 for x in a for y in b if x > y)
    lt = sum(1 for x in a for y in b if x < y)
    return float((gt - lt) / (n * n))


def fmt_p(p):
    if p < 0.001:
        return "<0.001"
    return f"{p:.3f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="experiments/qwen3_0.6b/EXP-0003D/output/summary.json")
    args = ap.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    seeds = data["seeds"]
    methods = data["config"]["methods"]
    labels = {
        "fixed": "Fixed", "ucb_partial": "UCB-P", "ucb_shadow": "UCB-S",
        "linucb_partial": "LinUCB-P", "linucb_shadow": "LinUCB-S",
    }
    label = lambda m: labels.get(m, m)
    n_seeds = len(seeds)

    R = {m: np.array([s["regrets"][m] for s in seeds], dtype=float) for m in methods}

    print("═" * 78)
    print("EXP-0003D — Statistical Validation")
    print("═" * 78)
    print(f"  seeds    : {n_seeds}")
    print(f"  steps    : {data['config']['total_steps']}")
    print(f"  seed def : {data['config'].get('seed_definition', '-')}")
    print()

    # ── 基本統計 ──
    print("  Method        Mean    Std    95% CI")
    print("  " + "-" * 60)
    stats_out = {}
    for m in methods:
        mean, std, lo, hi = t_ci(R[m])
        stats_out[m] = {"mean": round(mean, 3), "std": round(std, 3),
                        "ci95_lo": round(lo, 3), "ci95_hi": round(hi, 3)}
        print(f"  {label(m):<14} {mean:>6.3f} {std:>6.3f}  [{lo:.3f}, {hi:.3f}]")
    print()

    # ── ペアごとの検定 (vs Fixed) ──
    print("  Paired test vs Fixed (Wilcoxon signed-rank + Cohen's d + Cliff's delta):")
    print("  " + "-" * 78)
    print(f"  {'Pair':<24} {'mean diff':>9} {'p (Wilcoxon)':>13} {'d (Cohen)':>9} {'Cliff':>7}")
    tests = {}
    for m in methods:
        if m == "fixed":
            continue
        d = R[m] - R["fixed"]
        mean_diff = float(np.mean(d))
        # Wilcoxon signed-rank (対応あり, 0 を除く)
        try:
            p = stats.wilcoxon(R[m], R["fixed"]).pvalue
        except ValueError:
            p = float("nan")
        cd = cohens_d_paired(R[m], R["fixed"])
        cliff = cliffs_delta(R[m], R["fixed"])
        tests[m] = {"vs": "fixed", "mean_diff": round(mean_diff, 3), "p": p,
                    "cohens_d": round(cd, 3), "cliffs_delta": round(cliff, 3)}
        print(f"  {label(m)+' - Fixed':<24} {mean_diff:>+9.3f} {fmt_p(p):>13} {cd:>9.3f} {cliff:>7.3f}")
    print()

    # ── LinUCB-Shadow vs UCB-Shadow (0003C.3→C.4 の因果) ──
    print("  Paired test LinUCB-S vs UCB-S (feature learning effect):")
    print("  " + "-" * 78)
    if "linucb_shadow" in methods and "ucb_shadow" in methods:
        d = R["linucb_shadow"] - R["ucb_shadow"]
        try:
            p = stats.wilcoxon(R["linucb_shadow"], R["ucb_shadow"]).pvalue
        except ValueError:
            p = float("nan")
        cd = cohens_d_paired(R["linucb_shadow"], R["ucb_shadow"])
        cliff = cliffs_delta(R["linucb_shadow"], R["ucb_shadow"])
        tests["linucb_shadow_vs_ucb_shadow"] = {"vs": "ucb_shadow",
            "mean_diff": round(float(np.mean(d)), 3), "p": p,
            "cohens_d": round(cd, 3), "cliffs_delta": round(cliff, 3)}
        print(f"  {'LinUCB-S - UCB-S':<24} {float(np.mean(d)):>+9.3f} {fmt_p(p):>13} {cd:>9.3f} {cliff:>7.3f}")
    print()

    # ── 生データ (シード毎) ──
    print("  Per-seed cumulative regret @120:")
    print("  " + "-" * 78)
    hdr = "  seed".ljust(8) + "".join(f"{label(m):>12}" for m in methods)
    print(hdr)
    for s in seeds:
        row = f"  {s['seed']:<6}" + "".join(f"{s['regrets'][m]:>12.3f}" for m in methods)
        print(row)
    print()

    # ── 解釈 ──
    lm = R["linucb_shadow"] if "linucb_shadow" in methods else None
    fx = R["fixed"]
    if lm is not None:
        win = int(np.sum(lm < fx))
        print(f"  LinUCB-Shadow が Fixed を下回ったシード: {win}/{n_seeds}")
        print(f"  Fixed 平均 {np.mean(fx):.3f} vs LinUCB-Shadow 平均 {np.mean(lm):.3f} "
              f"(差 {np.mean(fx)-np.mean(lm):+.3f})")
    print()

    out = {
        "experiment": "EXP-0003D",
        "n_seeds": n_seeds,
        "method_stats": stats_out,
        "paired_tests": tests,
        "note": "Seeds = workload randomization (task order / prompt / initial arm order). "
                "LLM outputs deterministic (T=0) and cached.",
    }
    out_dir = os.path.dirname(os.path.abspath(args.input))
    out_path = os.path.join(out_dir, "statistics.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"  📁 {out_path}")


if __name__ == "__main__":
    main()

