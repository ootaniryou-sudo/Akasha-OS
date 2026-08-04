/**
 * AILSM Optimizer — AILSMレベルの決定論最適化（LLVM Pass 相当）
 *
 * - 重複ノードの除去（同一 kind+label+type+attrs）
 * - 自己ループ除去
 * - 連続する同一ラベルの実行単位の Batching 候補検出
 *   （CALL Math ×3 → CALL Math Batch=3 の前段。実行時は Phase 2 で実効化）
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';

export interface OptimizeResult {
  graph: AilsmGraph;
  batches: string[][];
}

function keyOf(n: { kind: string; label: string; type: string; attrs: Record<string, unknown> }): string {
  return `${n.kind}:${n.label}:${n.type}:${JSON.stringify(n.attrs)}`;
}

export function optimize(g: AilsmGraph): OptimizeResult {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  const seen = new Map<string, number>();

  // 重複ノードの除去（最初の出現を正とする）
  for (const n of g.nodes) {
    const k = keyOf(n);
    const existing = seen.get(k);
    if (existing !== undefined) {
      remap.set(n.id, existing);
    } else {
      const id = b.addNode(n.kind, n.label, n.type, n.attrs);
      seen.set(k, id);
      remap.set(n.id, id);
    }
  }

  // エッジの再マップ（自己ループは除去）
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from === undefined || to === undefined) continue;
    if (from === to) continue;
    b.connect(from, to, e.rel);
  }

  // Batching 候補: 同一ラベルの object/value ノードの連続
  const batches: string[][] = [];
  let run: string[] = [];
  for (const n of b.graph().nodes) {
    if (n.kind === 'object' || n.kind === 'value') {
      if (run.length > 0 && run[run.length - 1] !== n.label) {
        if (run.length > 1) batches.push([...run]);
        run = [];
      }
      run.push(n.label);
    } else {
      if (run.length > 1) batches.push([...run]);
      run = [];
    }
  }
  if (run.length > 1) batches.push([...run]);

  return { graph: b.graph(), batches };
}
