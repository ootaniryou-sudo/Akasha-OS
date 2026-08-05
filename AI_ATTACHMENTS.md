# AI Intelligence Attachments — Plugin Layer

> **AI OS = 小さく安定 / Advanced Intelligence = Attachment（オプションのカーネルモジュール）**

| 項目 | 値 |
|------|-----|
| Status | **Spec v1.0（Phase 3.0 実装済み）** |
| Date | 2026-08-06 |
| 実装 | `src/arcasha/attachments/`（`attachment.ts`, `manager.ts`, `scheduler.ts`, `observability.ts`, `builtin.ts`, `benchmark.ts`, 組み込み 7 種） |
| 関連 | `ARCASHA_V2_SPEC.md`, `AI_REASONING.md`（Reasoning / Executive / Meta Executive / Expert Evolution） |

---

## 0. 思想 — Kernel は最小限・知能は Attachment

ArcAsha Core（Kernel / Runtime / Executive / AVM / Expert Runtime）は**小さく安定**。これ以上本体へ機能を追加すると保守が難しくなるため、高度な知能（Reflection / Debate / Planning / Search / Creativity / Simulation / Coding）はすべて **Attachment（プラグイン）** として、**必要な時だけロード**する。

これは **Linux がオプションのカーネルモジュールを扱うのと同じ**。無効化された Attachment は Core に何も影響しない。

```
Application
   ↓
Executive Runtime（常に高速）
   ↓
──────────────────────────────
Attachment Manager（プラグイン層）
   ↓
──────────────────────────────
Reflection / Debate / Planning / Search / Creativity / Simulation / Coding
   ↓
Reasoning Runtime
   ↓
Kernel
```

## 1. Attachment インターフェース

```typescript
interface Attachment extends AttachmentMeta {
  id: string; name: string; version: string;
  enabled: boolean;
  supports(taskText: string): boolean;              // このタスクを担当できるか
  run(context: AttachmentContext): Promise<AttachmentResult>;
}
```

- **AttachmentMeta** = Thinking Budget: `estimatedCost` / `estimatedLatency` / `estimatedAccuracy`（Executive のスケジューリングに使用）
- **AttachmentContext** = `{ text, booted, attach }`（Kernel 状態へは直接触れない）
- **AttachmentResult** = `{ ok, text, quality, latencyMs, calls, tokens, detail }`

**制約**: Attachment は Kernel 状態を直接変更しない。全通信は Executive Runtime 経由。AVM のみを使用し、Context は ContextRef でしか交換しない。

## 2. Attachment Manager（`manager.ts`）

| 操作 | 意味 |
|------|------|
| `register(id, loader)` | ローダー登録（**遅延ロード**: 実体は load まで作らない = insmod 相当） |
| `unregister(id)` | 登録解除（rmmod） |
| `load(id)` / `unload(id)` | 実体の生成・破棄 |
| `enable(id)` / `disable(id)` | 有効・無効 |
| `execute(id, ctx)` | 実行（Monitor に記録） |
| `executeParallel(ids, ctx)` / `executeMerged` | 並列実行 + 統合 |

## 3. 組み込み Attachment 7 種

| Attachment | パイプライン | 既存 Runtime の再利用 |
|-----------|--------------|----------------------|
| **Reflection** | Answer → Reflection → Score → Revision → Return | 自己批判の決定論パイプライン |
| **Debate** | Expert A/B/C → Judge → Consensus | **Reasoning Search Runtime**（立場 = Hypothesis、Judge = ACCEPT） |
| **Planning** | Goal → Sub Goals → Execution Plan → Scheduling | **AILSM Plan SSA**（`state.plan`） |
| **Search** | BFS / DFS / Beam / Best-First / MCTS | **Search Runtime**（`runSearch` + `SEARCH_POLICIES`） |
| **Creativity** | 複数の新しい仮説を生成 | **Hypothesis SSA**（`hypothesize` / `expand`） |
| **Simulation** | What-if → 分岐実行 → 統合 | **Hypothesis SSA**（`merge`） |
| **Coding** | 解析 → アーキテクチャ理解 → パッチ → 自己レビュー → コンパイル → リトライ | Executive Runtime（決定論パイプライン） |

## 4. Attachment Scheduling（Executive の選択）

Executive は「どの Attachment を / いつ / どれだけの予算で / どの優先度で」を決める。

```
優先度 = estimatedAccuracy − estimatedCost×0.5 − estimatedLatency/10000
```

- `supports` + `enabled` を満たす Attachment を優先度順に選択
- 予算（0-1）を配分し、足りなければ低優先度を外す
- `runWithAttachments` = Executive → スケジューラ → **並列実行** → 統合

## 5. 並列実行

Reflection / Debate / Planning 等を **Promise.all で同時実行**し、`mergeResults` で統合（品質は**最良を採用**、レイテンシは最大、コストは合計）。

## 6. Thinking Modes（Phase 3.1）— Fast / Auto / Deep / Custom

他 AI モデルの「Thinking ON/OFF」はブラックボックス（内部で何か長く考えるだけ）。ArcAsha は**同じ OS の上で実行パイプラインだけを変え**、どの Attachment がどれだけ時間を使ったかを可視化する（`modes.ts`）。

### 6.1 4 モード

| モード | パイプライン | 用途 |
|--------|--------------|------|
| **Fast**（デフォルト） | Kernel → Expert Runtime → Answer（Attachment なし） | ロボット・リアルタイム制御・2+2 |
| **Auto** | Executive がタスクから自動選択 | 一般利用（2+2 → Fast / 批判的レビュー → Reflection+Debate / 新しいアルゴリズム → Planning+Debate+Creativity） |
| **Deep** | Planning → Debate → Reflection → Simulation（積極利用） | 研究・科学・長時間推論 |
| **Custom** | ユーザーが手動で Attachment を選択 | 細かい制御 |

- **Auto の自動選択**: `estimateBudget`（Meta Executive の Thinking Budget）で 2+2 → Reasoning 禁止 → Fast。難しいタスク（high）なら Planning + Debate + Creativity も自動起動。

### 6.2 Intelligence Scheduler（時間予算）

CPU スケジューラではなく**知能スケジューラ**。`intelligenceScheduler(attachments, budgetMs)` が**時間予算（Thinking Budget）**内で優先度順に配分:

```
優先度 = estimatedAccuracy − estimatedCost×0.5 − estimatedLatency/10000
budget=200ms  → reflection(150ms) だけ
budget=1000ms → reflection(150ms) + creativity(200ms) + debate(400ms) + planning(250ms)
```

### 6.3 Thinking Budget の可視化（他モデルにはない透明性）

```
=== Thinking (auto) budget=1000ms used=550ms ===
  reflection   150ms
  debate       400ms
  TOTAL       550ms / quality=0.90
```

### 6.4 モード比較ベンチ

```
=== Thinking Benchmark ===
mode  latency  tokens  quality
Fast        0ms      8   0.50
Auto      550ms     27   0.90
Deep      800ms     52   0.90
```

**「必要なときだけ高度な推論を起動する」設計が有効**であることを示す（Fast は最速・最安、Auto/Deep は品質向上、予算遵守は `usedMs ≤ budgetMs` で検証）。

## 7. Validation（Phase 3.2）— アーキテクチャの有効性を実証

「Attachment を追加したから便利になった」ではなく **「必要なときだけ高度な推論を起動する設計が有効である」** を定量で示す実験（`validation.ts`）。

### 7.1 Fast vs Auto vs Deep 実測（レイテンシ・電力・品質）

```
=== Mode Validation（Fast vs Auto vs Deep）===
mode   latency  quality  tokens  power
Fast        0ms   0.50       8   10mW
Auto      550ms   0.90      27  1210mW
Deep      800ms   0.90      52  1765mW
```

- Fast は最速・最安・最低品質 / Auto は必要分だけ / Deep は最高品質（電力はレイテンシ・呼び出し・コストから決定論近似）

### 7.2 Ablation Study（Attachment ごとの効果）

```
=== Attachment Ablation（効果測定）===
config        quality  delta    latency  tokens
なし（Fast）     0.50   +   0%       0ms      8
+reflection  0.88   +  76%     150ms     20
+debate      0.85   +  70%     400ms      6
+planning    0.75   +  50%     250ms     25
+creativity  0.80   +  60%     200ms     16
+search      0.80   +  60%     350ms      5
+simulation  0.80   +  60%     300ms     16
+coding      0.90   +  80%     500ms     31
ALL（並列）      0.90   +  80%     500ms    119
```

**Reflection だけで +76%、Coding で +80%、ALL で +80%** — 各 Attachment の効果を単体で定量化できる（「どの Attachment が何に効くか」の根拠）。

### 7.3 ロボットモード（閉ループ 30fps）

```
=== Robot Mode（閉ループ 30fps）===
mode  loop    fps   30fps   success  reason
Fast     33ms  30.3  ✓      0.95   閉ループ制御（Attachment なし）— 30fps 維持
Auto     33ms  30.3  ✓      0.93   Auto は制御タスクを高速に保つ（Attachment 不要と判断）
Deep    833ms   1.2  ✗      0.20   議論を閉ループに混ぜると 30fps を破綻（1.2fps で対象を見失う）
```

**リアルタイム制御では議論している暇がない**ことを定量比較。Camera(8ms)+Vision(12ms)+Planner(5ms)+Motor(8ms)=33ms の閉ループを、Deep は 833ms に破綻させる。

## 8. Observability（Attachment Monitor）

AI Monitor を拡張し、Attachment ごとに **Timeline / Cost / Latency / Accuracy / Calls** を表示（`observability.ts` — Core には触れないオプションの観測器）。

```
=== Attachment Monitor ===
  Calls: 5 / AvgLatency: 270ms / AvgAccuracy: 0.84 / TotalCost: 1.50 / Tokens: 75
=== Attachment Timeline ===
  t=0 reflection lat=150ms q=0.88 ...
```

## 9. ベンチマーク

```
=== Attachment Benchmark ===
mode           latency   tokens  quality  cost
なし（Fast）         60ms      6   0.50   0.10   ← Fast Runtime（議論なし）
Reflection      150ms     17   0.87   0.20
Debate          400ms      5   0.85   0.40
Planning        250ms     25   0.75   0.30
All（並列）         500ms    114   0.82   0.90
BEST QUALITY : Reflection (quality=0.87)
```

**なし（Fast）は最速・最安、Attachment は品質を向上**（レイテンシとトレードオフ）。

## 10. デュアルモード（Fast / Deliberation）

| モード | 構成 | 用途 |
|--------|------|------|
| **Fast Runtime（デフォルト）** | 現在の Executive + Expert Runtime だけ（Attachment なし） | ロボット・エッジ AI・リアルタイム制御（閉ループ 80ms 級） |
| **Deliberation Runtime（オプション）** | Attachment Manager 経由で Reflection / Debate / CIR をロード | 研究・科学・設計・長時間推論 |

ロボットでは Collective Runtime を無効化、研究用途では有効化 — 用途ごとに切り替えられる。

## 11. Collective Intelligence Runtime（将来の Attachment）

「複数の AI がどう協調して考えるか」を OS の上位レイヤとして実装する方向（Debate / Consensus / Voting / Minority Report / Critic / Reviewer）。**OS 本体には入れず**、必要時だけロードする Attachment として設計する（推論品質は上がるが、レイテンシが増えるためリアルタイム制御では無効化）。

## 12. 要件

- ✅ 後方互換（Core に破壊的変更なし）
- ✅ プラグインアーキテクチャ / 遅延ロード
- ✅ 独立テスト（selftest [65]-[67]）/ 可視化 / ドキュメント
- ✅ Kernel は最小限・知能は Attachment の分離
- ✅ Thinking モード（Fast/Auto/Deep/Custom）+ 時間予算の可視化
- ✅ 実証（モード実測 / Ablation / ロボット 30fps）

## 13. 将来（ロードマップ）

- **Attachment Ecosystem**: Attachment 自身も Split / Merge / Retire（Expert Evolution の基準を再利用）
- **Collective Intelligence Runtime**: Debate / Consensus / Voting / Minority Report / Critic / Reviewer を Attachment として実装
- **Attachment Store**: 公式 + サードパーティ製 Attachment の配布・評価（Reflection ★5 / Scientific Reasoner ★4 等）
- **実機実測**: 電力モデルを Phase 1 の Device Runtime（iPhone/iPad）と統合して実測

---

*ArcAsha は「ニューラルモデルの上で動く AI オペレーティングシステム」— Core は高速・決定論・安定、知能はプラグインとして進化する。*
