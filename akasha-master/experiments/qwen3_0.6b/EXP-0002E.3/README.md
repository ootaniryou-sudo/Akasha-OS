# EXP-0002E.3 — Adaptive Weight Learning

> **「良い重み」を静的に与えるのではなく、Belief の変化に応じて Weight 自体を学習させる。**
> **Phase 3 (Intelligent Routing) と Phase 4 (Adaptive State Routing) の橋渡し実験。**
> **固定ポリシー vs 手動調整 vs 適応学習の 3 方式比較で「適応の価値」を定量化する。**

## Core Concept

EXP-0002E までは Composite Score の重みは静的パラメータだった。

```
Score = w_cap × Cap(eff) + w_conf × Conf + w_lat × Lat(1−norm) + w_stab × Stab
```

しかし F 系実験で **Stability が動的に変化する** ことが分かった (0.992→0.743)。
Stability が動くなら、最適な重みも動くべきではないか?

```
Observation → Belief (stability) → Weight の学習 → Composite → Routing
```

これが **Adaptive Weight Learning**。

## Hypothesis (検証する仮説)

> **Belief の変化に応じて Weight も適応することで、Router は固定ポリシーよりも
> 高い総合性能 (Routing Accuracy・Latency・Stability) を達成できる。**

特に「ドリフト中に node-onnx の Stability が下がったとき」:
- **Fixed** (capability 偏重 w_cap=0.60): Cap 0.95 が支配的 → ドリフト中の node-onnx を選び続ける (誤り)
- **Manual** (運用者が事前調整 w_stab=0.50): 安定性を重視 → node-onnx2 へ切替 (正解)
- **Adaptive** (Belief から学習): w_stab が不安定性 (1−stab) に比例して上昇 → node-onnx2 へ切替 (正解)

## Adaptive Update Rule

```
risk = 1 − stability          # 不安定性
Δ    = STAB_GAIN × risk       # STAB_GAIN = 0.5
w_stab = min(0.70, base_stab + Δ)
w_cap  = max(0.05, base_cap − Δ × base_cap / (base_cap + base_lat))
w_lat  = max(0.05, base_lat − Δ × base_lat / (base_cap + base_lat))
正規化して合計 = 1
```

- 不安定になるほど w_stab が上がり、w_cap/w_lat から比例配分で減る
- 安定に戻ると w_stab は減衰 (ヒステリシス的挙動 = F.2 と整合)
- 閾値・ルールは不要 — **観測だけで重みが動く**

## Design: 3-Policy Comparison

```
Phase 1 baseline (6):  Main=node-onnx, Shadow=node-onnx2 (同一runtime) → stab≈1.0
Phase 2 drift    (8):  Main=node-onnx, Shadow=node-torch (cross-backend, T=0.8)
                        → 温度サンプリングでドリフトを意図的に増幅 → stab 低下
Phase 3 recovery (8):  Main=node-onnx, Shadow=node-onnx2 → stab 回復

Oracle (ground truth): argmax(cap × stability)
  stab=1.0 時: node-onnx (0.95) > node-onnx2 (0.80) → node-onnx
  stab<0.842時: 0.95×stab < 0.80 → node-onnx2 が正解
```

3 つの重みポリシーを同一の Belief 軌跡に対して同時評価する。

| Policy | w_cap | w_lat | w_stab | 特徴 |
|--------|:---:|:---:|:---:|------|
| **Fixed** | 0.60 | 0.10 | 0.30 | capability 偏重 (静的・ドリフトを見逃しやすい) |
| **Manual** | 0.40 | 0.10 | 0.50 | 運用者が安定性を重視して事前調整 (静的) |
| **Adaptive** | 0.50 | 0.20 | 0.30 | base。Belief から毎ステップ学習 (動的) |

## Results (2026-08-01)

```
Routing Accuracy (vs oracle argmax(cap×stab)):
┌──────────┬──────────────┬────────────┬─────────────────┬───────────────┐
│ Policy   │ Routing Acc  │ Avg Comp   │ Avg Stab (sel)  │ Avg Lat (ms)  │
├──────────┼──────────────┼────────────┼─────────────────┼───────────────┤
│ fixed    │    86% (19/22)│      0.814 │           0.956 │          2197 │
│ manual   │    96% (21/22)│      0.843 │           1.000 │          2145 │
│ adaptive │    96% (21/22)│      0.805 │           1.000 │          2145 │
└──────────┴──────────────┴────────────┴─────────────────┴───────────────┘

Phase-wise Routing Accuracy:
  baseline: Fixed 6/6 | Manual 5/6 | Adaptive 5/6   ← 初回warmupのlatency artifact
  drift   : Fixed 7/8 | Manual 8/8 | Adaptive 8/8   ← Fixed 1ミス
  recovery: Fixed 6/8 | Manual 8/8 | Adaptive 8/8   ← Fixed 2ミス
```

**Adaptive Weight Trajectory (抜粋):**

| Step | Phase | Stab(main) | w_cap | w_stab | w_lat |
|:---:|:---:|:---:|:---:|:---:|:---:|
| 6 | baseline | 1.000 | 0.500 | 0.300 | 0.200 |
| 8 | drift | 0.705 | 0.357 | 0.500 | 0.143 |
| 11 | drift | 0.209 | 0.266 | 0.627 | 0.107 |
| 12 | drift | 0.672 | 0.217 | 0.696 | 0.087 |
| 15 | recovery | 0.371 | 0.250 | 0.650 | 0.100 |
| 22 | recovery | 0.699 | 0.381 | 0.467 | 0.152 |

## Interpretation

1. **仮説 SUPPORTED ✅**: Adaptive (96%) ≥ Fixed (86%)。ドリフト+recoveryで Fixed は 3 ミス、Adaptive は 0 ミス。
2. **重みが Belief を追従**: stab 0.209 で w_stab=0.627 まで上昇、回復とともに 0.467 へ減衰。観測だけで重みが動く。
3. **Fixed の失敗機構**: w_cap=0.60 が Cap 0.95 に強く引っ張られ、stab 低下を score に反映しきれない (P2-001, P3-005, P3-007 で main を誤選択)。
4. **初回ステップの artifact**: P1-000 で manual/adaptive が cand を選んだのは初回推論 warmup latency。Fixed は w_cap 支配で main を選んだため偶然正解。

## The Key Insight: Adaptive matches Manual with ZERO prior knowledge

> **「Adaptive が勝った」ことが価値なのではない。**
> **「事前知識ゼロで、人間が調整した Manual と同じ性能に達した」ことが価値。**

Manual は「ドリフトが来る」と**人間が事前に知っている**状態で重みを調整している:

```
Human (環境変化を知っている)
    ↓
Weight Adjustment (w_stab=0.50 に事前設定)
    ↓
Correct Routing (96%)
```

一方 Adaptive は:

```
Observation (shadow overlap)
    ↓
Belief Update (stability 低下を検知)
    ↓
Weight Learning (w_stab 0.30→0.70 を自動上昇)
    ↓
Routing (96%)
```

**人間の事前知識を使わずに、同じ 96% を達成した。**

これは次のように言い換えられる:

> **Adaptive Weight Learning reproduces the performance of manually tuned
> routing policies without prior knowledge of environmental changes.**

「環境変化がいつ来るか分からない」システムこそ Adaptive の本領。
Manual は「環境がどう変わるか知っている」前提に依存するが、
Adaptive は観測だけで同じ結果を出す。

---

## Figure 1: Weight Trajectory (Belief → Weight Learning)

**w_stab の軌跡** — ドリフトで上昇し、回復で減衰 (ヒステリシス = F.2 と整合):

```
w_stab
0.70 |                          ●  (step12: stab=0.672, w=0.696)
     |                      ●      (step11: stab=0.209, w=0.627)
0.60 |                    ●        (step15: stab=0.371, w=0.650)
     |                   ●
0.50 |             ●              (step8:  stab=0.705, w=0.500)
     |
0.40 |                                   ●  (step22: stab=0.699, w=0.467)
     |
0.30 |● ● ● ● ● ●
     +----------------------------------------------
       Baseline(6)     Drift(8)         Recovery(8)
```

- **Drift 開始**と同時に w_stab が上昇 (Belief の低下を Weight に反映)
- **Recovery 中**も高い値を維持し、ゆっくり減衰 (保守的 = F.2 のヒステリシスと整合)
- 閾値・ルールなし。**観測だけで重みが動く**

この1枚で `Observation → Belief → Weight Learning` が直感的に分かる。

---

## Figure 2: Why Fixed Fails (Mechanism)

P2-001 (stab=0.705) の時点でのスコア計算:

```
        Fixed (w_cap=0.60, w_stab=0.30)          Adaptive (w_stab 学習済み 0.50)
        ─────────────────────────────             ─────────────────────────────
main:   Cap 0.95 × 0.60 = 0.570                  Cap 0.95 × 0.357 = 0.339
        Stab 0.705 × 0.30 = 0.212                Stab 0.705 × 0.500 = 0.353
        Composite ≈ 0.782  ← 勝つ               Composite ≈ 0.692
cand:   Cap 0.80 × 0.60 = 0.480                  Cap 0.80 × 0.357 = 0.286
        Stab 1.000 × 0.30 = 0.300                Stab 1.000 × 0.500 = 0.500
        Composite ≈ 0.780                        Composite ≈ 0.786  ← 勝つ

        → main を誤選択 ✗                        → cand を正しく選択 ✓
```

**Fixed の失敗機構**: Cap 0.95 への固定の強い重み (0.60) が、Stab 0.705 の低下を
スコアに反映しきれない。Stability が低いのに capability の見た目だけで選んでしまう。

**Adaptive の成功機構**: w_stab が 0.30→0.50 に上昇したことで、Stab の差
(0.705 vs 1.000) がスコア差として効くようになり、Composite が逆転する。

> **「どれを重んじるか」を環境に応じて変えられることこそ、Adaptive Weight の本質。**

---

## Phase 4 Completion

```
Observation → Belief → Weight → Routing
```

この閉ループが **実データで完成**した:

| 段階 | 実験 | 成果 |
|------|------|------|
| Observation | 0002F.1 | クロスバックエンド shadow で観測 (88.6% overlap) |
| Belief Update | 0002F.1/F.2 | Stability を更新 (0.992→0.743, ヒステリシス 0.567) |
| Weight Learning | 0002E.3 | w_stab を Belief から学習 (0.30→0.70) |
| Routing | 0002E/0002E.3 | Composite でルーティング (Adaptive 96%) |

**Phase 4 (Adaptive State Routing) 完了。**

次は EXP-0003: 異種エキスパート (Phi/Gemma/SmolLM/Qwen) で Belief が
「ノード単位」から「ノード × タスク」へ拡張されるかを検証する。

## Success Criteria

- [x] 3 方式 (Fixed / Manual / Adaptive) を比較
- [x] 仮説検証: Adaptive ≥ Fixed を実証 (96% ≥ 86%)
- [x] 重み軌跡をステップ単位でログ (Step/Cap/Stab/Lat/w_cap/w_stab/w_lat)
- [x] ドリフト注入を温度で制御 (T=0.8 で増幅)
- [x] Weight が Belief に追従することを実証

## Phase 4 Thread

```
0002F   Shadow Loop
  ↓
0002F.1 Belief Update (drift: 0.992→0.743) ✅
  ↓
0002F.2 Recovery Dynamics + Hysteresis (0.567) ✅
  ↓
0002E.3 Adaptive Weight Learning ← 現在地 ✅
  → Weight も Belief に応じて学習される (二重適応)
  ↓
0003    Heterogeneous Experts
  → Belief と Weight の両方を異種エキスパート群で検証
```

## Research Value

> **Static Knowledge → Observed Evidence → Belief Update → Weight Learning → Routing**
>
> ルーターは「何を重んじるか」(Weight) も、観測から学習できる。
> これは適応システムの最終形態: **重みは制御変数であり、学習対象でもある。**

## Running

```bash
# Terminal 1: Master
npx tsx experiments/qwen3_0.6b/EXP-0002E.3/run_master.ts --port 8080

# Terminal 2: Main (expert)
npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts --master ws://localhost:8080 \
  --node-id node-onnx --backend onnx --precision fp16 \
  --capability '{"coding":0.95,"math":0.65,"general":0.80}'

# Terminal 3: Candidate (generalist)
npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts --master ws://localhost:8080 \
  --node-id node-onnx2 --backend onnx --precision fp16 \
  --capability '{"coding":0.80,"math":0.60,"general":0.75}'

# Terminal 4: Drift shadow (PyTorch MPS)
python experiments/qwen3_0.6b/EXP-0002F.1/run_node_pytorch.py \
  --master ws://localhost:8080 --node-id node-torch --precision fp16
```

Depends on: EXP-0002F.1 (Cross-Backend Shadow), EXP-0002F.2 (Hysteresis), EXP-0002E (Composite Score)
