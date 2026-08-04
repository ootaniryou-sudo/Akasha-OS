# AI Virtual Memory（AVM）Specification

> **AI OS が巨大な知識空間を仮想メモリとして管理し、必要な部分だけを Expert へ供給する**

| 項目 | 値 |
|------|-----|
| Status | **Spec v0.2（Phase 0.20 AVM + Phase 0.21 Execution Context 実装済み）** |
| Date | 2026-08-05 |
| 実装 | `src/arcasha/ailsm/context.ts`, `slice.ts`, `cache.ts`, `avm.ts`, `execution.ts`, `demand-paging.ts` |
| 関連 | `ARCASHA_V2_SPEC.md`, `AILSM_IR.md`（v1.2）, `AI_ABI.md`（Long Context ABI）, `AILSA_RUNTIME.md` |

---

## 0. 動機

既存LLMの「コンテキストウィンドウを 200K/1M トークンへ拡大する」設計は、全入力をモデルへ投げるため ArcAsha（小型AI 協調 OS）とは相性が悪い。

代わりに ArcAsha は **AI OS レベルのロングコンテキスト機能**として、巨大な知識空間を仮想メモリとして管理する。

```
Input (500ページPDF)
        ↓ Chunking
   Context Object（そのまま持たない）
        ↓ Page Manager
   Page0 / Page1 / ... / PageN
        ↓ Slice Loader
   「Page2 + Page7」だけを Math Expert へ
```

## 1. 5 層アーキテクチャ

| Layer | 名前 | 実装 | 説明 |
|-------|------|------|------|
| L1 | **Context Virtual Memory** | `context.ts`（createContext） | 入力をそのまま持たず、Context Object として管理。Memory SSA と同型 |
| L2 | **Context Paging** | `context.ts`（splitContext/pagesOf/loadPage） | CPU のページングと同様、固定サイズページへ分割。必要ページだけをロード |
| L3 | **Context Scheduler / Slice Loader** | `slice.ts`（selectPages） | Expert ごとに読むページが異なる。Math=数式だけ / Search=検索結果だけ / Planning=概要だけ |
| L4 | **Context ABI** | `abi.ts`（ContextRef / buildContextArgument） | Expert へは **Context Slice（ID 参照）** だけを渡す。実体は Kernel が保持（Linux の file descriptor に相当） |
| L5 | **Context Cache** | `cache.ts`（cacheArtifact/getCached） | 解析済み Context の AST / Equation / Embedding を再利用。再解析不要 |

## 2. SSA ノード

| ノード | 例 | エッジ |
|--------|-----|--------|
| `Context#N` | `Context#20 : string {title=論文, charCount=50000, pageCount=782}` | — |
| `Page#N` | `Page#45 : string {index=2, offset=128, length=64, text=...}` | Context `contains` Page |
| `Slice#N` | `Slice#50 : unknown {context=20, expert=math, pageCount=3, pageIds=[45,46,47]}` | Context `contains` Slice / Slice `uses` Page |
| `Cache#N` | `Cache#51 : unknown {context=20, kind=equation, key=parsed, value=...}` | Context `contains` Cache |

## 3. Long Context ABI

```
CALL math
  INPUT  ContextRef { contextId: 20, pageIds: [45, 46, 47] }   ← 参照だけ
```

- Expert は `ContextID` / `PageID` しか見ない（実体は Kernel が保持）
- `ContextRef { contextId, pageIds, sliceId? }` — Linux の **file descriptor** に相当
- `buildContextArgument(index, ref)` → `AbiArgument { type:'context', ownership:'borrow', alignment:8 }`

## 4. デモ結果（`runAvmDemo`）

長文ノート（7 ページ / 約 400 文字）を 3 Expert が処理:

| Expert | 読んだページ | 供給割合 |
|--------|-------------|----------|
| math | 3/7（数式ページだけ） | 49% |
| search | 2/7（検索結果だけ） | 33% |
| planning | 2/7（概要だけ） | 33% |

**全 Expert が全ページを読まない** — これが既存LLM（全トークンを投げる）との本質的な違い。

## 5. 独立研究テーマ

```
AILSM
├── Task / Memory / Plan / Belief / Capability
├── Context  ← NEW
├── Page     ← NEW
├── Slice     ← NEW
├── Cache     ← NEW
└── Execution ← NEW（Phase 0.21）
```

- **Hot / Warm / Cold Context Tier**（MASTER_SPEC §17 と接続）
- **分散 Context Page**（実機 iPad/iPhone へページを分散配置）
- **Context Cache の実モデル実装**（Embedding 生成 → 類似 Context の再利用）

---

## 6. Execution Context（Phase 0.21）

AVM は「メモリ管理」まで完成した。次は **思考途中（Execution Context）** の管理。

### 6.1 Execution Context SSA

Expert が「Page1 で A だと思った → Page100 で B → Page300 で C」となる思考途中を保存する。

```
Context → Execution Context → Belief → Memory → Reflection
```

`Execution#N` が保持するもの（= CPU の Process Context）:

| フィールド | 例 |
|-----------|-----|
| current page | `Page#45` |
| current hypothesis | `B: 数式も確認した（x=-1）` |
| temporary variables | `['x=-1']` |
| call stack | `['planning','math']` |
| active experts | `['math']` |
| resident pages | `[45, 46, 47]` |

### 6.2 Context Switch

Expert 切り替え（Math → Search → Planner）時に **save() / restore()** する（CPU のコンテキストスイッチ）。
これで **AI Thread が本当の Thread** になる。

```
ExecutionContext#5 → save() → Math 停止 → Search 開始 → restore()
```

### 6.3 Demand Paging / Context Fault

Planner が事前指定するのではなく、Expert が「今必要なページ」を要求し、未ロードなら **Context Fault**（= OS の Page Fault）を起こして Kernel がロードする。

```
Expert: Page45 が必要 → Context Fault → Kernel → Page45 ロード
```

### 6.4 Prefetcher

現在ページの隣接ページ（局所性）を先読みして resident set に入れる。

### 6.5 デモ結果（`runExecutionDemo`）

```
planning: Page1 を読む（fault）→ 仮説 A
→ SWITCH planning→math（save/restore）
→ math: 数式ページへ Context Fault → Kernel ロード → vars=['x=-1']
→ PREFETCH: 隣接ページを先読み
→ SWITCH math→planning（仮説 A を復元）→ 仮説 A→B に更新
→ final_hypothesis を Memory へ保存
```

ロングコンテキスト = 「100万Token読む」ではなく **「Execution Context を維持しながら必要ページだけ読む」**。
