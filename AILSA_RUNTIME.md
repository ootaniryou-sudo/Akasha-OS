# AILSA Runtime Specification

> **AILSM/AILSA の実行モデル — Expert は CPU**

| 項目 | 値 |
|------|-----|
| Status | **Spec v1.0**（Executor / AI State SSA / Scheduler-Capability SSA / AI Process 実装済み / Expert Runtime は設計） |
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

### 2.2 AI Process / Thread / Reasoning Scheduler（AI Kernel IR — Phase 0.11）

```
Task#1
  └─ Process#10 processes(Task#1)   {state=running, owner=math, priority=0.82, memoryBytes=49152}
       └─ Thread#11 threads(Process#10)  {label=solve, state=ready}
```

- **AIProcess**: ライフサイクル `created → ready → running → { waiting / finished / failed }`（不正遷移は例外）
- **AIThread**: 親Processから生え、Taskに対応（複数タスクの同時進行）
- **ReasoningScheduler**: `pickNext`（最高優先度・同点はID昇順）/ `pickRoundRobin`（公平性）— 100%決定論
- **Runtime Events**: `SPAWN` `CALL` `RETURN` `YIELD` `WAIT` `RESUME` `PREEMPT` `TIMEOUT` `FAIL` `FINISH`
- **Execution Trace**: `{seq, kind, processId, threadId, detail}` で全状態遷移を再現可能に記録

これで AILSM は **AI Kernel IR**（AI OS の Kernel Object）になる。複数タスクを Process として同時進行できる。

### 2.3 AI System Call / Kernel API（Kernel-mediated AI Runtime — Phase 0.12）

**Expert（User Space）は Kernel に直接触れない**。全て System Call で要求し、Kernel が 権限チェック → 適用 する（OS の User/Kernel 分離と同型）。

```
Math Expert ──REQUEST STORE──▶ Kernel ──▶ Verifier ──▶ Memory（壊れない）
```

- **User Space**: Task / Object / Value / Expert / Planner / Verifier
- **Kernel Space**: Memory / Belief / Schedule / Reflection / Capability / Process / Thread / Namespace

**System Call（AILSA 命令 0x80-0x8A）**:

| syscall | 役割 |
|---------|------|
| `SYSCALL_EXECUTE` `SYSCALL_SPAWN` | 実行 / プロセス生成 |
| `SYSCALL_PLAN` `SYSCALL_VERIFY` | 計画 / 検証 |
| `SYSCALL_REFLECT` | 自己修正（REQUEST → Kernel → Reflection Node） |
| `SYSCALL_ROUTE` | ルーティング（ODAR） |
| `SYSCALL_MEMORY_STORE/LOAD/QUERY/DELETE` | Memory API（直接 Memory SSA を触れない） |
| `SYSCALL_UPDATE_CAPABILITY` | Capability API（権限チェック付き） |

**権限モデル**: `MEMORY_DELETE` / `UPDATE_CAPABILITY` は対象 owner と一致するプロセスのみ許可（拒否は `granted:false`）。

### 2.4 Namespace / Virtual Memory（Process Isolation — Phase 0.13）

```
Process A → Memory Space A（Namespace）
Process B → Memory Space B（他プロセスの記憶は読めない）
```

- **Namespace**: プロセスごとに Memory Space を分離。`canAccessMemory` で参照可否を判定
- **Memory Page**: Memory SSA が巨大化したら `pageMemory` で分割し、`LOAD PAGE` で必要分だけ参照（**Virtual Memory** 相当）

これで ArcAsha は AI Compiler でも Distributed Runtime でもなく、**AI Operating System** として説明できる。

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

- ハブ（Master）が Expert の選択・中継（直接通信は禁止）
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
| AI Process / Thread / Reasoning Scheduler | 0.11 | ✅ 実装済み（`state.ts`, `scheduler.ts`, `runtime.ts`） |
| AI System Call / Kernel API | 0.12 | ✅ 実装済み（`kernel.ts`） |
| Namespace / Virtual Memory | 0.13 | ✅ 実装済み（`namespace.ts`） |
| Expert Runtime（CALL/RETURN） | 1 | 未着手（実機デモで実装） |
| Reasoning Runtime（PLAN/VERIFY/REFLECT） | 2 | 未着手 |
| Expert間AILSA通信 | 1 | 未着手 |
| 小型Expertの蒸留学習 | 4-5 | 未着手 |

---

## 7. AI Runtime Model v1.0（凍結）

実機通信（Phase 1）の前に、**AI実行モデルを v1.0 で凍結**する。通信は単なる「実行バックエンドの一つ」として自然に組み込める。

| モデル | 定義 |
|--------|------|
| **AIProcess** | ライフサイクル: `created → ready → running → { waiting / finished / failed }`。属性: owner / priority / memoryBytes |
| **AIThread** | 親Processからの生成（`threads` エッジ）。Task との対応（label） |
| **ReasoningScheduler** | `pickNext`（最高優先度・同点はID昇順）/ `pickRoundRobin`（公平性）。プリエンプションは running→ready |
| **Runtime Events** | `SPAWN` `CALL` `RETURN` `YIELD` `WAIT` `RESUME` `PREEMPT` `TIMEOUT` `FAIL` `FINISH` |
| **Execution Trace** | `{seq, kind, processId, threadId, detail}` の逐次記録。全ての状態遷移を再現可能 |
| **System Call** | `EXECUTE/SPAWN/PLAN/VERIFY/REFLECT/ROUTE/MEMORY_*/UPDATE_CAPABILITY`（AILSA 命令 0x80-0x8A） |
| **Namespace / Memory Page** | プロセスごとの Memory Space 分離 + ページング（Virtual Memory） |

**位置付け**: AILSM = **AI Kernel IR**（AI OS の Kernel Object）。Process / Thread / Scheduler を追加し、本当に **AI OS** になる。

---

*この仕様は「ArcAsha」から独立して利用・論文化できる。*

