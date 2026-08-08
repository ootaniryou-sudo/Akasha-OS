/**
 * Expert Evolution（Phase 2.9）— Expert が自分で分裂・統合・引退する
 *
 *   Expert は固定されたルーティング単位ではなく、Expert Health（精度・レイテンシ・
 *   コスト・新規性・確信度・メモリ・バッテリ・GPU・温度 + 利用率・機能重複率）を
 *   持ち、客観的基準に従って進化する。
 *
 *   分裂・統合・引退の客観的基準（研究の核 — 「なぜ進化したか」を数値で説明）:
 *     SPLIT : 利用率↑ かつ 精度↑ かつ 新規性↑ かつ コスト↑
 *             = 「忙しい + 高精度 + 高新規性 + 高コスト → 専門化する価値がある」
 *     MERGE : 他 Expert との機能重複率↑ かつ 両者とも中程度の健康度
 *             = 「機能が重複し、どちらも突出しない → 一般化して統合」
 *     RETIRE: 健康度↓ かつ 利用率↓
 *             = 「健康度が低く利用率も低い → 引退」
 *
 *   MoE（Gate の先の Expert は固定）との最大の違い:
 *     Executive → Meta Executive → Expert Manager → Expert A/B/C → Expert D を生成
 *     → Expert B を統合 → Expert C を削除（固定じゃない）
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';

export interface ExpertHealth {
  expert: string;
  accuracy: number; // 0-1 成功率
  latency: number; // 0-1 遅延（高いほど悪い）
  cost: number; // 0-1 実行コスト
  novelty: number; // 0-1 新規性
  confidence: number; // 0-1 平均確信度
  memory: number; // 0-1 メモリ使用
  battery: number; // 0-1 バッテリ消費
  gpu: number; // 0-1 GPU 使用
  temperature: number; // 0-1 温度
  utilization: number; // 0-1 利用率（呼び出し頻度）
  overlap: number; // 0-1 他 Expert との機能重複率
  health: number; // 合成健康度
}

export type ExpertHealthInput = Omit<ExpertHealth, 'health'>;

/** 合成健康度: 精度・新規性・確信度は正、コスト・遅延・メモリ・バッテリ・GPU・温度は負 */
export function computeHealth(m: ExpertHealthInput): number {
  return (
    m.accuracy * 0.5 +
    m.novelty * 0.15 +
    m.confidence * 0.1 -
    m.cost * 0.1 -
    m.latency * 0.05 -
    m.memory * 0.05 -
    m.battery * 0.02 -
    m.gpu * 0.02 -
    m.temperature * 0.01
  );
}

export interface EvolutionRules {
  split: { utilization: number; accuracy: number; novelty: number; cost: number };
  merge: { overlap: number; maxHealth: number };
  retire: { health: number; utilization: number };
}

export const DEFAULT_EVOLUTION_RULES: EvolutionRules = {
  split: { utilization: 0.6, accuracy: 0.8, novelty: 0.7, cost: 0.5 },
  merge: { overlap: 0.7, maxHealth: 0.7 },
  retire: { health: 0.4, utilization: 0.2 },
};

/** SPLIT 判定: 忙しい + 高精度 + 高新規性 + 高コスト → 専門化する価値 */
export function shouldSplit(h: ExpertHealth, rules: EvolutionRules = DEFAULT_EVOLUTION_RULES): boolean {
  return (
    h.utilization > rules.split.utilization &&
    h.accuracy > rules.split.accuracy &&
    h.novelty > rules.split.novelty &&
    h.cost > rules.split.cost
  );
}

/** MERGE 判定: 機能重複率↑ かつ 両者とも中程度の健康度 → 一般化して統合 */
export function shouldMerge(h: ExpertHealth, other: ExpertHealth, rules: EvolutionRules = DEFAULT_EVOLUTION_RULES): boolean {
  return h.overlap > rules.merge.overlap && h.health < rules.merge.maxHealth && other.health < rules.merge.maxHealth;
}

/** RETIRE 判定: 健康度↓ かつ 利用率↓ → 引退 */
export function shouldRetire(h: ExpertHealth, rules: EvolutionRules = DEFAULT_EVOLUTION_RULES): boolean {
  return h.health < rules.retire.health && h.utilization < rules.retire.utilization;
}

export type ExpertState = 'active' | 'specialized' | 'merged' | 'retired';

export interface Expert {
  id: number;
  name: string;
  state: ExpertState;
  health: number;
  accuracy: number;
  utilization: number;
  parentId: number | null; // specializes / mergesInto の親
}

function toExpert(g: AilsmGraph, id: number): Expert | undefined {
  const n = g.nodes.find((x) => x.id === id && x.kind === 'expert');
  if (!n) return undefined;
  const parentEdge = g.edges.find((e) => e.to === id && (e.rel === 'specializes' || e.rel === 'mergesInto'));
  return {
    id: n.id,
    name: String(n.attrs.name ?? ''),
    state: ((n.attrs.state as ExpertState) ?? 'active') as ExpertState,
    health: Number(n.attrs.health ?? 0),
    accuracy: Number(n.attrs.accuracy ?? 0),
    utilization: Number(n.attrs.utilization ?? 0),
    parentId: parentEdge ? parentEdge.from : null,
  };
}

export interface ExpertResult {
  graph: AilsmGraph;
  id: number;
}

/** Expert を spawn（task `manages` expert — Expert Manager が管理） */
export function expert(g: AilsmGraph, taskId: number, name: string, h: Partial<ExpertHealthInput> = {}): ExpertResult {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const full: ExpertHealthInput = {
    expert: name,
    accuracy: h.accuracy ?? 0.5,
    latency: h.latency ?? 0.3,
    cost: h.cost ?? 0.3,
    novelty: h.novelty ?? 0.5,
    confidence: h.confidence ?? 0.5,
    memory: h.memory ?? 0.3,
    battery: h.battery ?? 0.5,
    gpu: h.gpu ?? 0.3,
    temperature: h.temperature ?? 0.3,
    utilization: h.utilization ?? 0.1,
    overlap: h.overlap ?? 0.3,
  };
  const id = b.addNode('expert', `expert:${name}`, 'unknown', {
    name,
    state: 'active',
    health: computeHealth(full),
    accuracy: full.accuracy,
    utilization: full.utilization,
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

/** Expert の状態・指標を in-place 更新（ID は不変） */
export function updateExpert(
  g: AilsmGraph,
  expertId: number,
  patch: Record<string, string | number | boolean | string[]>,
): ExpertResult {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  let newId: number | undefined;
  for (const n of g.nodes) {
    if (n.id === expertId) {
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
  if (newId === undefined) throw new Error('updateExpert: 内部エラー');
  return { graph: b.graph(), id: newId };
}

export function expertOf(g: AilsmGraph, id: number): Expert | undefined {
  return toExpert(g, id);
}

/** Task が管理する Expert を列挙 */
export function expertsOf(g: AilsmGraph, taskId: number): Expert[] {
  const edges = g.edges.filter((e) => e.from === taskId && e.rel === 'manages');
  const out: Expert[] = [];
  for (const e of edges) {
    const x = toExpert(g, e.to);
    if (x) out.push(x);
  }
  return out.sort((a, b) => a.id - b.id);
}

export function expertByName(g: AilsmGraph, taskId: number, name: string): Expert | undefined {
  return expertsOf(g, taskId).find((x) => x.name === name);
}

/** SPLIT: 親 Expert を specialized にして子（専門化）Expert を生成（`specializes` エッジ） */
export function splitExpert(
  g: AilsmGraph,
  taskId: number,
  parentId: number,
  children: { name: string; health?: Partial<ExpertHealthInput> }[],
): { graph: AilsmGraph; ids: number[] } {
  const parent = toExpert(g, parentId);
  if (!parent) throw new Error(`splitExpert: Expert#${parentId} がありません`);
  let graph = updateExpert(g, parentId, { state: 'specialized' }).graph;
  const ids: number[] = [];
  for (const c of children) {
    const r = expert(graph, taskId, c.name, c.health);
    graph = r.graph;
    // 親が子を専門化（specializes エッジ）
    const b = new AilsmBuilder();
    const remap = new Map<number, number>();
    for (const n of graph.nodes) {
      const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
      remap.set(n.id, id);
    }
    const f = remap.get(parentId);
    const t = remap.get(r.id);
    if (f !== undefined && t !== undefined && f !== t) b.connect(f, t, 'specializes');
    for (const e of graph.edges) {
      const ef = remap.get(e.from);
      const et = remap.get(e.to);
      if (ef !== undefined && et !== undefined && ef !== et) b.connect(ef, et, e.rel);
    }
    graph = b.graph();
    ids.push(r.id);
  }
  return { graph, ids };
}

/** MERGE: 複数 Expert を merged にして統合 Expert を生成（`mergesInto` エッジ） */
export function mergeExperts(
  g: AilsmGraph,
  taskId: number,
  sourceIds: number[],
  targetName: string,
  health: Partial<ExpertHealthInput> = {},
): ExpertResult {
  let graph = g;
  for (const sid of sourceIds) {
    graph = updateExpert(graph, sid, { state: 'merged' }).graph;
  }
  const r = expert(graph, taskId, targetName, health);
  graph = r.graph;
  // 各ソースが統合先へ mergesInto
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of graph.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const t = remap.get(r.id);
  for (const sid of sourceIds) {
    const f = remap.get(sid);
    if (f !== undefined && t !== undefined && f !== t) b.connect(f, t, 'mergesInto');
  }
  for (const e of graph.edges) {
    const ef = remap.get(e.from);
    const et = remap.get(e.to);
    if (ef !== undefined && et !== undefined && ef !== et) b.connect(ef, et, e.rel);
  }
  return { graph: b.graph(), id: r.id };
}

/** RETIRE: Expert を引退させる */
export function retireExpert(g: AilsmGraph, expertId: number): ExpertResult {
  return updateExpert(g, expertId, { state: 'retired' });
}

