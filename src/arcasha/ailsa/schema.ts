/**
 * AILSA Schema — 命令ごとのスロット定義（CALL → slot → value の構造）
 *
 * 各命令が「どのスロットを必須/任意で取るか」「終端命令か」を定義する。
 * ここは決定論（AI を使わない）。validator がこのスキーマに従って検査する。
 */

import { Opcode } from './opcode.js';
import {
  AILSARegistry,
  Category,
  DialectId,
  Domain,
  Slot,
  Task,
  entryOfOpcode,
} from './vocab.js';
import { CodeOpcode, MathOpcode, ReasoningOpcode, SearchOpcode } from './dialect.js';

export interface SlotSpec {
  slot: number;
  required: boolean;
}

export interface InstructionSchema {
  opcode: number;
  name: string;
  category: Category;
  dialect: DialectId;
  terminal: boolean;
  slots: SlotSpec[];
}

function def(opcode: number, required: number[] = [], optional: number[] = []): InstructionSchema {
  const e = entryOfOpcode(opcode);
  if (!e) throw new Error(`schema: 未登録 opcode 0x${opcode.toString(16)}`);
  return {
    opcode,
    name: e.name,
    category: e.category,
    dialect: e.dialect,
    terminal: e.terminal === true,
    slots: [
      ...required.map((slot) => ({ slot, required: true })),
      ...optional.map((slot) => ({ slot, required: false })),
    ],
  };
}

const TASK_OPTS = [Slot.GOAL, Slot.INPUT, Slot.OUTPUT, Slot.CONSTRAINT, Slot.CONTEXT, Slot.DEPENDENCY];
const DIALECT_OPTS = [Slot.GOAL, Slot.OUTPUT, Slot.CONSTRAINT, Slot.CONTEXT];

export const SCHEMAS: Record<number, InstructionSchema> = {
  // --- Base ISA: 制御命令 ---
  [Opcode.CALL]: def(Opcode.CALL, [Slot.EXPERT, Slot.TASK_ID], [Slot.DOMAIN, Slot.GOAL, Slot.INPUT, Slot.CONTEXT]),
  [Opcode.RETURN]: def(Opcode.RETURN, [Slot.TASK_ID], [Slot.OUTPUT, Slot.CONF, Slot.TRACE]),
  [Opcode.STORE]: def(Opcode.STORE, [Slot.KEY, Slot.VALUE], [Slot.CONTEXT]),
  [Opcode.LOAD]: def(Opcode.LOAD, [Slot.KEY], [Slot.OUTPUT]),
  [Opcode.FAIL]: def(Opcode.FAIL, [Slot.TASK_ID], [Slot.REASON, Slot.CONF]),
  [Opcode.SUCCESS]: def(Opcode.SUCCESS, [Slot.TASK_ID], [Slot.OUTPUT, Slot.CONF]),
  [Opcode.PLAN]: def(Opcode.PLAN, [], [Slot.GOAL, Slot.CONSTRAINT, Slot.CONTEXT]),
  [Opcode.VERIFY]: def(Opcode.VERIFY, [], [Slot.INPUT, Slot.OUTPUT, Slot.CONF, Slot.NEXT]),
  [Opcode.DECOMPOSE]: def(Opcode.DECOMPOSE, [], [Slot.GOAL, Slot.INPUT]),
  [Opcode.DEPENDENCY]: def(Opcode.DEPENDENCY, [], [Slot.TASK_ID, Slot.DEPENDENCY]),
  [Opcode.PARALLEL]: def(Opcode.PARALLEL, [], [Slot.TASK_ID]),
  [Opcode.MERGE]: def(Opcode.MERGE, [], [Slot.TASK_ID, Slot.OUTPUT]),
  [Opcode.SEARCH]: def(Opcode.SEARCH, [], [Slot.INPUT, Slot.CONTEXT, Slot.CONSTRAINT]),
  [Opcode.RANK]: def(Opcode.RANK, [], [Slot.INPUT, Slot.OUTPUT]),
  [Opcode.FILTER]: def(Opcode.FILTER, [], [Slot.INPUT, Slot.CONSTRAINT, Slot.OUTPUT]),

  // --- タスク動詞 ---
  [Task.SOLVE]: def(Task.SOLVE, [], TASK_OPTS),
  [Task.VERIFY]: def(Task.VERIFY, [], TASK_OPTS),
  [Task.PLAN]: def(Task.PLAN, [], TASK_OPTS),
  [Task.SEARCH]: def(Task.SEARCH, [], TASK_OPTS),
  [Task.PATCH]: def(Task.PATCH, [], TASK_OPTS),
  [Task.TRANSLATE]: def(Task.TRANSLATE, [], TASK_OPTS),
  [Task.SUMMARIZE]: def(Task.SUMMARIZE, [], TASK_OPTS),

  // --- ドメイン ---
  [Domain.MATH]: def(Domain.MATH, [], [Slot.GOAL, Slot.INPUT, Slot.CONTEXT]),
  [Domain.CODE]: def(Domain.CODE, [], [Slot.GOAL, Slot.INPUT, Slot.CONTEXT]),
  [Domain.SEARCH]: def(Domain.SEARCH, [], [Slot.GOAL, Slot.INPUT, Slot.CONTEXT]),
  [Domain.REASONING]: def(Domain.REASONING, [], [Slot.GOAL, Slot.INPUT, Slot.CONTEXT]),

  // --- 専門IR: Math ---
  [MathOpcode.EQ]: def(MathOpcode.EQ, [Slot.INPUT], DIALECT_OPTS),
  [MathOpcode.DERIVE]: def(MathOpcode.DERIVE, [Slot.INPUT], DIALECT_OPTS),
  [MathOpcode.LIMIT]: def(MathOpcode.LIMIT, [Slot.INPUT], DIALECT_OPTS),
  [MathOpcode.MATRIX]: def(MathOpcode.MATRIX, [Slot.INPUT], DIALECT_OPTS),
  [MathOpcode.INTEGRAL]: def(MathOpcode.INTEGRAL, [Slot.INPUT], DIALECT_OPTS),
  [MathOpcode.ADD]: def(MathOpcode.ADD, [Slot.INPUT], DIALECT_OPTS),
  [MathOpcode.SUBTRACT]: def(MathOpcode.SUBTRACT, [Slot.INPUT], DIALECT_OPTS),
  [MathOpcode.MULTIPLY]: def(MathOpcode.MULTIPLY, [Slot.INPUT], DIALECT_OPTS),
  [MathOpcode.DIVIDE]: def(MathOpcode.DIVIDE, [Slot.INPUT], DIALECT_OPTS),
  [MathOpcode.SQRT]: def(MathOpcode.SQRT, [Slot.INPUT], DIALECT_OPTS),
  [MathOpcode.SQUARE]: def(MathOpcode.SQUARE, [Slot.INPUT], DIALECT_OPTS),

  // --- 専門IR: Code ---
  [CodeOpcode.FUNCTION]: def(CodeOpcode.FUNCTION, [Slot.INPUT], DIALECT_OPTS),
  [CodeOpcode.CLASS]: def(CodeOpcode.CLASS, [Slot.INPUT], DIALECT_OPTS),
  [CodeOpcode.PATCH]: def(CodeOpcode.PATCH, [Slot.INPUT], DIALECT_OPTS),
  [CodeOpcode.BUILD]: def(CodeOpcode.BUILD, [Slot.INPUT], DIALECT_OPTS),
  [CodeOpcode.TEST]: def(CodeOpcode.TEST, [Slot.INPUT], DIALECT_OPTS),

  // --- 専門IR: Search ---
  [SearchOpcode.QUERY]: def(SearchOpcode.QUERY, [Slot.INPUT], [Slot.OUTPUT, Slot.CONSTRAINT]),
  [SearchOpcode.EXTRACT]: def(SearchOpcode.EXTRACT, [Slot.INPUT], [Slot.OUTPUT, Slot.CONSTRAINT]),

  // --- 専門IR: Reasoning ---
  [ReasoningOpcode.CAUSE]: def(ReasoningOpcode.CAUSE, [Slot.INPUT], DIALECT_OPTS),
  [ReasoningOpcode.GOAL]: def(ReasoningOpcode.GOAL, [Slot.INPUT], DIALECT_OPTS),
};

export function getSchema(opcode: number): InstructionSchema | undefined {
  return SCHEMAS[opcode];
}

/** Registry の全命令にスキーマが定義されていることを強制する（土台の完全性）。 */
export function assertSchemasComplete(r: AILSARegistry): void {
  for (const e of r.instructions) {
    if (e.category === 'slot') continue; // スロットは命令ではなくフィールド識別子
    if (!(e.opcode in SCHEMAS)) {
      throw new Error(`スキーマ未定義の命令: ${e.name} (0x${e.opcode.toString(16)})`);
    }
  }
}
