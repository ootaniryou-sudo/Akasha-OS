# AI ABI / Driver / Device Tree Specification

> **AI Application Binary Interface — Expert 間の受け渡し規約（AI Linux の Device/Driver 層）**

| 項目 | 値 |
|------|-----|
| Status | **Spec v1.0**（ABI / Driver / DeviceTree 実装済み + Long Context ABI 追加） |
| Date | 2026-08-05 |
| 実装 | `src/arcasha/ailsm/abi.ts`, `driver.ts`, `device-tree.ts`, `expert-runtime.ts` |
| 関連 | `ARCASHA_V2_SPEC.md`, `AILSA_ISA.md`, `AILSA_RUNTIME.md`, `AI_TOOLCHAIN.md`, `AI_VIRTUAL_MEMORY.md` |

---

## 1. AI ABI（Phase 0.17）

LLVM の `IR → ABI → Machine Code` に相当する、Expert 間・Kernel-Expert 間の受け渡し規約。

### Argument ABI

```
Argument0  Type=float32  Shape=[1]  Ownership=borrow  Alignment=4
```

| フィールド | 例 |
|-----------|-----|
| `type` | float32 / float16 / int32 / tensor / matrix / string / any |
| `shape` | [1] / [3,3] / なし |
| `ownership` | borrow / own |
| `alignment` | 4 / 8（bytes） |

### Return ABI

```
RETURN → Result / Type / Status（ok | error）
```

### Error ABI

| エラー | code | recoverable | retryable |
|--------|-----|-------------|-----------|
| Division by Zero | 1001 | false | true |
| Unsupported Opcode | 2001 | false | false |
| ABI Version Mismatch | 2002 | true | false |
| Timeout | 3001 | true | true |

### Version Negotiation

Kernel が `supportsAbi(kernel, expert)` を確認してから CALL する（major 一致 + kernel.minor >= expert.minor）。

### Capability ABI（Expert の交換可能性）

```
requires: fp16
supports: tensor
prefers:  batch
```

`capabilityFulfills(required, capability)` で Expert の交換可否を判定。

### Long Context ABI（Phase 0.20 — AI Virtual Memory）

Expert へ渡すのは **Context Slice（ID 参照）だけ**。実体は Kernel が保持する（Linux の file descriptor に相当）。

```
ContextRef { contextId: 20, pageIds: [45, 46, 47], sliceId?: 50 }
→ buildContextArgument(0, ref)
→ AbiArgument { index: 0, type: 'context', ownership: 'borrow', alignment: 8 }
```

- 引数型 `'context'` を追加（`AbiType` の拡張）
- Driver は `invokeContext({ contextRef, loadedText, ... })` で供給されたページだけを処理
- 詳細は `AI_VIRTUAL_MEMORY.md`

## 2. Expert Driver（Phase 0.18）

```
Kernel → Driver → LLM（Qwen / Gemma / Phi / Llama を共通 ABI で呼ぶ）
```

- `ExpertDriver` インターフェース: `{ id, name, abiVersion, capability, supports(opcode), invoke(request) }`
- `MockExpertDriver`: AILSA 命令列を決定論で「実行」する（実モデル差し替え前のスタブ）
- 実モデルドライバは同じインターフェースを実装するだけで差し替え可能（Qwen3 / DeepSeek / Gemma も可）

## 3. AI Device Tree（Phase 0.19）

Linux の Device Tree 相当。実行ノードの情報を記述し、ODAR のルーティング特徴量にする。

```
PC:     node=pc1 arch=x86_64 cpu=M3 gpu=RTX4090 ram=16384MB battery=∞ cost=0.1
スマホ: node=iphone arch=arm64 cpu=A18 ram=8192MB battery=75% wifi=true lang=ja cost=0.05
```

- `DeviceTree.registerNode / node / list / describe`
- フィールド: gpu / ramMB / battery / network / language / cost / features

## 4. Local Expert Runtime（Phase 1・最小版）

1台のPC上で複数のExpertがAILSAで通信する最小実行基盤。

```
boot(): DeviceTree + Driver（math/search/reasoning）登録
execute(text):
  compile → AILSM → Executor
    → needsExpert → Belief/Capability/Schedule → CALL
    → Driver.invoke(AILSA プログラム) → RETURN
    → Kernel（Memory 保存）→ Process finished
```

実機（iPad/iPhone）へは同じ `ExpertDriver` インターフェースを実装して差し替える（Phase 1 後半）。

---

*この仕様は「ArcAsha」から独立して利用・論文化できる。*
