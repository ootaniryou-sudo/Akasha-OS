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

export type StateKind =
  | 'memory' | 'belief' | 'plan' | 'reflection' | 'capability' | 'schedule'
  | 'process' | 'thread';

export const PROCESS_STATES = ['created', 'ready', 'running', 'waiting', 'finished', 'failed'] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];

const VALID_TRANSITIONS: Record<ProcessState, readonly ProcessState[]> = {
  created: ['ready'],
  ready: ['running', 'waiting', 'failed'],
  running: ['ready', 'waiting', 'finished', 'failed'],
  waiting: ['ready', 'failed'],
  finished: [],
  failed: [],
};

export function isProcessState(s: string): s is ProcessState {
  return (PROCESS_STATES as readonly string[]).includes(s);
}

export function canTransition(from: ProcessState, to: ProcessState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

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

/** 能力: Capability#N {expert, accuracy, latency, cost, language}（ODAR の入力） */
export function capability(
  g: AilsmGraph,
  taskId: number,
  expert: string,
  accuracy: number,
  latency: number,
  cost: number,
  language = 'IR',
): StateAddResult {
  return withStateNode(
    g,
    'capability',
    'capability',
    'unknown',
    { expert, accuracy, latency, cost, language },
    'informs',
    taskId,
  );
}

/** 実行計画: Schedule#N {node, priority, eta, cost}（ODAR = SSA） */
export function schedule(
  g: AilsmGraph,
  taskId: number,
  node: string,
  priority: number,
  eta: number,
  cost: number,
): StateAddResult {
  return withStateNode(
    g,
    'schedule',
    'schedule',
    'unknown',
    { node, priority, eta, cost },
    'schedules',
    taskId,
  );
}

/** AI Process: Process#N {state, owner, priority, memoryBytes}（AI OS のプロセス相当） */
export function createProcess(
  g: AilsmGraph,
  taskId: number,
  spec: { owner: string; priority: number; memoryBytes?: number },
): StateAddResult {
  const attrs: Record<string, string | number | boolean | string[]> = {
    state: 'created',
    owner: spec.owner,
    priority: spec.priority,
  };
  if (spec.memoryBytes !== undefined) attrs.memoryBytes = spec.memoryBytes;
  return withStateNode(g, 'process', 'process', 'unknown', attrs, 'processes', taskId);
}

/** AI Thread: Thread#N {label, state}（親 Process から生える） */
export function spawnThread(
  g: AilsmGraph,
  processId: number,
  label: string,
): StateAddResult {
  return withStateNode(g, 'thread', 'thread', 'unknown', { label, state: 'ready' }, 'threads', processId);
}

/** プロセスの状態遷移（不正遷移は例外 — 壊れない土台） */
export function setProcessState(
  g: AilsmGraph,
  processId: number,
  to: ProcessState,
): StateAddResult {
  const proc = g.nodes.find((n) => n.id === processId && n.kind === 'process');
  if (!proc) throw new Error(`setProcessState: Process#${processId} が存在しない`);
  const from: ProcessState = isProcessState(String(proc.attrs.state ?? 'created')) ? (String(proc.attrs.state) as ProcessState) : 'created';
  if (!canTransition(from, to)) {
    throw new Error(`不正なプロセス遷移: ${from} -> ${to}`);
  }

  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  let newId: number | undefined;
  for (const n of g.nodes) {
    if (n.id === processId) {
      const id = b.addNode(n.kind, n.label, n.type, { ...n.attrs, state: to }, n.constraints);
      remap.set(n.id, id);
      newId = id;
    } else {
      const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
      remap.set(n.id, id);
    }
  }
  for (const e of g.edges) {
    const from2 = remap.get(e.from);
    const to2 = remap.get(e.to);
    if (from2 !== undefined && to2 !== undefined && from2 !== to2) b.connect(from2, to2, e.rel);
  }
  if (newId === undefined) throw new Error('setProcessState: 内部エラー');
  return { graph: b.graph(), id: newId };
}
