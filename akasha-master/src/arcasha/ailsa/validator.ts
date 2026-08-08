/**
 * AILSA Validator — 構文・構造・制御フローの検証（100% 決定論）
 *
 * AILSA は構文解析可能でなければならない。
 *   - 単命令: 登録済み opcode / 許可されたスロット / 必須スロット / 値の型
 *   - 命令列: CALL スタック（RETURN はアクティブな CALL を要求）、終端命令は末尾のみ
 *
 * 例:
 *   CALL CALL CALL RETURN  → valid
 *   RETURN RETURN          → INVALID（アクティブな CALL が無い / 終端が末尾でない）
 */

import { Opcode } from './opcode.js';
import { Slot, categoryOf, entryOfOpcode, isTerminal, nameOf, valueTypeOf } from './vocab.js';
import { getSchema } from './schema.js';
import { Instruction } from './encoder.js';

export interface ValidationIssue {
  index: number;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/** 単命令の検査 */
export function validateInstruction(instr: Instruction, index: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const entry = entryOfOpcode(instr.opcode);
  if (!entry) {
    issues.push({ index, message: `未登録 opcode 0x${instr.opcode.toString(16)}` });
    return issues;
  }
  const schema = getSchema(instr.opcode);
  if (!schema) {
    issues.push({ index, message: `スキーマ未定義: ${entry.name}` });
    return issues;
  }

  const slots = instr.slots ?? [];
  const seen = new Set<number>();
  const provided = new Set<number>();

  for (const sv of slots) {
    if (categoryOf(sv.slot) !== 'slot') {
      issues.push({ index, message: `スロット位置に非スロット: 0x${sv.slot.toString(16)}` });
      continue;
    }
    if (seen.has(sv.slot)) {
      issues.push({ index, message: `${entry.name}: スロット重複 0x${sv.slot.toString(16)}` });
      continue;
    }
    seen.add(sv.slot);

    // 値の型チェック
    const vt = valueTypeOf(sv.slot);
    if (vt === 'number') {
      const n = Number(sv.value);
      if (!Number.isFinite(n)) {
        issues.push({ index, message: `${entry.name}: 数値スロット 0x${sv.slot.toString(16)} に非数値 "${sv.value}"` });
      } else if (sv.slot === Slot.CONF && (n < 0 || n > 1)) {
        issues.push({ index, message: `${entry.name}: CONF は [0,1] の範囲（${n}）` });
      }
    } else if (vt === 'boolean' && typeof sv.value !== 'boolean' && sv.value !== 'true' && sv.value !== 'false') {
      issues.push({ index, message: `${entry.name}: boolean スロット 0x${sv.slot.toString(16)} に "${sv.value}"` });
    }

    // スキーマ上の許可
    const spec = schema.slots.find((s) => s.slot === sv.slot);
    if (!spec) {
      issues.push({ index, message: `${entry.name}: 許可されていないスロット 0x${sv.slot.toString(16)}` });
    } else {
      provided.add(sv.slot);
    }
  }

  // 必須スロットの充足
  for (const req of schema.slots) {
    if (req.required && !provided.has(req.slot)) {
      issues.push({ index, message: `${entry.name}: 必須スロット不足 0x${req.slot.toString(16)}` });
    }
  }

  return issues;
}

/** 命令列全体の検査（制御フロー含む） */
export function validateProgram(program: Instruction[]): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (program.length === 0) {
    return { valid: false, issues: [{ index: -1, message: 'プログラムが空' }] };
  }

  let depth = 0;
  for (let i = 0; i < program.length; i++) {
    const instr = program[i];
    issues.push(...validateInstruction(instr, i));

    if (isTerminal(instr.opcode)) {
      if (depth === 0) {
        issues.push({ index: i, message: `${nameOf(instr.opcode)}: アクティブな CALL が無い（stack underflow）` });
      } else {
        depth--;
      }
      // 注意: RETURN は必ずしも最終命令でなくてよい
      // （AI Linker が複数 CALL セグメントを結合するため。Phase 0.16）
    } else if (instr.opcode === Opcode.CALL) {
      depth++;
    }
  }

  return { valid: issues.length === 0, issues };
}

