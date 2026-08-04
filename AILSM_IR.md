# AILSM IR Specification

> **ArcAsha Inter Language Semantic Model — AI向け中間表現（IR）**

| 項目 | 値 |
|------|-----|
| Status | **Spec v1.0** |
| Date | 2026-08-04 |
| 実装 | `src/arcasha/ailsm/ailsm.ts`, `types.ts`, `visualizer.ts` |
| 関連 | `ARCASHA_V2_SPEC.md`, `AILSA_ISA.md`, `AILSM_COMPILER.md`, `AILSA_RUNTIME.md` |

---

## 1. 目的

AILSMは、小型AI同士（および Planner / Memory / Verifier / Reflection / ODAR 等の全サブシステム）が共有する**意味中間表現**である。自然言語は入口と出口だけ。内部は全てAILSM。

## 2. 設計原則

1. **SSA風ID付き意味グラフ** — 全ノードに一意ID（`Task#N` / `Object#N` / `Value#N`）を付与し、参照はIDで表現（`uses(Object#2)`）。Verifier・最適化・並行処理が構造的に容易になる
2. **共有IR** — 全サブシステムが同じAILSMグラフを読み書きする（CPUの共有メモリに相当）
3. **型付き** — 各ノードは型を持つ。コンパイル時型エラー・静的IR検査・実行前矛盾排除が可能
4. **正準化** — 同一意味は同一ノード（Circle / 円 / circle / 円形 → 同一ノード）

## 3. ノード

| 種別 | ID表記 | 例 |
|------|--------|-----|
| **Task** | `Task#N` | `Task#1 : solve`（domain, intent, actions を attrs に保持） |
| **Object** | `Object#N` | `Object#2 : circle` / `Object#3 : equation {expr}` |
| **Value** | `Value#N` | `Value#4 : number {radius=5}` / `Value#5 : result {value=5}` |

各ノード: `{ id, kind, label, type, attrs, constraints? }`

## 4. エッジ

| 関係 | 意味 |
|------|------|
| `uses` | タスクがオブジェクト/値を参照 |
| `input` | タスクへの入力テキスト |
| `produces` | 実行結果の生成（Executor が追加） |

## 5. 型システム（Typed AILSM）

```
AilsmTypeRef = AilsmType | union(AilsmType[]) | optional(AilsmType)

AilsmType = number | string | boolean | circle | square | triangle
          | equation | matrix | function | class | query | unknown
```

- `isCompatible(src, dst)`: unknown はワイルドカード、union/optional を展開して照合
- **NodeConstraints**: `{ min?, max?, pattern?, optional? }` — 半径>0 等の静的検査（`satisfiesConstraints`）

## 6. 例

```
Task#1 : unknown {domain=math, intent=solve}
Object#2 : equation {expr=x+2=5}
Task#1 uses(Object#2)

Task#1 : unknown {domain=math, intent=solve, output=area}
Object#2 : circle
Value#3 : number {radius=5} {min:0}
Task#1 uses(Object#2)
Task#1 uses(Value#3)
```

## 7. 可視化（見えるIR）

- `toMermaid(graph)` / `toDot(graph)` / `toAsciiTree(graph)` で描画
- CLI: `npm run ailsm:visualize "2+3を計算して"`
- ブラウザ: `public/ailsm-viewer.html`

---

*この仕様は「ArcAsha」から独立して利用・論文化できる。*
