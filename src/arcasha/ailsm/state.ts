/**
 * AILSM State — AI State SSA（Memory / Belief / Plan / Reflection）
 *
 * AILSMは意味表現ではなく、AIの内部状態全体をSSAとして管理する実行可能IR（AI State IR）。
 * Memory / Belief / Plan / Reflection もすべて SSA ノードになる。
 *
 *   Task#1
 *     ├─ Memory#4 stores(Value#3)         長期記憶
 *     ├─ Belief#5 informs(Task#1)         ODAR の確信度
 *     ├─ Plan#6 plans(Task#1)             実行計画
 *     └─ Reflection#7 reflects(Task#1)    自己修正
 *
 * GPT/Claude/Gemini と違い、AIの思考（Task→Plan→Belief→CALL→Result→Memory→Reflection）
 * が全て可視化できる。LLVM IR がCPU状態しか持たないのに対し、AILSM は AI の状態全体を持つ。
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import type { AilsmType } from './types.js';

export type StateKind = 'memory' | 'belief' | 'plan' | 'reflection';

export interface StateAddResult {
  graph: AilsmGraph;
  id: number;
}

function withStateNode(
  g: AilsmGraph,
  kind: StateKind,
  label: string,
  type: AilsmType,
  attrs: Record<string, string | number | boolean | string[]>,
  rel: string,
  targetId: number,
): StateAddResult {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const newId = b.addNode(kind, label, type, attrs);
  const t = remap.get(targetId);
  if (t !== undefined) b.connect(t, newId, rel);
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), id: newId };
}

/** 長期記憶: Memory#N stores ... */
export function remember(
  g: AilsmGraph,
  taskId: number,
  key: string,
  value: string | number | boolean,
): StateAddResult {
  const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
  return withStateNode(g, 'memory', key, type, { key, value }, 'stores', taskId);
}

/** 確信度: Belief#N {confidence, expert}（ODAR の入力） */
export function believe(
  g: AilsmGraph,
  taskId: number,
  expert: string,
  confidence: number,
  reason = '',
): StateAddResult {
  return withStateNode(
    g,
    'belief',
    'belief',
    'unknown',
    { confidence, expert, ...(reason ? { reason } : {}) },
    'informs',
    taskId,
  );
}

/** 実行計画: Plan#N {steps} */
export function plan(
  g: AilsmGraph,
  taskId: number,
  steps: string[],
): StateAddResult {
  return withStateNode(g, 'plan', 'plan', 'string', { steps }, 'plans', taskId);
}

/** 自己修正: Reflection#N {cause, fix} */
export function reflect(
  g: AilsmGraph,
  taskId: number,
  cause: string,
  fix = '',
): StateAddResult {
  return withStateNode(
    g,
    'reflection',
    'reflection',
    'string',
    { cause, ...(fix ? { fix } : {}) },
    'reflects',
    taskId,
  );
}
