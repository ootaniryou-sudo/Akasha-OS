# AI Virtual Memory（AVM）Specification

> **AI OS が巨大な知識空間を仮想メモリとして管理し、必要な部分だけを Expert へ供給する**

| 項目 | 値 |
|------|-----|
| Status | **Spec v0.1（Phase 0.20 実装済み）** |
| Date | 2026-08-05 |
| 実装 | `src/arcasha/ailsm/context.ts`, `slice.ts`, `cache.ts`, `avm.ts` |
| 関連 | `ARCASHA_V2_SPEC.md`, `AILSM_IR.md`（v1.1）, `AI_ABI.md`（Long Context ABI）, `AILSA_RUNTIME.md` |

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
└── Cache     ← NEW
```

- **Hot / Warm / Cold Context Tier**（MASTER_SPEC §17 と接続）
- **分散 Context Page**（実機 iPad/iPhone へページを分散配置）
- **Context Cache の実モデル実装**（Embedding 生成 → 類似 Context の再利用）

---

*AI Virtual Memory は ArcAsha から独立した研究テーマとして論文化できる（AILSM/ODAR/AILSA に次ぐ第4の柱候補）。*
