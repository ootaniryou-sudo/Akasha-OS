/**
 * Executive SSA（Phase 2.6）— 推論全体を指揮する Executive（Reasoning Graph のさらに上位）
 *
 *   Executive だけが「ゴール保持 / 優先順位変更 / Expert 編成 / Search Policy 変更 /
 *   Beam 幅変更 / 温度変更」を行える — 人間の「考える→違う→別方向→戻る→試す→失敗→
 *   もっと単純化→また考える」を司るのは LLM ではなく Executive。
 *
 *   構造: Task manages Executive（指揮官） / Executive manages Process（各仮説プロセス）
 *
 *   Executive は SSA ノードとして設定（goal / policy / beam / explore / temperature /
 *   experts）を保持し、探索途中で in-place 更新される（CPU のコントロールレジスタ相当）。
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import type { SearchWeights } from './search.js';

export interface ExecutiveConfig {
  policy: string; // 'beam' | 'best-first' | 'dfs' | 'bfs' | 'mcts'
  beam: number; // Beam 幅
  weights: SearchWeights; // explore / costPenalty（探索 vs 活用）
  temperature: number; // 探索温度（explore に反映される制御量）
  experts: string[]; // Expert 編成（利用可能な実行資源）
}

export const DEFAULT_EXECUTIVE_CONFIG: ExecutiveConfig = {
  policy: 'best-first',
  beam: 1,
  weights: { explore: 0.2, costPenalty: 0.3 },
  temperature: 0.2,
  experts: ['math'],
};

export interface Executive {
  id: number;
  goal: string;
  policy: string;
  beam: number;
  explore: number;
  costPenalty: number;
  temperature: number;
  experts: string[];
  rounds: number; // 指揮したラウンド数
  accepts: number; // 累計採用
  kills: number; // 累計淘汰
  switches: number; // 戦略切替回数
}

function num(v: unknown, def: number): number {
  return v === undefined ? def : Number(v);
}

function toExecutive(g: AilsmGraph, id: number): Executive | undefined {
  const n = g.nodes.find((x) => x.id === id && x.kind === 'executive');
  if (!n) return undefined;
  const experts = Array.isArray(n.attrs.experts) ? (n.attrs.experts as string[]) : [];
  return {
    id: n.id,
    goal: String(n.attrs.goal ?? ''),
    policy: String(n.attrs.policy ?? 'best-first'),
    beam: num(n.attrs.beam, 1),
    explore: num(n.attrs.explore, 0.2),
    costPenalty: num(n.attrs.costPenalty, 0.3),
    temperature: num(n.attrs.temperature, 0.2),
    experts,
    rounds: num(n.attrs.rounds, 0),
    accepts: num(n.attrs.accepts, 0),
    kills: num(n.attrs.kills, 0),
    switches: num(n.attrs.switches, 0),
  };
}

export interface ExecutiveResult {
  graph: AilsmGraph;
  id: number;
}

/** 起動: Executive ノードを作成し Task が指揮を取る（task `manages` executive） */
export function executive(
  g: AilsmGraph,
  taskId: number,
  goal: string,
  cfg: Partial<ExecutiveConfig> = {},
): ExecutiveResult {
  const full: ExecutiveConfig = { ...DEFAULT_EXECUTIVE_CONFIG, ...cfg };
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const id = b.addNode('executive', 'executive', 'unknown', {
    goal,
    policy: full.policy,
    beam: full.beam,
    explore: full.weights.explore,
    costPenalty: full.weights.costPenalty,
    temperature: full.temperature,
    experts: [...full.experts],
    rounds: 0,
    accepts: 0,
    kills: 0,
    switches: 0,
  });
  const t = remap.get(taskId);
  if (t !== undefined && t !== id) b.connect(t, id, 'manages');
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), id };
}

/** Executive の設定を in-place 更新（ID は不変 = コントロールレジスタの書き換え） */
export function updateExecutive(
  g: AilsmGraph,
  execId: number,
  patch: Record<string, string | number | boolean | string[]>,
): ExecutiveResult {
  const exec = toExecutive(g, execId);
  if (!exec) throw new Error(`updateExecutive: Executive#${execId} が存在しない`);
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  let newId: number | undefined;
  for (const n of g.nodes) {
    if (n.id === execId) {
      const id = b.addNode(n.kind, n.label, n.type, { ...n.attrs, ...patch }, n.constraints);
      remap.set(n.id, id);
      newId = id;
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
  if (newId === undefined) throw new Error('updateExecutive: 内部エラー');
  return { graph: b.graph(), id: newId };
}

export function executiveOf(g: AilsmGraph, id: number): Executive | undefined {
  return toExecutive(g, id);
}

/** Task が管理する Executive を列挙 */
export function executivesOf(g: AilsmGraph, taskId: number): Executive[] {
  const edges = g.edges.filter((e) => e.from === taskId && e.rel === 'manages');
  const out: Executive[] = [];
  for (const e of edges) {
    const ex = toExecutive(g, e.to);
    if (ex) out.push(ex);
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Executive が管理する Process を列挙（executive `manages` process） */
export function managedProcesses(g: AilsmGraph, execId: number): number[] {
  return g.edges.filter((e) => e.from === execId && e.rel === 'manages').map((e) => e.to);
}
