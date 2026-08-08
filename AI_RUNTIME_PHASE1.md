# AI Runtime Phase 1 — 実機実行系

> **Mock Driver → 実LLM（Qwen2.5）→ Hub（AI OS）→ Mac/iPhone/iPad 分散 → ODAR 学習**

| 項目 | 値 |
|------|-----|
| Status | **Phase 1.0-1.4 + Phase 2 実装済み（mock 検証 + Hub API 動作確認）** |
| Date | 2026-08-05 |
| 実装 | `src/arcasha/ailsm/model-client.ts`, `remote-driver.ts`, `relay.ts`, `device-router.ts`, `learning.ts`, `aios.ts` + `src/arcasha/demo-web.ts` |
| 関連 | `ARCASHA_V2_SPEC.md`, `AI_OBSERVABILITY.md`, `AI_VIRTUAL_MEMORY.md`, `AILSA_RUNTIME.md` |

---

## 方針

Phase 0 で土台（ISA/IR/Compiler/Runtime/Kernel/Memory/Observability）が揃った。
Phase 1 は **「設計書」ではなく「実際に AI OS として動作するシステム」** を示す段階。

```
Compiler → Optimizer → Runtime → Memory → Perf → Profiler → Trace → Benchmark
                                                       ↑
                              Phase 1: 実LLM・Hub・分散・学習
```

## Phase 1.0 — 実LLM Driver（Mock → Qwen2.5）

`model-client.ts` + `remote-driver.ts`

```
Driver → ModelClient（ExpertHub WS:8080）→ iPad/iPhone の llama.cpp/ggml-metal
```

- `RemoteDriver` は `ExpertDriver` インターフェースを実装（Mock と完全互換・差し替え可）
- AILSA 命令列（CALL/INPUT）からプロンプトを組み立て、実モデルの生成結果を返す
- 非同期（`invoke(): Promise<DriverResponse>`）— Mock は同期のまま互換
- ABI バージョン交渉・Long Context ABI（`invokeContext`）も対応

## Phase 1.1 — Multi-expert AILSA Relay

`relay.ts`

```
Planner → Math → Search → Reasoning → Planner
```

- 各ホップは「前の Expert の出力」を入力とし、AILSA プログラム（CALL + INPUT）として次の Expert へ
- 明示入力はコンパイル、連鎖入力は前ホップの出力を **生の AILSA CALL** に載せる（再コンパイルしない）
- 検証結果（5 ホップすべて ok）:

```
hop0 planning → plan: 本を要約して
hop1 math     → solution(x^2-4=0)
hop2 search   → [doc1, doc2, doc3]
hop3 reasoning→ plan: 結論をまとめて
hop4 planning → plan: 本を要約して
```

## Phase 1.2 — Hub（AI OS 本体）完成

`aios.ts` + `demo-web.ts`（Hub = AI OS の init）

```
demo-web.ts 起動
  → initAiOs（DeviceTree + Kernel + Mock + RemoteDriver + CapabilityLearner）
  → /api/ailsm（Compile → CALL → 実デバイス → ODAR 学習）
  → /api/relay（Multi-expert AILSA Relay）
  → /api/device-tree（Device Tree + 学習済み Capability）
```

実測（`curl /api/ailsm`）:

```
POST {"text":"x^2を積分して"}
→ result=∫x^2 dx + C, driverId=math, AILSA hex, ODAR 学習済み
  learner: [{expert:math, accuracy:0.62, latencyMs:70.3, cost:0.38, samples:1}]
```

## Phase 1.3 — Device Tree 実働（Mac / iPhone / iPad）

`device-router.ts`

- Hub に接続中の実ノードを自動で DeviceTree に登録（role: iphone/ipad 判定）
- `routeCall`: 優先指定 → Mac/ローカル → 最初のノード（決定論）
- `CALL math → iPhone` を実デバイスへ委譲

## Phase 1.4 — 分散 Context

`device-router.ts`（`assignPageDevice` / `distributedFault`）

```
Page1: Mac / Page2: iPad / Page3: iPhone
Context Fault → Kernel → Device Tree → ページ取得（実デバイスが処理）
```

- ページをデバイスへ配置（`page.attrs.device`）
- 分散 Fault はそのデバイスへページを送って処理させる（既存LLMには無い機能）

## Phase 2 — Capability オンライン学習（ODAR 完成）

`learning.ts` — Static Scheduler → **Learning Scheduler**

- `CapabilityLearner`: 実実行の観測（accuracy/latency/cost）を EMA で逐次更新
- `score()`: 精度が高く・速く・安いほど高スコア
- `pick()`: 学習済み Capability から最良 Expert を選択
- `updateCapabilitySsa()`: AILSM の Capability ノードを in-place 更新（ODAR = SSA が学習する）

```
実実行 → 観測 → EMA 更新 → Capability SSA → 次回のルーティングに反映
```

## 検証

- `tsc` ✅ / `ailsm:selftest` [1]-[55] ✅ / `golden` 30 ✅ / `ailsa:selftest` ✅ / dist ✅
- Hub API: `/api/ailsm`（math / search 委譲 + ODAR 学習）✅ / `/api/relay`（5ホップ全 ok）✅
- 実機（iPhone: Qwen2.5-1.5B）は Hub 再起動で `/api/ailsm` 経由の委譲を確認可能

---

## Phase 2.3 — 「作って」系意図 + Stage-2 フォールバック（一般タスク対応）

> 既存AIにできるタスクの**全て**を任せられるようにするための 2 つの追加。

### 1. 「作って」系意図（create）

`normalizer.ts` に `create` 意図を追加（作って / 作る / 作成 / 実装 / 書いて / 生成 / 開発 / build / make / create ...）。

```
「ログイン機能を作って」
  → intent=create / domain=code
  → programming Expert へ CALL（タスク文は INPUT に載る）
  → 実機LLM（or mock）が生成
```

- parser: create/code でもタスク文を input ノード化（LLM へ渡すため）
- capability / generator: `code → programming`（boot の 10 種と整合）

### 2. Stage-2 フォールバック（決定論 → 実機LLM）

今までは決定論コンパイラが解釈できないタスクは **400 エラー**だった。
`aiosExecute` で AilsmError を捕捉し、**生の CALL（general）として実機LLMへ委譲**するようにした。

```
「量子コンピュータについて説明してください」
  → 決定論では解釈不能（AilsmError）
  → Stage-2 フォールバック: CALL general + INPUT（生テキスト）
  → 実機LLMが生成 → ODAR も学習
```

これで「計算・検索・要約は決定論 / それ以外は実機LLM」という**ハイブリッド**になり、
**既存AIができるタスクを全部任せられる**（ツール呼び出しは未実装のまま）。

---

*次のステップ: 実機（iPhone/iPad）への実委譲確認 → Phase 3（100 Expert スケール）*

