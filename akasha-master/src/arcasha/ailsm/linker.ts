/**
 * AI Linker（Phase 0.16）— 複数 Expert の IR（Object File 相当）を結合して Executable Task にする
 *
 *   Math IR + Search IR + Planner IR  →  単一 AILSA プログラム（Executable Task）
 *
 * 各セグメントを CALL/RETURN でラップし、シンボルテーブル（セグメント → task_id）を
 * 生成する。リンク結果は Phase 0 の Validator/Codec で再検証される。
 */

import { Slot } from '../ailsa/vocab.js';
import { Opcode } from '../ailsa/opcode.js';
import { encode as codecEncode } from '../ailsa/codec.js';
import { validateProgram } from '../ailsa/validator.js';
import type { Instruction } from '../ailsa/encoder.js';

export interface LinkSegment {
  name: string;
  expert: string;
  instructions: Instruction[];
}

export interface LinkedProgram {
  name: string;
  segments: { name: string; expert: string; taskId: string }[];
  instructions: Instruction[];
  bytes: Uint8Array;
}

/** 複数 Expert IR をリンクして Executable Task を生成する */
export function link(name: string, segments: LinkSegment[]): LinkedProgram {
  // 各セグメントは単体で妥当であること（壊れない土台）
  for (const seg of segments) {
    const v = validateProgram(seg.instructions);
    if (!v.valid) {
      throw new Error(`link: セグメント ${seg.name} が不正 — ${v.issues.map((i) => i.message).join('; ')}`);
    }
  }

  const instructions: Instruction[] = [];
  const symbols: { name: string; expert: string; taskId: string }[] = [];

  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    const tid = `${idx}`;
    instructions.push({
      opcode: Opcode.CALL,
      slots: [
        { slot: Slot.EXPERT, value: seg.expert },
        { slot: Slot.TASK_ID, value: tid },
      ],
    });
    instructions.push(...seg.instructions);
    instructions.push({ opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: tid }] });
    symbols.push({ name: seg.name, expert: seg.expert, taskId: tid });
  }

  const bytes = codecEncode(instructions); // 検証込みでエンコード
  return { name, segments: symbols, instructions, bytes };
}

