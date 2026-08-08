/**
 * AILSA Codec — 統一エントリポイント（AI コンパイラのコード生成/逆変換）
 *
 * Phase 0 の最重要不変条件:
 *   - registry.json（Intel Manual）が唯一の権威
 *   - モジュール初期化時にミラー（enum / schema）との完全一致を強制
 *   - encode/decode/validate は 100% 決定論（AI を使わない）
 *
 *   Natural Language → [LLM] → AILSM → [Codec] → AILSA
 *   AILSA → [Validator] → [Registry] → [Expert]   ← ここから先は全て決定論
 */

import {
  AILSARegistry,
  assertRegistryIntegrity,
  registry,
} from './vocab.js';
import { assertSchemasComplete } from './schema.js';
import { CodecError, Instruction, encodeProgram } from './encoder.js';
import { decodeProgram } from './decoder.js';
import { validateProgram } from './validator.js';

// ── モジュール初期化: 唯一の権威を読み込み、土台の完全性を強制 ──
const REG: AILSARegistry = registry();
assertRegistryIntegrity(REG);
assertSchemasComplete(REG);

/** Registry バージョン（例: "1.0.0"） */
export function version(): string {
  return REG.version;
}

/** 構造化命令列 → バイト列。検証に通らないものは絶対にエンコードしない。 */
export function encode(program: Instruction[]): Uint8Array {
  const v = validateProgram(program);
  if (!v.valid) {
    throw new CodecError(
      `AILSA 検証失敗: ${v.issues.map((i) => `[${i.index}] ${i.message}`).join('; ')}`,
    );
  }
  return encodeProgram(program);
}

/** バイト列 → 構造化命令列（バイト不正は CodecError で大声で失敗） */
export function decode(bytes: Uint8Array): Instruction[] {
  return decodeProgram(bytes);
}

/** encode の別名（AI コンパイラのコード生成ステージ） */
export function compile(program: Instruction[]): Uint8Array {
  return encode(program);
}

export { validateProgram, validateInstruction } from './validator.js';
export { CodecError } from './encoder.js';
export type { Instruction, SlotValue } from './encoder.js';
export type { ValidationResult, ValidationIssue } from './validator.js';
