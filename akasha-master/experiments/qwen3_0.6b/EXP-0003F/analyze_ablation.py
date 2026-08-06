#!/usr/bin/env python3
"""
EXP-0003F — Feature Ablation Analysis

LinUCB-Shadow の特徴量アブレーション結果 (output/summary.json) から、
各特徴を除去したときの Regret 変化を定量化する。

- 各バリアントの平均 Regret (30 seeds) と 95% CI
- フル vs 各除去の ΔRegret (絶対値と %)
- 有意性 (Wilcoxon signed-rank: 各除去 vs フル)
- 重要度ランキング (ΔRegret 降順)

Usage:
  python experiments/qwen3_0.6b/EXP-0003F/analyze_ablation.py \
      [--input experiments/qwen3_0.6b/EXP-0003F/output/summary.json]
"""

import argparse
import json
import os

import numpy as np
from scipy import stats


def t_ci(x, alpha=0.05):
    x = np.asarray(x, dtype=float)
    n = len(x)
    mean = float(np.mean(x))
    std = float(np.std(x, ddof=1)) if n > 1 else 0.0
    if n <= 1:
        return mean, std, mean, mean
    tval = stats.t.ppf(1 - alpha / 2, df=n - 1)
    se = std / np.sqrt(n)
    return mean, std, mean - tval * se, mean + tval * se


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="experiments/qwen3_0.6b/EXP-0003F/output/summary.json")
    args = ap.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    seeds = data["seeds"]
    methods = data["config"]["methods"]
    variants = {v["key"]: v for v in data["config"]["variants"]}
    feature_names = data["config"]["feature_names"]
    full_key = "linucb_full"
    fixed_key = "fixed"

    R = {m: np.array([s["regrets"][m] for s in seeds], dtype=float) for m in methods}

    print("═" * 78)
    print("EXP-0003F — Feature Ablation Analysis")
    print("═" * 78)
    print(f"  seeds   : {len(seeds)}")
    print(f"  features: {feature_names}")
    print()

    # ── 基本統計 ──
    print("  Method         Mean    Std    95% CI        Δ vs full")
    print("  " + "-" * 66)
    means = {}
    for m in methods:
        mean, std, lo, hi = t_ci(R[m])
        means[m] = mean
        if m == full_key:
            print(f"  {m:<15} {mean:>6.3f} {std:>6.3f}  [{lo:.3f}, {hi:.3f}]   (baseline)")
        elif m == fixed_key:
            print(f"  {m:<15} {mean:>6.3f} {std:>6.3f}  [{lo:.3f}, {hi:.3f}]")
        else:
            d = mean - means[full_key]
            print(f"  {m:<15} {mean:>6.3f} {std:>6.3f}  [{lo:.3f}, {hi:.3f}]   {d:+.3f} ({d/means[full_key]*100:+.1f}%)")
    print()

    # ── アブレーション表: 除去した特徴ごと ──
    print("  Feature removed   ΔRegret(abs)  ΔRegret(%)  p (vs full)  importance")
    print("  " + "-" * 68)
    rows = []
    for v in variants.values():
        key = v["key"]
        if key == full_key:
            continue
        ridx = v["remove"]
        fname = feature_names[ridx]
        d = means[key] - means[full_key]
        try:
            p = stats.wilcoxon(R[key], R[full_key]).pvalue
        except ValueError:
            p = float("nan")
        pct = d / means[full_key] * 100
        rows.append((fname, key, d, pct, p))
    rows.sort(key=lambda r: r[2], reverse=True)  # ΔRegret 降順 = 重要度降順
    for rank, (fname, key, d, pct, p) in enumerate(rows, 1):
        print(f"  {fname:<16} {d:>+9.3f}  {pct:>+8.1f}%  "
              f"{('<' + '%.3f' % p) if p < 0.001 else ('%.3f' % p):>10}  #{rank}")
    print()

    print("  → ΔRegret が大きいほど、その特徴の寄与が大きい。")
    print("    (capability 除去が最大なら「能力推定」が LinUCB 優位の主因)")
    print()

    # ── 解釈 ──
    if rows:
        top = rows[0]
        print(f"  最重要特徴: {top[0]} (除去で ΔRegret {top[2]:+.3f}, {top[3]:+.1f}%)")
        low = rows[-1]
        print(f"  最軽微特徴: {low[0]} (除去で ΔRegret {low[2]:+.3f}, {low[3]:+.1f}%)")
    print()

    out = {
        "experiment": "EXP-0003F",
        "mean_regret": {m: round(means[m], 3) for m in methods},
        "ablation": [
            {"feature": fn, "variant": key, "delta_regret": round(d, 3),
             "delta_pct": round(pct, 2), "p": p, "rank": rank}
            for rank, (fn, key, d, pct, p) in enumerate(rows, 1)
        ],
    }
    out_dir = os.path.dirname(os.path.abspath(args.input))
    out_path = os.path.join(out_dir, "ablation.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"  📁 {out_path}")


if __name__ == "__main__":
    main()
