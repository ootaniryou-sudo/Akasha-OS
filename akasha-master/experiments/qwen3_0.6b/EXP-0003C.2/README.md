# EXP-0003C.2 — Sample Complexity Estimation

> **0003C.1 の結果 (UCB/Thompson は Q-Learning より2-3倍サンプル効率だが 60 サンプルでは
> Fixed 未達) を受けて、収束に必要なサンプル数 N\* を「実測 + 曲線フィット」で推定する。**

## Core Concept

累積 Regret は環境が周期的でも単調増加するため、**冪則 $Regret(N) = aN^b$** が累積 Regret の
漸近構造を正しく表現する。全手法を同じ冪則でフィットし、**Fixed を下回るのに必要なサンプル数
$N^*$** を一貫して推定する。

```
実測 (N=5..120, 5刻み, 25点)
    ↓
冪則フィット Regret(N) = a·N^b  (全手法共通)
    ↓
指数 b の比較 → 漸近的交差の判定 (b_method < b_fixed なら交差可能)
```

> **Empirical Observation 1 (論文用フレーミング)**: 学習対象が weights → state → policy と
> 深くなるにつれ、Fixed を超えるのに必要な観測数が一貫して増加した
> (weight ~0 / state ~6 / policy >60)。C.2 はその「定量的な外挿」を試みる。

## Methods

| 手法 | フィットモデル | 役割 |
|------|--------------|------|
| Fixed | $aN^b$ (冪則) | ベースライン (フル情報フィードバック) |
| Q-Learning | $aN^b$ (冪則) | ε-greedy (部分フィードバック) |
| UCB1 | $aN^b$ (冪則) | 楽観的探索 (部分フィードバック) |
| Thompson | $aN^b$ (冪則) | ベイズ探索 (部分フィードバック) |

注入: baseline → latency spike (smollm×3) → capability jump (gemma×0.5) を **2 サイクル** (120 steps)

## Results (2026-08-02)

### 実測チェックポイント

```
┌─────────┬─────────┬──────────┬──────────┬──────────┐
│ Samples │ Fixed   │ Q-Learn  │ UCB      │ Thompson │
├─────────┼─────────┼──────────┼──────────┼──────────┤
│      24 │    2.10 │     5.40 │     4.15 │     2.70 │
│      60 │    3.35 │    12.95 │     7.80 │     6.68 │
│     100 │    6.05 │    21.30 │    12.55 │    10.53 │
│     120 │    6.20 │    24.70 │    14.15 │    10.68 │
└─────────┴─────────┴──────────┴──────────┴──────────┘
```

### 冪則フィット (N=5..120, 25点)

| Method | a | b | R² | R(120) |
|--------|------|--------|------|--------|
| Fixed | 0.1801 | **0.7497** | 0.972 | 6.52 |
| Q-Learning | 0.2774 | 0.9436 | 0.994 | 25.41 |
| UCB1 | 0.2698 | 0.8293 | 0.990 | 14.30 |
| Thompson | 0.1869 | 0.8619 | 0.987 | 11.58 |

### 限界増加率 (実測, N=120 時点)

```
Fixed     : 0.021/step   ← 最小
Thompson  : 0.038/step   (Fixed の ~2x)
UCB1      : 0.099/step   (Fixed の ~5x)
Q-Learning: 0.167/step   (Fixed の ~8x)
```

### N* 推定 (冪則一貫)

```
Q-Learning  : NEVER (asymptotic) — b=0.944 > b_fixed=0.750
UCB1        : NEVER (asymptotic) — b=0.829 > b_fixed=0.750
Thompson    : NEVER (asymptotic) — b=0.862 > b_fixed=0.750
```

## Interpretation

1. **探索効率の順位は維持** (限界増加率): Thompson (0.038) < UCB (0.099) < Q (0.167)。
   0003C.1 の「UCB/Thompson は Q-Learning より2-3倍サンプル効率」を確認。

2. **Fixed の漸近指数 (b=0.750) が全学習器より小さい**。冪則の外挿の下では、学習器は
   漸近的に Fixed を**追い越せない**。これは Empirical Observation 1 の深化:
   「Policy 学習は単に >60 サンプル必要なだけでなく、この環境では**構造的な漸近ギャップ**を持つ」。

3. **フィードバック非対称性の発見 (重要な解釈)**:
   - **Fixed**: オラクル計算により**全ノードの結果を毎ステップ観測** (フル情報フィードバック)。
     ベイズ信念 μ×confidence が完全情報で更新される。
   - **バンディット学習器**: **選択したアームの報酬のみ**観測 (部分フィードバック)。
   - つまり「Fixed の勝因」の一部は、手設計の重みの質ではなく
     **フル情報フィードバックの優位性**にある可能性が高い。
   - → **EXP-0002F (Shadow Expert) と組み合わせれば、学習器もフル情報にできる**。
     これが次の実験 (LinUCB + shadow) の動機になる。

4. **Caveat**: N* は「実測ではなく推定」。冪則の外挿に依存し、指数 b には不確実性がある。
   また周期環境 (フェーズ繰り返し) では、学習器が環境を完全に学習すれば漸近指数は低下しうる。
   より長い実測 (600 samples = 10 サイクル) で外挿の妥当性を確認できる。

## ロードマップへの示唆

```
0003C.1 Bandit      → 探索効率は 2-3x 改善。しかし Fixed 未達
0003C.2 Complexity  → 漸近ギャップは「サンプル数」だけでなく「フィードバック構造」が原因
0003C.3 LinUCB      → Context (lat/cap/stab/cost) を連続特徴で扱う
                      + Shadow (EXP-0002F) でフル情報フィードバック化 ← 次
0003C.4 Neural Bandit
```

## Files

- `run_master.ts` — 120 steps, 5刻みで累積 Regret を記録 (全手法)
- `analyze_complexity.py` — 冪則/指数飽和フィット, 限界増加率, N* 推定, プロット
- `output/summary.json` — 実測 series (N=5..120)
- `output/complexity_estimates.json` — フィット結果 + N* 推定
- `output/complexity_curve.png` — フィット曲線 + 指数のプロット

## Running

```bash
# Terminal 1: Master
npx tsx experiments/qwen3_0.6b/EXP-0003C.2/run_master.ts --port 8080

# Terminal 2-4: Heterogeneous experts (EXP-0003 のノードを再利用)
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16
python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py \
  --master ws://localhost:8080 --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16

# 分析
python experiments/qwen3_0.6b/EXP-0003C.2/analyze_complexity.py --plot
```

Depends on: EXP-0003C.1 (Contextual Bandit), EXP-0003C (Policy Learning), EXP-0002F (Shadow Expert, 次の動機)
