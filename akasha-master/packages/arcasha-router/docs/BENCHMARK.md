# ベンチマーク — ODAR (LinUCB-Shadow) vs Random / UCB / Fixed

> 実ノード 3 エキスパート (Qwen3-0.6B / SmolLM2-360M / Gemma-3-1B-it) × 3 シード。
> 論文 (Zenodo 10.5281/zenodo.21755612) の EXP-0003D の条件で再現。

## 実機ベンチマーク (2026-08-03, 9 タスク × 3 seed)

| Router | Avg Quality | Cum. Regret | 備考 |
|---|---|---|---|
| **LinUCB-Shadow (ODAR)** | **0.646** | **1.200** | 最高品質 + 最小リグレット |
| Fixed (q:0.6, lat:0.2, c:0.05, s:0.15) | 0.632 | 1.450 | 手設計重み |
| Random | 0.542 | 4.650 | 非学習ベースライン |
| RoundRobin | 0.542 | 4.350 | 非学習ベースライン |
| UCB-Shadow | 0.514 | 4.400 | シャドウでも素朴な報酬最大化は危険 (EXP-0003E) |

**Key takeaway**: 特徴量学習 + フル情報 (シャドウ) の組み合わせだけが
「安くて速いが弱い」モデルへの誘惑を回避しつつ Oracle に近づく。

## クロス言語再現性 (60 steps, 同条件)

| Router | TypeScript | Python |
|---|---|---|
| LinUCB-Shadow | 0.000 | 0.000 |
| UCB-Shadow | 0.500 | 0.500 |
| Random | 17.100 | 17.100 |

## 統計的検証 (EXP-0003D, 30 seeds × 120 steps, Set A)

| 比較 | 平均差 | p | Cohen's d |
|---|---|---|---|
| LinUCB-S vs Fixed | -0.70 | **0.020** | -0.49 (中効果) |
| LinUCB-S vs UCB-S | — | **<0.001** | -1.10 (大効果) |
| UCB-P (部分情報) vs Fixed | +9.63 | <0.001 | 4.86 |

## モデル一般化 (EXP-0003E, Set B: Qwen2.5-Coder-0.5B / SmolLM2-135M / Llama-3.2-1B)

- LinUCB-S vs Fixed: **-1.59, p<0.001, d=-0.88 (大効果)** — 一般化確立
- UCB-S vs Fixed: **有意に悪い (p<0.001, d=1.28)** — 危険性を再現

## アブレーション (EXP-0003F)

- **capability 特徴を除去 → Regret +37.6% (p<0.001)** — ODAR の本質は能力推定
- confidence/cost/memory/temperature 除去: ~0 効果 (n.s.)

## 再現手順

```bash
# 実機ベンチ (要 WS ノード 3 台):
npx tsx src/arcasha/benchmark/run_benchmark.ts --seed 0 --seed 1 --seed 2

# クロス言語 (モック, 依存なし):
cd packages/arcasha-router && npm test
cd ../arcasha-router-py && python demo.py
```
