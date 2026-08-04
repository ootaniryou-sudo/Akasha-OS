# AILSA Runtime Specification

> **AILSM/AILSA の実行モデル — Expert は CPU**

| 項目 | 値 |
|------|-----|
| Status | **Spec v1.0**（Executor / AI State SSA / Scheduler-Capability SSA 実装済み / Expert Runtime は設計） |
| Date | 2026-08-04 |
| 実装 | `src/arcasha/ailsm/executor.ts`（実装済み） |
| 関連 | `ARCASHA_V2_SPEC.md`, `AILSA_ISA.md`, `AILSM_IR.md`, `AILSM_COMPILER.md` |

---

## 1. 実行モデル

```
Task → AILSM → Executor → CALL → RETURN → AILSM更新
```

AILSMは**状態を持つSSAプログラム**。実行はグラフへのノード追加（`Value#N : result`）として表現される。

```
Task#1 (actions=[ACTION_ADD])
  ├─ Value#1 = 2
  └─ Value#2 = 3
      ── execute ──▶
Task#1
  ├─ Value#1 = 2
  ├─ Value#2 = 3
  └─ Value#3 : result = 5  （produces）
```

## 2. AILSM Executor（実装済み）

- **組み込み演算**: ADD / SUBTRACT / MULTIPLY / DIVIDE（二項）、SQRT / SQUARE（単項）
- **決定論**: 100%（LLM不要）
- **結果**: `{ resolved, needsExpert, value, steps, after }`
  - `resolved=true` → ローカル解決（`Value#N : result` を追加）
  - `needsExpert=true` → 積分・微分等は組み込みで解けないため Expert 委譲
- **実行トレース**: `steps` が Reasoning Runtime と State Visualizer の基礎

### 2.1 AI State SSA（Phase 0.9）

Memory / Belief / Plan / Reflection もすべて SSA ノードとして AILSM に載る（AI State IR）。

```
Task#1
  ├─ Memory#4 stores(Value#3)          長期記憶
  ├─ Belief#5 informs(Task#1)          ODAR の確信度（expert, confidence）
  ├─ Capability#8 informs(Task#1)      能力（accuracy/latency/cost）
  ├─ Schedule#9 schedules(Task#1)      実行計画（node/priority/ETA）
  ├─ Plan#6 plans(Task#1)              分解計画
  └─ Reflection#7 reflects(Task#1)     自己修正（cause, fix）
```

- `run(text)`: コンパイル → 実行 → 状態遷移
  - ローカル解決 → `Result` → `Memory`（stores）
  - Expert委譲 → `Belief` → `Capability` → `Schedule` → `CALL`（ODAR = SSA）
- **State Visualizer**: `toStateDiagram(steps)` で `stateDiagram-v2` を出力（AIの思考を可視化）

## 3. Expert Runtime（設計 — Phase 1）

**Expert = CPU**。CALL/RETURN で AILSA を処理する。

```
CALL Math
  ↓
Math Expert（実機ノード）
  ↓
RETURN { task_id, result }
  ↓
AILSM 更新（result ノード追加）
```

- ハブ（Heart of Wisdom）が Expert の選択・中継（直接通信は禁止）
- 実装: `src/arcasha/demo-web.ts` に AILSM Compiler + Executor を統合し、実機ノードへ委譲

## 4. Reasoning Runtime（設計 — Phase 2）

Planner / Reflection も AILSM 上で実行する。**Reasoning も Assembly になる**。

```
PLAN → DECOMPOSE → VERIFY → MERGE → RETURN
FAIL → CAUSE → REPLAN → CALL
```

- 各ステップは AILSM へのノード追加として表現（Reasoning Unit の木構造）
- `steps`（Executor のトレース）が Reasoning Runtime の基礎

## 5. 実行フロー（最終形）

```
Natural Language
  → Compiler → AILSM
  → Executor（組み込み解決）
  → CALL → Expert CPU → RETURN
  → AILSM 更新
  → Planner / Reflection（AILSM 上）
  → Verifier
  → Natural Language
```

自然言語は**入口と出口だけ**。内部では一切使われない。

## 6. ロードマップとの対応

| 実装 | Phase | 状態 |
|------|-------|------|
| AILSM Executor | 0.8 | ✅ 実装済み（`executor.ts`） |
| AI State SSA（Memory/Belief/Plan/Reflection） | 0.9 | ✅ 実装済み（`state.ts`, `runtime.ts`） |
| Scheduler / Capability SSA（ODAR=SSA） | 0.10 | ✅ 実装済み（`state.ts`, `runtime.ts`） |
| Expert Runtime（CALL/RETURN） | 1 | 未着手（実機デモで実装） |
| Reasoning Runtime（PLAN/VERIFY/REFLECT） | 2 | 未着手 |
| Expert間AILSA通信 | 1 | 未着手 |
| 小型Expertの蒸留学習 | 4-5 | 未着手 |

---

*この仕様は「ArcAsha」から独立して利用・論文化できる。*
