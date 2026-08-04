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
import type { AbiVersion, CapabilityAbi, ContextRef, ErrorAbi } from './abi.js';
import { hasEquation } from './slice.js';
import type { ExpertKind } from './slice.js';

export interface DriverRequest {
  program: Instruction[]; // AILSA 命令列（対象セグメント）
  abiVersion: AbiVersion;
}

/** Long Context の受け渡し（Context ABI）: 実体ではなく ContextRef を渡す */
export interface ContextDriverRequest {
  contextRef: ContextRef;
  loadedText: string; // Slice Loader が供給したページ実体（数ページだけ）
  abiVersion: AbiVersion;
  expert: ExpertKind;
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
  /** Mock は同期 / 実LLMは非同期。呼び出し側は await を兼ねる */
  invoke(req: DriverRequest): DriverResponse | Promise<DriverResponse>;
  /** Long Context ABI: ContextRef を受け取り、供給されたページだけを処理する */
  invokeContext?(req: ContextDriverRequest): DriverResponse | Promise<DriverResponse>;
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

  /**
   * Long Context ABI: Expert は ContextRef と供給されたページ（Slice）だけを見る。
   * 実体全体は Kernel が保持している（ここでは loadedText として供給済み）。
   */
  invokeContext(req: ContextDriverRequest): DriverResponse {
    const trace: string[] = [];
    if (req.abiVersion.major !== this.abiVersion.major || req.abiVersion.minor > this.abiVersion.minor) {
      return { ok: false, error: ERRORS.UNSUPPORTED_ABI, trace: ['abi version mismatch'] };
    }
    trace.push(`CONTEXT#${req.contextRef.contextId} pages=[${req.contextRef.pageIds.join(',')}]`);

    if (this.id === 'math') {
      // 供給されたページから数式だけを取り出して解析
      const eqs = req.loadedText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && hasEquation(l));
      const result = eqs.length > 0 ? eqs.join(' ; ') : 'no equation in slice';
      trace.push(`MATH(slice ${req.loadedText.length} chars) -> ${result}`);
      return { ok: true, result, trace };
    }
    if (this.id === 'search') {
      // 供給されたページ（検索結果）をそのまま返す
      const result = req.loadedText.trim() !== '' ? `[doc: ${req.loadedText.split('\n')[0]}]` : '[no results]';
      trace.push(`SEARCH(slice) -> ${result}`);
      return { ok: true, result, trace };
    }
    return { ok: false, error: ERRORS.UNSUPPORTED_OP, trace: [...trace, 'unsupported context op'] };
  }

  private exec(instr: Instruction): { trace: string; result?: string | number; error?: ErrorAbi } | null {    const input = instr.slots?.find((s) => s.slot === Slot.INPUT)?.value;
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

    if (this.id === 'planning' || this.id === 'reasoning') {
      if (instr.opcode === Task.SUMMARIZE || instr.opcode === 0x0a) {
        return { trace: `PLAN(${s})`, result: `plan: ${s.slice(0, 24)}` };
      }
      return null;
    }

    // 専門 Expert（Phase 3.0: 10 種）— 決定論の canned 応答
    const CANNED: Record<string, (t: string) => string> = {
      programming: (t) => `code: function solve() { /* ${t} */ }`,
      vision: (t) => `vision: [${t}] を解析 → 物体 3 件 / テキスト 1 件`,
      translate: (t) => `translate: "${t}" → English: ${t.replace(/\s+/g, ' ')}`,
      summarizer: (t) => `summary: ${t.slice(0, 16)}...（${t.length}字）`,
      retriever: (t) => `retrieve: [doc-${t.length}] を取得`,
      memory: (t) => `memory: "${t.slice(0, 14)}" を保存しました`,
    };
    if (CANNED[this.id]) {
      return { trace: `${this.id.toUpperCase()}(${s})`, result: CANNED[this.id](s) };
    }

    return null;
  }
}
