/**
 * Hypothesis SSA（Phase 2.4）— AI Reasoning Runtime の核
 *
 * 創発的知能は「Expert 同士の循環」で生まれる。一本道の Planner→Math→Search ではなく、
 *   Hypothesis #1 "x=3"   confidence=0.43
 *   Hypothesis #2 "x=-3"  confidence=0.61
 *   Hypothesis #3 "場合分け" confidence=0.54
 * を SPAWN / EVALUATE / MERGE / KILL する（探索木を OS レベルで管理する）。
 *
 * MoE が Transformer 内部で暗黙に行う探索を、ArcAsha は OS（プロセス/SSA）で明示化する。
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';

export type HypothesisState = 'proposed' | 'active' | 'accepted' | 'rejected' | 'merged' | 'killed';

export interface Hypothesis {
  id: number;
  text: string;
  confidence: number; // 0-1
  state: HypothesisState;
  expert: string | null; // 評価する Expert
  score: number | null; // Reflection による評価スコア
  parentIds: number[]; // マージ元
}

function toHypothesis(g: AilsmGraph, id: number): Hypothesis | undefined {
  const n = g.nodes.find((x) => x.id === id && x.kind === 'hypothesis');
  if (!n) return undefined;
  return {
    id: n.id,
    text: String(n.attrs.text ?? ''),
    confidence: typeof n.attrs.confidence === 'number' ? n.attrs.confidence : Number(n.attrs.confidence ?? 0),
    state: ((n.attrs.state as HypothesisState) ?? 'proposed') as HypothesisState,
    expert: n.attrs.expert === undefined || n.attrs.expert === '' ? null : String(n.attrs.expert),
    score: n.attrs.score === undefined ? null : Number(n.attrs.score),
    parentIds: ((n.attrs.parentIds as string[] | undefined) ?? []).map(Number),
  };
}

/** 複数ノードを in-place 更新したグラフを返す（ID は不変 — 全変換を跨いで安定） */
function mutate(g: AilsmGraph, patches: Map<number, Record<string, string | number | boolean | string[]>>): AilsmGraph {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const p = patches.get(n.id);
    const id = b.addNode(n.kind, n.label, n.type, p ? { ...n.attrs, ...p } : n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return b.graph();
}

export interface HypothesisResult {
  graph: AilsmGraph;
  id: number;
}

/** SPAWN: 仮説を生成（task `hypothesizes` hypothesis） */
export function hypothesize(
  g: AilsmGraph,
  taskId: number,
  text: string,
  confidence: number,
  expert?: string,
): HypothesisResult {
  let newId = 0;
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  newId = b.addNode('hypothesis', text.slice(0, 20), 'unknown', {
    text,
    confidence,
    state: 'proposed',
    expert: expert ?? '',
    score: 0,
    parentIds: [],
  });
  const t = remap.get(taskId);
  if (t !== undefined && t !== newId) b.connect(t, newId, 'hypothesizes');
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), id: newId };
}

/** EVALUATE 開始: 仮説を active + 担当 Expert を設定 */
export function activate(g: AilsmGraph, hypothesisId: number, expert: string): { graph: AilsmGraph } {
  return { graph: mutate(g, new Map([[hypothesisId, { state: 'active', expert }]])) };
}

/** EVALUATE 結果: スコアを記録 */
export function evaluate(g: AilsmGraph, hypothesisId: number, score: number): { graph: AilsmGraph } {
  return { graph: mutate(g, new Map([[hypothesisId, { score }]])) };
}

/** ACCEPT: 採用（Reflection の judge で 採用） */
export function accept(g: AilsmGraph, hypothesisId: number): { graph: AilsmGraph } {
  return { graph: mutate(g, new Map([[hypothesisId, { state: 'accepted' }]])) };
}

/** REJECT / KILL: 淘汰 */
export function kill(g: AilsmGraph, hypothesisId: number): { graph: AilsmGraph } {
  return { graph: mutate(g, new Map([[hypothesisId, { state: 'killed' }]])) };
}

export function reject(g: AilsmGraph, hypothesisId: number): { graph: AilsmGraph } {
  return { graph: mutate(g, new Map([[hypothesisId, { state: 'rejected' }]])) };
}

/** MERGE: 複数仮説を 1 つに統合（元を merged にして新しい仮説を SPAWN） */
export function merge(
  g: AilsmGraph,
  taskId: number,
  sourceIds: number[],
  text: string,
  confidence: number,
): HypothesisResult {
  let g1 = mutate(g, new Map(sourceIds.map((id) => [id, { state: 'merged' }])));
  const r = hypothesize(g1, taskId, text, confidence);
  // マージ元を記録
  const patches = new Map<number, Record<string, string | number | boolean | string[]>>([
    [r.id, { parentIds: sourceIds.map(String) }],
  ]);
  return { graph: mutate(r.graph, patches), id: r.id };
}

/** Task 配下の仮説を列挙 */
export function hypothesesOf(g: AilsmGraph, taskId: number): Hypothesis[] {
  const edges = g.edges.filter((e) => e.from === taskId && e.rel === 'hypothesizes');
  const out: Hypothesis[] = [];
  for (const e of edges) {
    const h = toHypothesis(g, e.to);
    if (h) out.push(h);
  }
  return out.sort((a, b) => a.id - b.id);
}

export function hypothesisOf(g: AilsmGraph, id: number): Hypothesis | undefined {
  return toHypothesis(g, id);
}
