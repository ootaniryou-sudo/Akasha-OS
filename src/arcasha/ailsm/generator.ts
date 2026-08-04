/**
 * AILSA Generator — AILSM → AILSA命令列（Back-End Compiler）
 *
 * AILSMグラフを読み、Phase 0 の命令セット（AILSA ISA）へ変換する。
 * 生成された命令列は Phase 0 の Validator / Codec で再検証される。
 */

import { Domain, Slot, Task } from '../ailsa/vocab.js';
import { Opcode } from '../ailsa/opcode.js';
import { MathOpcode } from '../ailsa/dialect.js';
import type { Instruction } from '../ailsa/encoder.js';
import type { AilsmGraph } from './ailsm.js';
import type { CanonicalAction } from './normalizer.js';

const TASK_OF_INTENT: Record<string, Task> = {
  solve: Task.SOLVE,
  summarize: Task.SUMMARIZE,
  search: Task.SEARCH,
  verify: Task.VERIFY,
  code: Task.PATCH,
};

const EXPERT_OF_DOMAIN: Record<string, string> = {
  math: 'math',
  code: 'code',
  search: 'search',
  reasoning: 'reasoning',
};

const OPCODE_OF_ACTION: Partial<Record<CanonicalAction, MathOpcode>> = {
  ACTION_ADD: MathOpcode.ADD,
  ACTION_SUBTRACT: MathOpcode.SUBTRACT,
  ACTION_MULTIPLY: MathOpcode.MULTIPLY,
  ACTION_DIVIDE: MathOpcode.DIVIDE,
  ACTION_SQRT: MathOpcode.SQRT,
  ACTION_SQUARE: MathOpcode.SQUARE,
  ACTION_INTEGRAL: MathOpcode.INTEGRAL,
  ACTION_DERIVE: MathOpcode.DERIVE,
  ACTION_LIMIT: MathOpcode.LIMIT,
  ACTION_EQUATION: MathOpcode.EQ,
  ACTION_MATRIX: MathOpcode.MATRIX,
};

type SlotValue = { slot: number; value: string | number | boolean };

/** スロット追加（重複時は既存値に追記して結合 — スロット重複を構造的に防ぐ） */
function addSlot(slots: SlotValue[], slot: number, value: string | number | boolean): void {
  const existing = slots.find((s) => s.slot === slot);
  if (existing) {
    existing.value = `${String(existing.value)} ${String(value)}`.trim();
  } else {
    slots.push({ slot, value });
  }
}

export function generateAilsa(g: AilsmGraph): Instruction[] {
  const instrs: Instruction[] = [];
  const task = g.nodes.find((n) => n.kind === 'task');
  if (!task) return instrs;

  const domain = String(task.attrs.domain ?? 'unknown');
  const intent = String(task.attrs.intent ?? 'unknown');
  const expert = EXPERT_OF_DOMAIN[domain] ?? 'general';
  const tid = '0';

  instrs.push({
    opcode: Opcode.CALL,
    slots: [
      { slot: Slot.EXPERT, value: expert },
      { slot: Slot.TASK_ID, value: tid },
    ],
  });

  const goalSlots: SlotValue[] = [];
  addSlot(goalSlots, Slot.GOAL, task.label);
  if (task.attrs.output) addSlot(goalSlots, Slot.OUTPUT, String(task.attrs.output));

  // 要約/検索など: 入力テキストを SLOT_INPUT へ
  const inputNode = g.nodes.find((n) => n.kind === 'value' && n.label === 'input');
  if (inputNode) {
    const text = String((inputNode.attrs.text as string | undefined) ?? '');
    if (text) addSlot(goalSlots, Slot.INPUT, text);
  }

  const equation = g.nodes.find((n) => n.type === 'equation');
  const inputExpr = equation ? String((equation.attrs.expr as string | undefined) ?? '') : null;

  // 数学アクション → 数学オペコード（入力式が必要）
  const actions = (task.attrs.actions as string[] | undefined) ?? [];
  let mathOpEmitted = 0;
  for (const action of actions) {
    const op = OPCODE_OF_ACTION[action as CanonicalAction];
    if (op === undefined) {
      addSlot(goalSlots, Slot.GOAL, action);
      continue;
    }
    if (inputExpr) {
      instrs.push({ opcode: op, slots: [{ slot: Slot.INPUT, value: inputExpr }] });
      mathOpEmitted++;
    } else {
      addSlot(goalSlots, Slot.GOAL, action);
    }
  }

  // 入力式があり数学オペコードが未出力なら、既定の EQ を出力
  if (inputExpr && mathOpEmitted === 0) {
    instrs.push({ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: inputExpr }] });
  }

  const taskOp = TASK_OF_INTENT[intent] ?? Task.SOLVE;
  instrs.push({ opcode: taskOp, slots: goalSlots });
  instrs.push({ opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: tid }] });

  return instrs;
}

// Domain enum を参照しておく（将来のドメイン拡張時の整合確認用）
export const AILSM_DOMAINS = [Domain.MATH, Domain.CODE, Domain.SEARCH, Domain.REASONING] as const;
