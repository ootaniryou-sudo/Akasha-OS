# AI Toolchain Specification

> **ArcAsha = AI のためのコンパイラ・OS・ツールチェーン（AI版 GCC / LLVM / GNU Binutils）**

| 項目 | 値 |
|------|-----|
| Status | **Spec v1.0**（Compiler / Program / Optimizer / Assembler / Linker 実装済み） |
| Date | 2026-08-05 |
| 実装 | `src/arcasha/ailsm/`（compiler / program / optimizer / executor）+ `src/arcasha/ailsa/`（codec） |
| 関連 | `ARCASHA_V2_SPEC.md`, `AILSA_ISA.md`, `AILSM_IR.md`, `AILSM_COMPILER.md`, `AILSA_RUNTIME.md` |

---

## 1. 全体像

ArcAsha は Compiler でも OS でも Runtime でもなく、**Toolchain** 全体を提供する。

```
AI Source（自然言語 / AI Program）
  → AILSM Compiler
  → AILSM（AI State IR）
  → AILSM Optimizer（-O0..-O3）
  → AILSA（AI Assembly）
  → Assembler
  → Bytecode
  → AI Linker
  → Executable Task
  → Loader / Runtime（AI Kernel）
  → Experts（CPU 相当）
```

### 既存ツールチェーンとの対応

| ArcAsha | 既存 |
|---------|------|
| AI Source（自然言語 / AI Program） | C / C++ |
| AILSM Compiler | Clang / GCC |
| AILSM Optimizer | LLVM Opt（-O1 / -O2 / -O3） |
| AILSA Assembler | GNU as |
| AI Linker | GNU ld |
| Loader / AI Kernel | ld.so / OS |
| Experts | ハードウェア / CPU |

## 2. AI Program（Phase 0.14）

AILSM で**直接プログラムを書ける**（`program.ts`）。

```
PLAN → CALL math → EQ → VERIFY → SYSCALL_REFLECT → CALL math → RETURN
```

```ts
const prog = new AiProgram('solve-and-verify')
  .plan('solve x^2-4=0')
  .call('math', 'x^2-4=0')
  .math(MathOpcode.EQ, 'x^2-4=0')
  .verify()
  .reflect('precision', 'retry fp64')
  .returns('x=2');
prog.assemble();  // → AILSA 命令列（AI Assembly）
prog.encode();    // → バイト列（Bytecode、検証込み）
```

## 3. AILSM Optimizer（Phase 0.15）

AILSM（グラフレベル）+ 命令レベル（`optimizeInstructions`）の両方で最適化。

- **DCE**: 連続する同一命令の除去
- **CALL バッチ化**: `CALL Math ×3 → CALL Math Batch=3`（LLVM の Loop Opt / Inlining / GVN 相当）
- **指標の削減**: Task 数 / Expert 数 / CALL 数 / Latency / Cost

```
stats: calls 3→1 / experts 1→1 / latencyMs 72→24 / cost 1.2→0.4
```

## 4. AI Assembler

AILSA 命令列 → バイト列は Phase 0 の **Codec**（`encode`）が担当（オペコード + スロット + 長さ前置値）。

## 5. AI Linker（Phase 0.16）

複数 Expert の IR（**Object File 相当**）を結合して **Executable Task** を生成する（`linker.ts`）。

```
Math IR + Search IR + Planner IR  →  単一 AILSA プログラム
```

- セグメントごとに `CALL / RETURN` でラップ
- シンボルテーブル: セグメント → task_id
- リンク結果は Validator / Codec で再検証

## 6. 研究上の位置づけ

- **核**: ODAR（適応ルーティング）/ AILSM（AIの状態を表現するSSA IR）/ AILSA（閉じたISA + コンパイラ基盤）
- **通信・実行環境はその上に載る実装**（Phase 1 以降）
- 独自性: 「AI のための GCC / LLVM / binutils」に相当する**ツールチェーン**として体系化

---

*この仕様は「ArcAsha」から独立して利用・論文化できる。*
