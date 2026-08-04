/**
 * Expert Driver（Phase 0.18）— Kernel と LLM をつなぐ共通インターフェース
 *
 *   Kernel → Driver → LLM（Qwen / Gemma / Phi / Llama を共通 ABI で呼ぶ）
 *
 * MockExpertDriver は決定論で AILSA 命令列を「実行」する（実モデル差し替え前のスタブ）。
 * 実モデルドライバは同じ ExpertDriver インターフェースを実装するだけで差し替えられる。
 */

import { Slot, Task } from '../ailsa/vocab.js';
import { Opcode } from '../ailsa/opcode.js';
import { MathOpcode, SearchOpcode } from '../ailsa/dialect.js';
import type { Instruction } from '../ailsa/encoder.js';
import { evalArith } from './optimizer.js';
import { ABI_VERSION_1_0, ERRORS } from './abi.js';
import type { AbiVersion, CapabilityAbi, ErrorAbi } from './abi.js';

export interface DriverRequest {
  program: Instruction[]; // AILSA 命令列（対象セグメント）
  abiVersion: AbiVersion;
}

export interface DriverResponse {
  ok: boolean;
  result?: string | number | null;
  error?: ErrorAbi;
  trace: string[];
}

export interface ExpertDriver {
  readonly id: string;
  readonly name: string;
  readonly abiVersion: AbiVersion;
  readonly capability: CapabilityAbi;
  supports(opcode: number): boolean;
  invoke(req: DriverRequest): DriverResponse;
}

export class MockExpertDriver implements ExpertDriver {
  readonly abiVersion: AbiVersion = ABI_VERSION_1_0;
  readonly capability: CapabilityAbi;
  private readonly supported: ReadonlySet<number>;

  constructor(
    readonly id: string,
    readonly name: string,
    supportedOpcodes: readonly number[] = [],
    capability: CapabilityAbi = { requires: [], supports: ['string'], prefers: [] },
  ) {
    this.supported = new Set(supportedOpcodes);
    this.capability = capability;
  }

  supports(opcode: number): boolean {
    return this.supported.has(opcode);
  }

  invoke(req: DriverRequest): DriverResponse {
    const trace: string[] = [];
    // Version Negotiation: Kernel の ABI が Expert の ABI を満たすか
    if (req.abiVersion.major !== this.abiVersion.major || req.abiVersion.minor > this.abiVersion.minor) {
      return { ok: false, error: ERRORS.UNSUPPORTED_ABI, trace: ['abi version mismatch'] };
    }

    let result: string | number | null = null;
    for (const instr of req.program) {
      const handled = this.exec(instr);
      if (!handled) continue;
      trace.push(handled.trace);
      if (handled.error) return { ok: false, error: handled.error, trace };
      if (handled.result !== undefined) result = handled.result;
    }
    return { ok: true, result, trace };
  }

  private exec(instr: Instruction): { trace: string; result?: string | number; error?: ErrorAbi } | null {
    const input = instr.slots?.find((s) => s.slot === Slot.INPUT)?.value;
    const s = typeof input === 'string' ? input : input === undefined ? '' : String(input);

    if (this.id === 'math') {
      if (/^[+-]?\d+(?:\.\d+)?\s*\/\s*0(?:\.0+)?$/.test(s)) {
        return { trace: `ERR: division by zero (${s})`, error: ERRORS.DIVISION_BY_ZERO };
      }
      switch (instr.opcode) {
        case MathOpcode.EQ: {
          const v = evalArith(s);
          return { trace: `EQ(${s})`, result: v !== null ? v : `solution(${s})` };
        }
        case MathOpcode.INTEGRAL:
          return { trace: `INTEGRAL(${s})`, result: `∫${s} dx + C` };
        case MathOpcode.DERIVE:
          return { trace: `DERIVE(${s})`, result: `d/dx(${s})` };
        case MathOpcode.ADD:
        case MathOpcode.SUBTRACT:
        case MathOpcode.MULTIPLY:
        case MathOpcode.DIVIDE: {
          const v = evalArith(s);
          return v !== null ? { trace: `ARITH(${s})`, result: v } : { trace: `ARITH(${s}) skipped` };
        }
        default:
          return null;
      }
    }

    if (this.id === 'search') {
      if (instr.opcode === Opcode.SEARCH || instr.opcode === SearchOpcode.QUERY || instr.opcode === Task.SEARCH) {
        return { trace: `SEARCH(${s})`, result: '[doc1, doc2, doc3]' };
      }
      return null;
    }

    return null;
  }
}
