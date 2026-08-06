# EXP-0003C.3 — Shadow Feedback (Full-Information Bandit)

> **0003C.2 で発見した「フィードバック非対称性」の仮説を直接検証する実験。**
> **Fixed の勝因は「手設計の重み」ではなく「フル情報フィードバック」にある、という仮説を、
> シャドウ実行 (EXP-0002F) によって学習器に同量の情報を与えて検証する。**

## Core Concept

```
Observation (全ノード実行 = オラクル)
    ↓
Shadow Evaluation (選ばなかったノードも推論)
    ↓
All Experts Reward (全アームの報酬が得られる)
    ↓
Belief Update / Bandit Update (Full Information)
```

2×2 デザイン: **Algorithm {UCB, Thompson} × Feedback {Partial, Shadow}**

| 手法 | 選択則 | フィードバック |
|------|--------|--------------|
| Fixed | 手設計 composite + Belief | フル情報 (ベースライン) |
| UCB Partial | UCB1 (C=2.0) | 選択アームのみ (0003C.2 再現) |
| **UCB Shadow** | UCB1 (C=2.0) | **全アーム更新** ← 処置 |
| Thompson Partial | Beta 事後サンプリング | 選択アームのみ |
| **Thompson Shadow** | Beta 事後サンプリング | **全アーム更新** ← 処置 |

注入: baseline → latency spike (smollm×3) → capability jump (gemma×0.5) × 2 サイクル (120 steps)

## Results (2026-08-02)

### 実測チェックポイント

```
┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐
│ Samples │ Fixed   │ UCB-P   │ UCB-S   │ Thm-P   │ Thm-S   │
├─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤
│      24 │    1.70 │    2.85 │    1.70 │    3.10 │    2.70 │
│      60 │    2.95 │    7.43 │    2.95 │    5.55 │    3.95 │
│     100 │    5.65 │   13.53 │    6.25 │    8.85 │    7.25 │
│     120 │    5.80 │   15.38 │    6.40 │    9.40 │    7.40 │
└─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘

Shadow effect @120 (Fixed との差):
  UCB     : gap=9.58 → 0.60   (closing 94%)
  Thompson: gap=3.60 → 1.60   (closing 56%)
```

> **注**: UCB-Shadow はチェックポイント 24 / 60 で Fixed と**完全一致** (1.70 / 2.95)。

### 冪則フィット & 限界増加率

| Method | a | b | R² | dRegret/dN @120 |
|--------|------|------|------|------|
| Fixed | 0.1325 | 0.7997 | 0.975 | 0.0211/step |
| UCB Partial | 0.0974 | **1.0622** | 0.995 | 0.1006/step |
| UCB Shadow | 0.0815 | 0.9206 | 0.977 | **0.0383/step** |
| Thompson Partial | 0.3684 | 0.6809 | 0.989 | 0.0566/step |
| Thompson Shadow | 0.2706 | 0.6945 | 0.973 | **0.0383/step** |

### N* 推定 (冪則一貫)

```
UCB Partial      : NEVER (b=1.06 > b_fixed=0.80) — 探索コストが線形以上
UCB Shadow       : NEVER (asymptotic)
Thompson Partial : ≈ 5,456 samples
Thompson Shadow  : ≈ 885 samples   ← 6.2倍高速収束
```

## Interpretation

1. **フィードバック非対称性の仮説を支持**: シャドウ実行 (フル情報化) で
   **UCB のギャップが 94% 解消** (9.58 → 0.60)、Thompson の収束推定が **6.2倍高速化**
   (5,456 → 885 サンプル)。探索アルゴリズムではなく「報酬情報量」が 0003C.2 の
   支配要因だったことを実証。

2. **UCB-Shadow が 24/60 チェックポイントで Fixed と完全一致**:
   フル情報 + UCB の選択は、手設計 composite と同程度に最適ノードを特定できる。
   つまり「手設計の重み」は観測情報が揃えば**学習器でも代替可能**。

3. **残差 0.60 は「重みキャリブレーション」の差**:
   フェーズ遷移後 (latency フェーズ) に UCB-Shadow は smollm (遅延注入) を選ぶが、
   Fixed は lat 重み 0.20 で gemma を選ぶ。バンディット報酬の lat 重み (0.10) が
   Fixed より小さいため。→ **LinUCB で特徴量と重みを学習する動機になる**。

4. **Thompson Partial は b=0.68 < Fixed の 0.80** (冪則の下で唯一の交差可能):
   ベイズ探索は集中探索するため部分フィードバックでも漸近効率が良い。
   ただし実用ホライズンでは ~5,456 サンプル必要 → Shadow で 885 に短縮。

5. **設計への示唆 (ArcAsha)**:
   - ルーターは「全ノードへのシャドウ推論」を実行し、**全アームの報酬を観測**する。
   - これは EXP-0002F (Shadow Expert) の拡張 = **フル情報バンディット**。
   - コストは 3 倍の推論だが、正確な状態推定と引き換え (論文のトレードオフ議論)。

## ロードマップ

```
0003C.2 Complexity  → 「サンプル数」でなく「フィードバック構造」が原因と特定
0003C.3 Shadow      → フル情報化で 94% ギャップ解消 ✅
0003C.4 LinUCB      → feature=[capability, latency, cost, stability, memory, temperature]
                       連続特徴 + 重み学習で残差 (キャリブレーション) を埋める ← 次
0003C.5 Neural Bandit
Phase 5 Emergent Controller
```

## Files

- `run_master.ts` — 2×2 (UCB/Thompson × partial/shadow), 120 steps, 5刻み記録
- `output/summary.json` — 実測 series (5 手法)
- `output/complexity_estimates.json` — 冪則フィット + N* 推定
- `output/complexity_curve.png` — フィット曲線プロット
- 分析は `EXP-0003C.2/analyze_complexity.py` (汎用化済み) を使用

## Running

```bash
# Terminal 1: Master
npx tsx experiments/qwen3_0.6b/EXP-0003C.3/run_master.ts --port 8080

# Terminal 2-4: Heterogeneous experts (EXP-0003 のノードを再利用)
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16

# 分析 (汎用化された analyze_complexity.py)
python experiments/qwen3_0.6b/EXP-0003C.2/analyze_complexity.py \
  --input experiments/qwen3_0.6b/EXP-0003C.3/output/summary.json --plot
```

Depends on: EXP-0003C.2 (feedback asymmetry), EXP-0002F (Shadow Expert), EXP-0003C.1 (UCB/Thompson)
