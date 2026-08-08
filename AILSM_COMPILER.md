# AILSM Compiler Specification

> **自然言語 → AILSM → Optimize → AILSA（AIコンパイラ）**

| 項目 | 値 |
|------|-----|
| Status | **Spec v1.0** |
| Date | 2026-08-04 |
| 実装 | `src/arcasha/ailsm/`（lexer / normalizer / parser / semantic / optimizer / generator / verifier / compiler） |
| 関連 | `ARCASHA_V2_SPEC.md`, `AILSA_ISA.md`, `AILSM_IR.md`, `AILSA_RUNTIME.md` |

---

## 1. パイプライン

```
Lexer → Parser → Normalizer → Semantic Analyzer → Optimizer(-O0..-O3) → AILSA Generator
```

各段は100%決定論。検証を通らないプログラムは絶対に返さない。

## 2. 3段階精度保証

| Stage | 内容 | 決定論 |
|-------|------|--------|
| **1 Deterministic Parser** | 辞書・規則で閉じた語彙要素を変換（足し算/平方根/積分 → `ACTION_ADD` 等）、同義語を正準語へ折り畳む | 100% |
| **2 LLM残差** | 辞書で判定できない部分だけLLMへ（閉じた語彙に制約された生成）。未実装 — `AilsmError` で委譲点を明示 | 部分 |
| **3 Verifier** | 5種の検証（Syntax / Semantic / Capability / Consistency / Safety）。往復照合（BLEU/BERTScore/コサイン/グラフ一致率）はアプリ層で組み込み | 100% |

## 3. 段の詳細

| 段 | 役割 | 実装 |
|----|------|------|
| **Lexer** | 自然言語をトークン化（数値/変数/数式/単語）。`2+3` は数式トークンとして分割しない | `lexer.ts` |
| **Normalizer** | 同義語→正準語（足してください/加えて/和を求めよ → `ACTION_ADD`）、意図・ドメイン・オブジェクト・属性・出力を抽出 | `normalizer.ts` |
| **Parser** | NormalizedInput → SSA風ID付きグラフ | `parser.ts` |
| **Semantic Analyzer** | 型検査・矛盾検出・解釈不能の検出（Stage 2 委譲点） | `semantic.ts` |
| **Optimizer** | Pass Manager（-O0..-O3）: DeadNodeElimination / Dedup / ConstantFolding（`2+3→5`）/ BatchDetection | `optimizer.ts` |
| **Generator** | AILSM → AILSA命令列（CALL+SLOT_DOMAIN / DOMAIN_* / 数学オペコード / 定数畳み込み結果） | `generator.ts` |
| **Verifier** | 5種検証（Phase 0 Validator 再利用） | `verifier.ts` |

## 4. 出力

- AILSMグラフ（最適化前後）
- AILSA命令列（`Instruction[]`）
- AILSAバイト列（Phase 0 Codec でエンコード、内部で再検証）
- Capability推論（ドメイン/エキスパート/必要型）
- notes（Passが実行した最適化の記録）

## 5. 実行（AILSA Runtime との境界）

`compileAndRun(text, level)` はコンパイル後に **AILSM Executor** を呼び、
組み込み演算をLLM無しで解決する。

- `execution.resolved = true` → ローカル解決（Expert委譲不要）
- `execution.needsExpert = true` → CALL/RETURN で Expert へ委譲

## 6. 検証

```
npm run ailsm:selftest   # 単体テスト
npm run ailsm:golden     # 30ケースの回帰テスト（100〜1000件へ拡張可能）
npm run ailsm:visualize  # 可視化
```

---

*この仕様は「ArcAsha」から独立して利用・論文化できる。*

