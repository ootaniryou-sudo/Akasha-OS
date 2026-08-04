# AILSM IR Specification

> **ArcAsha Inter Language Semantic Model — AI向け中間表現（IR）**

| 項目 | 値 |
|------|-----|
| Status | **Spec v1.0（凍結）** |
| Date | 2026-08-04 |
| 実装 | `src/arcasha/ailsm/ailsm.ts`, `types.ts`, `visualizer.ts` |
| 関連 | `ARCASHA_V2_SPEC.md`, `AILSA_ISA.md`, `AILSM_COMPILER.md`, `AILSA_RUNTIME.md` |

---

## 1. 目的

AILSMは、小型AI同士（および Planner / Memory / Verifier / Reflection / ODAR 等の全サブシステム）が共有する**意味中間表現**である。自然言語は入口と出口だけ。内部は全てAILSM。

AILSMは単なるIRではなく、**AI Operating IR** — CPUだけでなく AI 自身の思考・状態・学習・記憶・計画・信念を管理する実行可能表現（AI OS の Kernel Object に相当）。

## 2. 設計原則

1. **SSA風ID付き意味グラフ** — 全ノードに一意ID（`Task#N` / `Object#N` / `Value#N`）を付与し、参照はIDで表現（`uses(Object#2)`）。Verifier・最適化・並行処理が構造的に容易になる
2. **共有IR** — 全サブシステムが同じAILSMグラフを読み書きする（CPUの共有メモリに相当）
3. **型付き** — 各ノードは型を持つ。コンパイル時型エラー・静的IR検査・実行前矛盾排除が可能
4. **正準化** — 同一意味は同一ノード（Circle / 円 / circle / 円形 → 同一ノード）
5. **AI Operating IR（AI State IR）** — AILSMは意味表現ではなく、**AIの内部状態全体をSSAとして管理する実行可能IR**。Task / Plan / Belief / Capability / Memory / Schedule / Reflection / Result 全てをノードとして保持し、AIの思考が可視化できる

## 3. ノード

| 種別 | ID表記 | 例 |
|------|--------|-----|
| **Task** | `Task#N` | `Task#1 : solve`（domain, intent, actions を attrs に保持） |
| **Object** | `Object#N` | `Object#2 : circle` / `Object#3 : equation {expr}` |
| **Value** | `Value#N` | `Value#4 : number {radius=5}` / `Value#5 : result {value=5}` |
| **Memory** | `Memory#N` | `Memory#4 : number {key=result, value=5}`（長期記憶） |
| **Belief** | `Belief#N` | `Belief#5 : unknown {expert=math, confidence=0.82}`（ODAR） |
| **Plan** | `Plan#N` | `Plan#6 : string {steps=[DECOMPOSE, CALL math]}` |
| **Reflection** | `Reflection#N` | `Reflection#7 : string {cause=precision, fix=...}` |
| **Capability** | `Capability#N` | `Capability#8 : unknown {expert=math, accuracy=0.91, latency=24, cost=0.4, language=IR}` |
| **Schedule** | `Schedule#N` | `Schedule#9 : unknown {node=math, priority=0.93, eta=24, cost=0.4}` |

各ノード: `{ id, kind, label, type, attrs, constraints? }`

## 4. エッジ

| 関係 | 意味 |
|------|------|
| `uses` | タスクがオブジェクト/値を参照 |
| `input` | タスクへの入力テキスト |
| `produces` | 実行結果の生成（Executor が追加） |
| `stores` | タスクが記憶に値を保存（Memory SSA） |
| `informs` | Belief がタスクに確信度を提供（ODAR） |
| `plans` | タスクが実行計画を持つ（Plan SSA） |
| `reflects` | タスクが自己修正を持つ（Reflection SSA） |

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

## 8. 仕様凍結（v1.0）

IR は後から変更すると Compiler / Executor / Runtime / Visualizer / Expert の全てに影響するため、**v1.0 で凍結**する。

| 安定化対象 | 定義 |
|-----------|------|
| **SSAノードカタログ** | task / object / value / memory / belief / plan / reflection / capability / schedule |
| **エッジカタログ** | uses / input / produces / stores / informs / plans / reflects / schedules |
| **型システム** | AilsmType + AilsmTypeRef（union / optional）+ NodeConstraints |
| **状態遷移** | ローカル解決: Result→Memory / 委譲: Belief→Capability→Schedule→CALL |
| **ABI** | ノード {id, kind, label, type, attrs, constraints} / エッジ {from, to, rel} |
| **Verifier** | Syntax / Semantic / Capability / Consistency / Safety |

**変更ポリシー**:
- ノード・エッジ・型の**追加は MINOR**（後方互換）
- **削除・ID変更は MAJOR**（原則禁止 — Registry の ID 不変則と同じ思想）

**論文化タイトル候補**:
- "AILSM: A Stateful SSA Intermediate Representation for AI Systems"
- "AI State IR: A Stateful SSA Representation for Distributed AI Runtime Systems"
- "AI Operating IR: The Kernel Object Representation of an AI Operating System"

---

*この仕様は「ArcAsha」から独立して利用・論文化できる。*
