/**
 * Meta Executive SSA（Phase 2.7）— Executive を学習する Executive
 *
 *   Executive（実行する指揮官）の設定（policy / beam / explore / experts / threshold）を
 *   実行結果（accuracy / latency / cost）からオンライン最適化する。
 *
 *   Task ──manages──▶ Meta Executive ──manages──▶ Executive ──manages──▶ Process
 *
 *   Thinking Budget: 「そもそも今考えるべきか？」を判断する
 *     - 2+2 → Reasoning 禁止（予算 0、直接計算）
 *     - 新しい数学の理論 → 大予算（Beam 大 / Depth 大 / 全 Expert / Reflection 多数）
 *     - Battery 8% → Reasoning 禁止（Easy Expert だけ / GPU 不使用）
 *
 *   Transformer にはない「推論するかどうか」自体を OS が管理する層。
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';

export interface ThinkingBudget {
  allowReasoning: boolean; // Reasoning を許可するか（2+2 → false）
  maxExpansions: number; // 探索予算（EXPAND 回数の上限）
  maxRounds: number; // ラウンド上限
  beam: number; // 推奨 Beam 幅
  depth: number; // 推奨探索深さ
  experts: string[]; // 推奨 Expert 編成
  battery: number; // バッテリ残量 0-1
  reason: string; // 'trivial' | 'battery' | 'battery-low' | 'normal' | 'high'
}

export interface MetaExecutive {
  id: number;
  goal: string;
  policy: string; // 学習後の推奨ポリシー
  beam: number;
  explore: number;
  experts: string[];
  trials: number; // 実行した試行数
  bestAccuracy: number; // 最良精度
  bestLatency: number; // 最良レイテンシ
}

const TRIVIAL_RE = /^\s*\d+\s*[+\-*/×÷]\s*\d+/;
const HARD_RE = /新理論|理論を|証明|仮説|考える|発明|設計|戦略|研究|革新|反例/;

/** タスクの複雑さから Thinking Budget を決定（決定論） */
export function estimateBudget(text: string, opts: { battery?: number } = {}): ThinkingBudget {
  const battery = opts.battery ?? 1.0;
  // バッテリが極端に少ない → そもそも推論しない（Easy Expert だけ / GPU 不使用）
  if (battery < 0.1) {
    return { allowReasoning: false, maxExpansions: 0, maxRounds: 0, beam: 1, depth: 0, experts: [], battery, reason: 'battery' };
  }
  const trimmed = text.trim();
  const isTrivial = TRIVIAL_RE.test(trimmed) || (trimmed.length <= 8 && !HARD_RE.test(trimmed));
  if (isTrivial) {
    // 2+2 → Reasoning 禁止（直接計算）
    return { allowReasoning: false, maxExpansions: 0, maxRounds: 0, beam: 1, depth: 0, experts: [], battery, reason: 'trivial' };
  }
  const isHard = HARD_RE.test(trimmed);
  if (battery < 0.3) {
    // 低バッテリ: 軽い推論のみ（Easy Expert だけ / 探索を抑制）
    return { allowReasoning: true, maxExpansions: 2, maxRounds: 1, beam: 2, depth: 2, experts: ['math', 'reasoning'], battery, reason: 'battery-low' };
  }
  if (isHard) {
    // 難しいタスク: 大予算（Beam 大 / Depth 大 / 全 Expert / Reflection 多数）
    return { allowReasoning: true, maxExpansions: 8, maxRounds: 4, beam: 4, depth: 10, experts: ['math', 'reasoning', 'search', 'planning'], battery, reason: 'high' };
  }
  return { allowReasoning: true, maxExpansions: 4, maxRounds: 2, beam: 2, depth: 4, experts: ['math', 'reasoning'], battery, reason: 'normal' };
}

function num(v: unknown, def: number): number {
  return v === undefined ? def : Number(v);
}

function toMetaExecutive(g: AilsmGraph, id: number): MetaExecutive | undefined {
  const n = g.nodes.find((x) => x.id === id && x.kind === 'metaexecutive');
  if (!n) return undefined;
  return {
    id: n.id,
    goal: String(n.attrs.goal ?? ''),
    policy: String(n.attrs.policy ?? 'best-first'),
    beam: num(n.attrs.beam, 1),
    explore: num(n.attrs.explore, 0.2),
    experts: Array.isArray(n.attrs.experts) ? (n.attrs.experts as string[]) : [],
    trials: num(n.attrs.trials, 0),
    bestAccuracy: num(n.attrs.bestAccuracy, 0),
    bestLatency: num(n.attrs.bestLatency, 0),
  };
}

export interface MetaExecutiveResult {
  graph: AilsmGraph;
  id: number;
}

/** 起動: Meta Executive ノードを作成（task `manages` metaexecutive） */
export function metaExecutive(
  g: AilsmGraph,
  taskId: number,
  goal: string,
  cfg: { policy?: string; beam?: number; explore?: number; experts?: string[] } = {},
): MetaExecutiveResult {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const id = b.addNode('metaexecutive', 'metaexecutive', 'unknown', {
    goal,
    policy: cfg.policy ?? 'best-first',
    beam: cfg.beam ?? 1,
    explore: cfg.explore ?? 0.2,
    experts: cfg.experts ?? [],
    trials: 0,
    bestAccuracy: 0,
    bestLatency: 0,
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

/** Meta Executive の設定を in-place 更新（ID は不変） */
export function updateMetaExecutive(
  g: AilsmGraph,
  metaId: number,
  patch: Record<string, string | number | boolean | string[]>,
): MetaExecutiveResult {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  let newId: number | undefined;
  for (const n of g.nodes) {
    if (n.id === metaId) {
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
  if (newId === undefined) throw new Error('updateMetaExecutive: 内部エラー');
  return { graph: b.graph(), id: newId };
}

export function metaExecutiveOf(g: AilsmGraph, id: number): MetaExecutive | undefined {
  return toMetaExecutive(g, id);
}

/** Task が管理する Meta Executive を列挙 */
export function metaExecutivesOf(g: AilsmGraph, taskId: number): MetaExecutive[] {
  const edges = g.edges.filter((e) => e.from === taskId && e.rel === 'manages');
  const out: MetaExecutive[] = [];
  for (const e of edges) {
    const me = toMetaExecutive(g, e.to);
    if (me) out.push(me);
  }
  return out.sort((a, b) => a.id - b.id);
}
