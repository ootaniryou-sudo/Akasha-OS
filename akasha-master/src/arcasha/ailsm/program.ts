/**
 * AI Program（Phase 0.14）— AILSM 上に直接書く「AI プログラム」
 *
 * 自然言語 → Compiler → IR だけでなく、AILSM で直接プログラムを書ける。
 *
 *   PLAN → CALL math → EQ → VERIFY → SYSCALL_REFLECT → CALL math → RETURN
 *
 * AiProgram は手続き的 DSL で AI プログラムを組み立て、assemble() で
 * AILSA 命令列（AI Assembly）、encode() でバイト列（Bytecode）へ変換する。
 */

import { Slot, Task } from '../ailsa/vocab.js';
import { Opcode, SyscallOpcode } from '../ailsa/opcode.js';
import { MathOpcode } from '../ailsa/dialect.js';
import { encode as codecEncode } from '../ailsa/codec.js';
import type { Instruction } from '../ailsa/encoder.js';

export type ProgramStep =
  | { kind: 'task'; goal: string }
  | { kind: 'call'; expert: string; input?: string }
  | { kind: 'math'; opcode: MathOpcode; input: string }
  | { kind: 'verify'; target?: string }
  | { kind: 'reflect'; cause: string; fix?: string }
  | { kind: 'return'; result?: string };

export class AiProgram {
  readonly name: string;
  private readonly steps: ProgramStep[] = [];
  private taskCounter = 0;

  constructor(name: string) {
    this.name = name;
  }

  plan(goal: string): this {
    this.steps.push({ kind: 'task', goal });
    return this;
  }

  call(expert: string, input?: string): this {
    this.steps.push({ kind: 'call', expert, input });
    return this;
  }

  math(opcode: MathOpcode, input: string): this {
    this.steps.push({ kind: 'math', opcode, input });
    return this;
  }

  verify(target?: string): this {
    this.steps.push({ kind: 'verify', target });
    return this;
  }

  reflect(cause: string, fix?: string): this {
    this.steps.push({ kind: 'reflect', cause, fix });
    return this;
  }

  returns(result?: string): this {
    this.steps.push({ kind: 'return', result });
    return this;
  }

  stepCount(): number {
    return this.steps.length;
  }

  /** AI プログラム → AILSA 命令列（AI Assembly） */
  assemble(): Instruction[] {
    const instrs: Instruction[] = [];
    let lastCallTid = '0';
    let callCount = 0;
    const tid = (): string => `${this.taskCounter++}`;

    for (const step of this.steps) {
      switch (step.kind) {
        case 'task':
          instrs.push({ opcode: Task.SOLVE, slots: [{ slot: Slot.GOAL, value: step.goal }] });
          break;
        case 'call': {
          lastCallTid = tid();
          callCount++;
          const slots: { slot: number; value: string | number | boolean }[] = [
            { slot: Slot.EXPERT, value: step.expert },
            { slot: Slot.TASK_ID, value: lastCallTid },
          ];
          if (step.input) slots.push({ slot: Slot.INPUT, value: step.input });
          instrs.push({ opcode: Opcode.CALL, slots });
          break;
        }
        case 'math':
          instrs.push({ opcode: step.opcode, slots: [{ slot: Slot.INPUT, value: step.input }] });
          break;
        case 'verify':
          instrs.push({
            opcode: Opcode.VERIFY,
            slots: step.target ? [{ slot: Slot.INPUT, value: step.target }] : undefined,
          });
          break;
        case 'reflect': {
          const slots: { slot: number; value: string | number | boolean }[] = [
            { slot: Slot.REASON, value: step.cause },
          ];
          if (step.fix) slots.push({ slot: Slot.STRATEGY, value: step.fix });
          instrs.push({ opcode: SyscallOpcode.REFLECT, slots });
          break;
        }
        case 'return':
          if (callCount > 0) {
            instrs.push({ opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: lastCallTid }] });
          }
          break;
      }
    }
    return instrs;
  }

  /** AI プログラム → バイト列（Bytecode）。検証を通らないものは絶対に返さない。 */
  encode(): Uint8Array {
    return codecEncode(this.assemble());
  }
}
