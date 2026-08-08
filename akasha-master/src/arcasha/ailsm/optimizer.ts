/**
 * AILSM Optimizer — Pass Manager（LLVM Optimization Pass 相当）
 *
 * 最適化レベル -O0..-O3 で Pass を差し替え可能にする（LLVM の -O1/-O2/-O3 と同型）。
 *
 * Pass:
 *   - DeadNodeElimination  (-O1): task から到達不能なノードを除去（DCE）
 *   - Dedup                (-O1): 同一ノードの重複除去
 *   - ConstantFolding      (-O2): 純粋な数式（2+3）を評価して定数へ畳み込む
 *   - BatchDetection       (-O2): 連続する同一ラベルの Batching 候補を検出
 *     （CALL Math ×3 → CALL Math Batch=3 の前段。実行時は Phase 2 で実効化）
 *
 * 将来 Pass: DeadExpertElimination / Reordering / Cost-based 選択（-O3）
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph, AilsmNode } from './ailsm.js';
import { Opcode } from '../ailsa/opcode.js';
import { Slot } from '../ailsa/vocab.js';
import type { Instruction } from '../ailsa/encoder.js';

export type OptimizationLevel = 0 | 1 | 2 | 3;

export interface PassContext {
  notes: string[];
  batches: string[][];
}

export interface PassResult {
  graph: AilsmGraph;
  batches: string[][];
  notes: string[];
}

export interface OptimizationPass {
  readonly name: string;
  readonly minLevel: OptimizationLevel;
  run(g: AilsmGraph, ctx: PassContext): AilsmGraph;
}

export class PassManager {
  private readonly passes: OptimizationPass[] = [];

  add(p: OptimizationPass): void {
    this.passes.push(p);
  }

  run(g: AilsmGraph, level: OptimizationLevel): PassResult {
    let graph = g;
    const ctx: PassContext = { notes: [], batches: [] };
    for (const p of this.passes) {
      if (level < p.minLevel) continue;
      graph = p.run(graph, ctx);
    }
    return { graph, batches: ctx.batches, notes: ctx.notes };
  }
}

// ── ヘルパー ──
function nodeLabel(n: AilsmNode): string {
  return `${n.kind}#${n.id}:${n.label}`;
}

function rebuild(g: AilsmGraph, keep: Set<number>, ctx: PassContext): AilsmGraph {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    if (!keep.has(n.id)) {
      ctx.notes.push(`dead node removed: ${nodeLabel(n)}`);
      continue;
    }
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    b.connect(from, to, e.rel);
  }
  return b.graph();
}

function reachable(g: AilsmGraph, start: number): Set<number> {
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const e of g.edges) {
      if (e.from === cur && !seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return seen;
}

// ── Pass: DeadNodeElimination（到達不能ノード除去 = DCE） ──
export const DeadNodeEliminationPass: OptimizationPass = {
  name: 'DeadNodeElimination',
  minLevel: 1,
  run(g, ctx) {
    const task = g.nodes.find((n) => n.kind === 'task');
    if (!task) return g;
    return rebuild(g, reachable(g, task.id), ctx);
  },
};

// ── Pass: Dedup（同一ノードの重複除去） ──
function keyOf(n: AilsmNode): string {
  return `${n.kind}:${n.label}:${JSON.stringify(n.type)}:${JSON.stringify(n.attrs)}:${JSON.stringify(n.constraints ?? {})}`;
}

export const DedupPass: OptimizationPass = {
  name: 'Dedup',
  minLevel: 1,
  run(g, ctx) {
    const b = new AilsmBuilder();
    const remap = new Map<number, number>();
    const seen = new Map<string, number>();
    for (const n of g.nodes) {
      const k = keyOf(n);
      const existing = seen.get(k);
      if (existing !== undefined) {
        remap.set(n.id, existing);
        ctx.notes.push(`duplicate removed: ${nodeLabel(n)} -> #${existing}`);
      } else {
        const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
        seen.set(k, id);
        remap.set(n.id, id);
      }
    }
    for (const e of g.edges) {
      const from = remap.get(e.from);
      const to = remap.get(e.to);
      if (from === undefined || to === undefined || from === to) continue;
      b.connect(from, to, e.rel);
    }
    return b.graph();
  },
};

// ── Constant Folding: 純粋数式の評価（決定論・安全） ──
class Arith {
  private pos = 0;
  constructor(private readonly s: string) {}

  parse(): number {
    this.skipWs();
    const v = this.expr();
    this.skipWs();
    if (this.pos !== this.s.length) throw new Error('trailing');
    return v;
  }

  private skipWs(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }

  private expr(): number {
    let v = this.term();
    for (;;) {
      this.skipWs();
      const c = this.s[this.pos];
      if (c === '+') { this.pos++; v += this.term(); }
      else if (c === '-') { this.pos++; v -= this.term(); }
      else break;
    }
    return v;
  }

  private term(): number {
    let v = this.factor();
    for (;;) {
      this.skipWs();
      const c = this.s[this.pos];
      if (c === '*') { this.pos++; v *= this.factor(); }
      else if (c === '/') {
        this.pos++;
        const d = this.factor();
        if (d === 0) throw new Error('div0');
        v /= d;
      } else break;
    }
    return v;
  }

  private factor(): number {
    this.skipWs();
    const c = this.s[this.pos];
    if (c === '(') {
      this.pos++;
      const v = this.expr();
      this.skipWs();
      if (this.s[this.pos] !== ')') throw new Error('paren');
      this.pos++;
      return v;
    }
    if (c === '-') {
      this.pos++;
      return -this.factor();
    }
    const m = /^\d+(?:\.\d+)?/.exec(this.s.slice(this.pos));
    if (!m) throw new Error('num');
    this.pos += m[0].length;
    return parseFloat(m[0]);
  }
}

export function evalArith(expr: string): number | null {
  if (/[a-zA-Z=^]/.test(expr)) return null; // 変数・等号・冪を含む式は畳み込まない
  if (!/^[\d+\-*/().\s]+$/.test(expr)) return null;
  try {
    return new Arith(expr).parse();
  } catch {
    return null; // 0除算・構文エラーは畳み込まない（安全側）
  }
}

export const ConstantFoldingPass: OptimizationPass = {
  name: 'ConstantFolding',
  minLevel: 2,
  run(g, ctx) {
    const b = new AilsmBuilder();
    const remap = new Map<number, number>();
    for (const n of g.nodes) {
      if (n.kind === 'object' && n.label === 'equation' && typeof n.attrs.expr === 'string') {
        const folded = evalArith(n.attrs.expr);
        if (folded !== null) {
          const id = b.addNode('value', 'constant', 'number', { value: folded });
          remap.set(n.id, id);
          ctx.notes.push(`constant fold: ${n.attrs.expr} = ${folded}`);
          continue;
        }
      }
      const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
      remap.set(n.id, id);
    }
    for (const e of g.edges) {
      const from = remap.get(e.from);
      const to = remap.get(e.to);
      if (from === undefined || to === undefined || from === to) continue;
      b.connect(from, to, e.rel);
    }
    return b.graph();
  },
};

// ── Pass: BatchDetection（Batching 候補の検出） ──
export const BatchDetectionPass: OptimizationPass = {
  name: 'BatchDetection',
  minLevel: 2,
  run(g, ctx) {
    let run: string[] = [];
    const flush = (): void => {
      if (run.length > 1) {
        ctx.batches.push([...run]);
        ctx.notes.push(`batch candidate: [${run.join(', ')}]`);
      }
      run = [];
    };
    for (const n of g.nodes) {
      if (n.kind === 'object' || n.kind === 'value') {
        if (run.length > 0 && run[run.length - 1] !== n.label) flush();
        run.push(n.label);
      } else {
        flush();
      }
    }
    flush();
    return g;
  },
};

/** 既定 Pass セットで最適化を実行する（デフォルト -O2） */
export function optimize(g: AilsmGraph, level: OptimizationLevel = 2): PassResult {
  const pm = new PassManager();
  pm.add(DeadNodeEliminationPass);
  pm.add(DedupPass);
  pm.add(ConstantFoldingPass);
  pm.add(BatchDetectionPass);
  return pm.run(g, level);
}

// ────────────────────────────────────────────────────────────────
// Phase 0.15 — 命令レベル最適化（LLVM の Loop Opt / Inlining / GVN / DCE 相当）
// ────────────────────────────────────────────────────────────────

export interface ExpertMeta {
  latencyMs: number;
  cost: number;
}

const DEFAULT_META: Record<string, ExpertMeta> = {
  math: { latencyMs: 24, cost: 0.4 },
  code: { latencyMs: 30, cost: 0.5 },
  search: { latencyMs: 18, cost: 0.3 },
  reasoning: { latencyMs: 40, cost: 0.6 },
  general: { latencyMs: 25, cost: 0.4 },
};

export interface InstructionOptResult {
  instructions: Instruction[];
  notes: string[];
  stats: {
    before: number;
    after: number;
    callsBefore: number;
    callsAfter: number;
    expertsBefore: number;
    expertsAfter: number;
    latencyMsBefore: number;
    latencyMsAfter: number;
    costBefore: number;
    costAfter: number;
  };
}

function expertOf(instr: Instruction): string {
  return String(instr.slots?.find((s) => s.slot === Slot.EXPERT)?.value ?? '');
}

/** 命令レベル最適化: DCE（重複除去）+ 同一Expertへの連続CALLバッチ化 */
export function optimizeInstructions(
  instrs: Instruction[],
  meta: Record<string, ExpertMeta> = DEFAULT_META,
): InstructionOptResult {
  const notes: string[] = [];

  // 1. DCE: 連続する同一命令の除去
  const deduped: Instruction[] = [];
  for (const instr of instrs) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.opcode === instr.opcode && JSON.stringify(prev.slots ?? null) === JSON.stringify(instr.slots ?? null)) {
      notes.push(`DCE: duplicate 0x${instr.opcode.toString(16)} removed`);
      continue;
    }
    deduped.push(instr);
  }

  // 2. 同一Expertへの連続CALLをバッチ化（CALL math ×3 → CALL math Batch=3）
  const out: Instruction[] = [];
  let i = 0;
  while (i < deduped.length) {
    const instr = deduped[i];
    if (instr.opcode === Opcode.CALL) {
      const expert = expertOf(instr);
      let count = 1;
      while (
        i + count < deduped.length &&
        deduped[i + count].opcode === Opcode.CALL &&
        expertOf(deduped[i + count]) === expert
      ) {
        count++;
      }
      if (count > 1) {
        notes.push(`BATCH: CALL ${expert} x${count} → CALL ${expert} Batch=${count}`);
        out.push({ ...instr }); // 単一 CALL に畳み込み
        i += count;
        continue;
      }
    }
    out.push(instr);
    i++;
  }

  // 3. 統計（CALL数 / Expert数 / Latency / Cost の削減を測る）
  const callsBefore = deduped.filter((x) => x.opcode === Opcode.CALL).length;
  const callsAfter = out.filter((x) => x.opcode === Opcode.CALL).length;
  const expertsBefore = new Set(deduped.filter((x) => x.opcode === Opcode.CALL).map(expertOf)).size;
  const expertsAfter = new Set(out.filter((x) => x.opcode === Opcode.CALL).map(expertOf)).size;
  const sum = (list: Instruction[], key: 'latencyMs' | 'cost'): number =>
    list.filter((x) => x.opcode === Opcode.CALL).reduce((a, x) => a + (meta[expertOf(x)]?.[key] ?? 0), 0);

  return {
    instructions: out,
    notes,
    stats: {
      before: deduped.length,
      after: out.length,
      callsBefore,
      callsAfter,
      expertsBefore,
      expertsAfter,
      latencyMsBefore: sum(deduped, 'latencyMs'),
      latencyMsAfter: sum(out, 'latencyMs'),
      costBefore: sum(deduped, 'cost'),
      costAfter: sum(out, 'cost'),
    },
  };
}

