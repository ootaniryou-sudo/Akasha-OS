# AI Reasoning Runtime — Hypothesis SSA / Reasoning Graph

> **MoE が Transformer 内部で暗黙に行う探索を、OS レベルで明示的に管理・最適化するアーキテクチャ（第4の柱）**

| 項目 | 値 |
|------|-----|
| Status | **Spec v0.1（Phase 2.4 実装済み）** |
| Date | 2026-08-05 |
| 実装 | `src/arcasha/ailsm/reasoning.ts`, `reasoning-runtime.ts` |
| 関連 | `ARCASHA_V2_SPEC.md`, `AILSM_IR.md`（v1.4）, `AILSA_RUNTIME.md`, `AI_VIRTUAL_MEMORY.md`, `AI_EVALUATION.md` |

---

## 0. 動機 — 創発的知能は OS だけでは生まれない

```
Linux = プロセス管理できる / LLVM = コンパイルできる / Scheduler = CPU を割り振れる
→ でも Photoshop や GPT は生まれない
```

**OS = 知能ではない**。創発的知能は **Expert 同士の循環**（数学 → 論理 → 仮説 → 自己否定 → 検索 → 数学…）で生まれる。

GPT/MoE はこれを Transformer 内部で**暗黙に**行う。ArcAsha は **OS（プロセス / SSA）で明示的に管理**する — これが本研究の新規性。

## 1. Hypothesis SSA

新ノード種別 `Hypothesis#N`:

```
Hypothesis #1 "x=3"           confidence=0.43
Hypothesis #2 "x=-3"          confidence=0.61
Hypothesis #3 "場合分けが必要"  confidence=0.54
```

- `Belief`（確信度）と違い、**生成・競争・淘汰・統合の対象**になる
- state: proposed → active → accepted / rejected / merged / killed
- edge: `task hypothesizes hypothesis`

| 操作 | 関数 | 意味 |
|------|------|------|
| SPAWN | `hypothesize` | 仮説を生成（task hypothesizes hypothesis） |
| EVALUATE | `activate` / `evaluate` | Expert に評価させ、score を記録 |
| ACCEPT | `accept` | Reflection の judge で採用 |
| KILL / REJECT | `kill` / `reject` | 淘汰 |
| MERGE | `merge` | 複数仮説を統合（元は merged、新仮説を SPAWN） |

## 2. Reasoning Graph Runtime

`reasoning-runtime.ts` — 仮説ビーム探索を OS が管理。

```
Planner
  → SPAWN（仮説生成）
  → EVALUATE（各仮説 = 独立 AI Process = OS レベルの並列）
  → REFLECTION（Score → ACCEPT / KILL / MERGE）
  → 新仮説 SPAWN → … → 収束
```

- **一本道ではない**: 分岐・循環・統合がある（Reasoning Graph）
- **各仮説は別プロセス**: Math A / Math B / Math C を並列実行（OS 的には `createProcess`）
- Reflection が「A はダメ / B が良い / C は途中まで採用」を判断

## 3. デモ結果（x^2=9）

```
=== Reasoning Graph ===
Round 0:
  #3 [math]      "x=3 が解"      score=0.80
  #5 [math]      "x=-3 が解"     score=0.80
  #7 [reasoning] "平方完成で考える" score=0.20
  ACCEPT: #3, #5
  KILL  : #7
  MERGE : #3,#5 → #9 "x=±3"
FINAL  : x=±3 (conf=0.60)
Expert : 3 calls / Processes: 3
```

- 2 つの仮説（x=3 / x=-3）を並列評価 → 両方採用 → **MERGE で x=±3 に統合**
- 低評価の仮説（平方完成）は **KILL で淘汰**
- 各仮説は独立 Process（OS レベルの並列）

## 4. 4 本柱

| 柱 | 成果 |
|----|------|
| AI Operating IR | AILSM（v1.4: hypothesis 追加） |
| AI Virtual Memory | AVM（Context / Page / Slice / Cache / TLB / Tier） |
| AI Kernel | Kernel / Process / Thread / Syscall / Namespace |
| **AI Reasoning Runtime** | **Hypothesis SSA + Reasoning Graph（本仕様）** |

## 5. 今後の拡張

- **並列実行**: 仮説ごとの真の並列（Promise.all）→ 実機複数台で Math A/B/C を分散
- **Reflection の学習**: スコアリングを ODAR（LearnedCapability）と統合
- **仮説の多段階**（generate コールバックで複数ラウンド）
- 論文: 「MoE の暗黙的探索を OS で明示化した実行モデル」

---

*AI Reasoning Runtime は ArcAsha の 4 本柱として論文化できる。*
