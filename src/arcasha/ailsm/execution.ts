/**
 * Execution Context SSA（Phase 0.21）— AI の「思考途中」を保存するプロセスコンテキスト
 *
 * CPU の Process Context に相当する。Long Context を読む Expert は
 *   current page / current hypothesis / temporary variables / call stack / active experts / cache
 * を Execution Context に保持しながら、必要ページだけを読む。
 *
 *   Context → Execution Context → Belief → Memory → Reflection
 *
 * 「Page1 で A だと思った → Page100 で B → Page300 で C」という思考途中の遷移を
 * どこへ保存するか、という問題の答えが Execution Context である。
 *
 * Context Switch: Expert 切り替え時に save() / restore() する（AI Thread が本物の Thread になる）。
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';

export type ExecutionState = 'created' | 'ready' | 'running' | 'suspended' | 'finished';

export interface ExecutionContext {
  id: number;
  contextId: number;
  owner: string; // process / thread
  expert: string; // 現在の専門
  state: ExecutionState;
  currentPage: number | null;
  hypothesis: string; // 現在の仮説（思考途中）
  vars: string[]; // 一時変数
  callStack: string[]; // Expert 呼び出し履歴
  activeExperts: string[];
  residentPages: number[]; // ロード済みページ（resident set）
}

export interface ExecutionResult {
  graph: AilsmGraph;
  exec: ExecutionContext;
}

export interface SwitchEvent {
  kind: 'SAVE' | 'RESTORE' | 'SWITCH';
  from?: string;
  to?: string;
  detail: string;
}

function toExec(g: AilsmGraph, id: number): ExecutionContext | undefined {
  const n = g.nodes.find((x) => x.id === id && x.kind === 'execution');
  if (!n) return undefined;
  const cp = n.attrs.currentPage;
  return {
    id: n.id,
    contextId: typeof n.attrs.contextId === 'number' ? n.attrs.contextId : Number(n.attrs.contextId ?? 0),
    owner: String(n.attrs.owner ?? ''),
    expert: String(n.attrs.expert ?? ''),
    state: (n.attrs.state as ExecutionState) ?? 'created',
    currentPage: cp === undefined || cp === 0 ? null : Number(cp),
    hypothesis: String(n.attrs.hypothesis ?? ''),
    vars: (n.attrs.vars as string[] | undefined) ?? [],
    callStack: (n.attrs.callStack as string[] | undefined) ?? [],
    activeExperts: (n.attrs.activeExperts as string[] | undefined) ?? [],
    residentPages: ((n.attrs.residentPages as string[] | undefined) ?? []).map(Number),
  };
}

function rebuild(g: AilsmGraph, fn: (b: AilsmBuilder, remap: Map<number, number>) => void): AilsmGraph {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  fn(b, remap);
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return b.graph();
}

/** Execution Context#N を作成（context `contains` execution） */
export function createExecutionContext(
  g: AilsmGraph,
  contextId: number,
  owner: string,
  expert: string,
): ExecutionResult {
  let createdId = 0;
  const graph = rebuild(g, (b, remap) => {
    createdId = b.addNode('execution', `${owner}:${expert}`, 'unknown', {
      contextId,
      owner,
      expert,
      state: 'created',
      currentPage: 0,
      hypothesis: '',
      vars: [],
      callStack: [],
      activeExperts: [expert],
      residentPages: [],
    });
    const ctx = remap.get(contextId);
    if (ctx !== undefined && ctx !== createdId) b.connect(ctx, createdId, 'contains');
  });
  return { graph, exec: toExec(graph, createdId)! };
}

export function executionOf(g: AilsmGraph, execId: number): ExecutionContext | undefined {
  return toExec(g, execId);
}

/** Execution Context を更新（currentPage / hypothesis / vars / callStack / residentPages 等） */
export function updateExecution(
  g: AilsmGraph,
  execId: number,
  patch: Partial<Omit<ExecutionContext, 'id' | 'contextId'>>,
): ExecutionResult {
  const cur = toExec(g, execId);
  if (!cur) throw new Error(`Execution#${execId} がありません`);
  const merged: ExecutionContext = { ...cur, ...patch };
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    if (n.id === execId) {
      const id = b.addNode('execution', `${merged.owner}:${merged.expert}`, 'unknown', {
        contextId: merged.contextId,
        owner: merged.owner,
        expert: merged.expert,
        state: merged.state,
        currentPage: merged.currentPage ?? 0,
        hypothesis: merged.hypothesis,
        vars: merged.vars,
        callStack: merged.callStack,
        activeExperts: merged.activeExperts,
        residentPages: merged.residentPages.map(String),
      }, n.constraints);
      remap.set(n.id, id);
    } else {
      const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
      remap.set(n.id, id);
    }
  }
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), exec: toExec(b.graph(), execId)! };
}

/** Context Switch OUT: 思考途中を保存して suspend */
export function saveExecutionContext(g: AilsmGraph, execId: number): ExecutionResult {
  return updateExecution(g, execId, { state: 'suspended' });
}

/** Context Switch IN: 保存済みの思考途中を復元して running */
export function restoreExecutionContext(g: AilsmGraph, execId: number): ExecutionResult {
  return updateExecution(g, execId, { state: 'running' });
}

/** Context Switch: from を save → to を restore（CPU のコンテキストスイッチに相当） */
export function contextSwitch(
  g: AilsmGraph,
  fromExecId: number,
  toExecId: number,
): { graph: AilsmGraph; events: SwitchEvent[] } {
  const from = toExec(g, fromExecId);
  const to = toExec(g, toExecId);
  if (!from || !to) throw new Error('Context Switch: Execution がありません');
  const events: SwitchEvent[] = [];
  let graph = g;
  const saved = saveExecutionContext(graph, fromExecId);
  graph = saved.graph;
  events.push({ kind: 'SAVE', from: from.expert, detail: `${from.expert} の思考途中を保存（仮説: ${from.hypothesis || '空'}）` });
  const restored = restoreExecutionContext(graph, toExecId);
  graph = restored.graph;
  events.push({ kind: 'RESTORE', to: to.expert, detail: `${to.expert} の思考途中を復元` });
  events.push({ kind: 'SWITCH', from: from.expert, to: to.expert, detail: `${from.expert} → ${to.expert}` });
  return { graph, events };
}

/** 思考途中を Memory に保存（execution `stores` memory） */
export function commitMemory(
  g: AilsmGraph,
  execId: number,
  key: string,
  value: string,
): { graph: AilsmGraph; memoryId: number } {
  const cur = toExec(g, execId);
  if (!cur) throw new Error(`Execution#${execId} がありません`);
  let memoryId = 0;
  const graph = rebuild(g, (b, remap) => {
    memoryId = b.addNode('memory', key, 'string', { key, value });
    const ex = remap.get(execId);
    if (ex !== undefined && ex !== memoryId) b.connect(ex, memoryId, 'stores');
  });
  return { graph, memoryId };
}
