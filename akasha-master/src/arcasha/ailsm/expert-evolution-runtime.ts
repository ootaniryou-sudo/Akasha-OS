/**
 * Expert Evolution Runtime（Phase 2.9）— Expert が自分で分裂・統合・引退する
 *
 *   ループ: 各ラウンドで全 Expert の Health を計測 → 客観的基準で
 *   SPLIT（専門化）/ MERGE（統合）/ RETIRE（引退）を決定 → 適用
 *
 *   MoE（Expert 固定）との最大の違い:
 *     Math → {Geometry, Algebra, Calculus, Statistics} → Geometry → {Triangle, Circle,
 *     Coordinate, Graph} → Graph → {BFS, DFS, ShortestPath, Flow} まで自動で細分化。
 *     Geometry + Statistics → Math-General（統合）/ 低ヘルスは引退。
 *
 *   客観的基準（研究の核 — 「なぜ進化したか」を数値で説明）:
 *     SPLIT : util>0.6 かつ acc>0.8 かつ nov>0.7 かつ cost>0.5
 *     MERGE : overlap>0.7 かつ 両者 health<0.7
 *     RETIRE: health<0.4 かつ util<0.2
 */

import { compile, AilsmError } from './compiler.js';
import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import {
  expert, expertByName, expertsOf, computeHealth, shouldSplit, shouldMerge, shouldRetire, splitExpert, mergeExperts, retireExpert, updateExpert,
} from './expert-evolution.js';
import type { ExpertHealth, ExpertHealthInput, EvolutionRules } from './expert-evolution.js';
import { DEFAULT_EVOLUTION_RULES } from './expert-evolution.js';

export interface EvolutionOp {
  kind: 'split' | 'merge' | 'retire';
  source: string;
  target?: string; // merge 先
  children?: string[]; // split の子
  reason: string; // 客観的基準による理由（数値入り）
}

export interface EvolutionRound {
  round: number;
  pool: string[]; // 進化後のアクティブ Expert
  ops: EvolutionOp[];
}

export interface ExpertEvolutionResult {
  graph: AilsmGraph;
  taskId: number;
  text: string;
  rounds: EvolutionRound[];
  finalPool: string[];
  healthByExpert: Record<string, ExpertHealth>;
  actions: string[];
}

export interface ExpertEvolutionOptions {
  initialPool: string[];
  specialtyMap: Record<string, string[]>; // split の子（expert → 専門化先）
  mergePairs: { a: string; b: string; overlap: number; target: string }[]; // merge 候補
  metrics: Record<string, Partial<ExpertHealthInput>>[]; // round ごとの全 Expert 指標（決定論）
  rules?: EvolutionRules;
}

function defaultInput(name: string, m: Partial<ExpertHealthInput>): ExpertHealthInput {
  return {
    expert: name,
    accuracy: m.accuracy ?? 0.5,
    latency: m.latency ?? 0.3,
    cost: m.cost ?? 0.3,
    novelty: m.novelty ?? 0.5,
    confidence: m.confidence ?? 0.5,
    memory: m.memory ?? 0.3,
    battery: m.battery ?? 0.5,
    gpu: m.gpu ?? 0.3,
    temperature: m.temperature ?? 0.3,
    utilization: m.utilization ?? 0.1,
    overlap: m.overlap ?? 0.3,
  };
}

/**
 * Expert Evolution ループ: 各ラウンドで Health 計測 → SPLIT / MERGE / RETIRE を決定・適用
 * （決定論: metrics 配列に従い、SPLIT > MERGE > RETIRE の優先順で判定）
 */
export function runExpertEvolution(text: string, opts: ExpertEvolutionOptions): ExpertEvolutionResult {
  const rules = opts.rules ?? DEFAULT_EVOLUTION_RULES;
  const actions: string[] = [];

  // Task ノード
  let g: AilsmGraph;
  let taskId: number;
  try {
    const compiled = compile(text);
    g = compiled.semantic.graph;
    taskId = g.nodes.find((n) => n.kind === 'task')?.id ?? -1;
  } catch (e) {
    if (!(e instanceof AilsmError)) throw e;
    const b = new AilsmBuilder();
    taskId = b.addNode('task', 'evolve', 'unknown', { domain: 'reasoning', intent: 'unknown' });
    g = b.graph();
  }

  // 初期 Expert プール
  for (const name of opts.initialPool) {
    const r = expert(g, taskId, name);
    g = r.graph;
  }

  const rounds: EvolutionRound[] = [];
  const healthByExpert: Record<string, ExpertHealth> = {};

  for (let round = 0; round < opts.metrics.length; round++) {
    const metrics = opts.metrics[round];
    const ops: EvolutionOp[] = [];
    const current = expertsOf(g, taskId).filter((x) => x.state === 'active');

    // 各 Expert の Health を計測（このラウンドの指標があれば、なければ既定）
    for (const x of current) {
      const m = metrics[x.name];
      if (!m) continue; // このラウンドで観測されていない Expert は進化判定しない（未観測 = 変化なし）
      const full = defaultInput(x.name, m);
      const h: ExpertHealth = { ...full, health: computeHealth(full) };
      healthByExpert[x.name] = h;
      g = updateExpert(g, x.id, { health: h.health, accuracy: h.accuracy, utilization: h.utilization }).graph;
    }

    // ── SPLIT（専門化）──
    for (const x of [...current]) {
      const h = healthByExpert[x.name];
      if (!h || x.state !== 'active') continue;
      const children = opts.specialtyMap[x.name];
      if (!children) continue;
      if (shouldSplit(h, rules)) {
        const ex = splitExpert(g, taskId, x.id, children.map((name) => ({ name, health: { accuracy: 0.6, utilization: 0.1, novelty: 0.5 } })));
        g = ex.graph;
        ops.push({
          kind: 'split',
          source: x.name,
          children,
          reason: `util=${h.utilization.toFixed(2)}>${rules.split.utilization} acc=${h.accuracy.toFixed(2)}>${rules.split.accuracy} nov=${h.novelty.toFixed(2)}>${rules.split.novelty} cost=${h.cost.toFixed(2)}>${rules.split.cost}（忙しい+高精度+高新規性+高コスト → 専門化する価値）`,
        });
        actions.push(`SPLIT  ${x.name} → ${children.join(',')} | ${ops[ops.length - 1].reason}`);
      }
    }

    // ── MERGE（統合）──
    for (const pair of opts.mergePairs) {
      const ha = healthByExpert[pair.a];
      const hb = healthByExpert[pair.b];
      if (!ha || !hb) continue;
      const a = expertByName(g, taskId, pair.a);
      const b = expertByName(g, taskId, pair.b);
      if (!a || !b || a.state !== 'active' || b.state !== 'active') continue;
      const haWithOverlap: ExpertHealth = { ...ha, overlap: pair.overlap };
      const hbWithOverlap: ExpertHealth = { ...hb, overlap: pair.overlap };
      if (shouldMerge(haWithOverlap, hbWithOverlap, rules)) {
        const mr = mergeExperts(g, taskId, [a.id, b.id], pair.target, { accuracy: 0.65, utilization: 0.3, novelty: 0.4 });
        g = mr.graph;
        healthByExpert[pair.target] = {
          expert: pair.target, accuracy: 0.65, latency: 0.3, cost: 0.25, novelty: 0.4, confidence: 0.6,
          memory: 0.25, battery: 0.5, gpu: 0.25, temperature: 0.3, utilization: 0.3, overlap: 0.2, health: computeHealth({ expert: pair.target, accuracy: 0.65, latency: 0.3, cost: 0.25, novelty: 0.4, confidence: 0.6, memory: 0.25, battery: 0.5, gpu: 0.25, temperature: 0.3, utilization: 0.3, overlap: 0.2 }),
        };
        ops.push({
          kind: 'merge',
          source: `${pair.a}+${pair.b}`,
          target: pair.target,
          reason: `overlap=${pair.overlap.toFixed(2)}>${rules.merge.overlap} health(${pair.a})=${ha.health.toFixed(2)} health(${pair.b})=${hb.health.toFixed(2)}<${rules.merge.maxHealth}（機能が重複しどちらも突出しない → 一般化して統合）`,
        });
        actions.push(`MERGE  ${pair.a}+${pair.b} → ${pair.target} | ${ops[ops.length - 1].reason}`);
      }
    }

    // ── RETIRE（引退）──
    for (const x of [...current]) {
      const h = healthByExpert[x.name];
      if (!h || x.state !== 'active') continue;
      if (shouldRetire(h, rules)) {
        g = retireExpert(g, x.id).graph;
        ops.push({
          kind: 'retire',
          source: x.name,
          reason: `health=${h.health.toFixed(2)}<${rules.retire.health} util=${h.utilization.toFixed(2)}<${rules.retire.utilization}（健康度が低く利用率も低い → 引退）`,
        });
        actions.push(`RETIRE ${x.name} | ${ops[ops.length - 1].reason}`);
      }
    }

    const pool = expertsOf(g, taskId).filter((x) => x.state === 'active').map((x) => x.name);
    rounds.push({ round: round + 1, pool, ops });
  }

  const finalPool = expertsOf(g, taskId).filter((x) => x.state === 'active').map((x) => x.name);
  return { graph: g, taskId, text, rounds, finalPool, healthByExpert, actions };
}

/**
 * デモ: 「数学エコシステムの進化」— Expert が自動で細分化・統合・引退する
 *
 *   Round1: math（util1.0/acc0.85/nov0.8/cost0.7）→ SPLIT → {geometry, algebra, calculus, statistics}
 *   Round2: geometry（util0.9/acc0.9/nov0.85/cost0.8）→ SPLIT → {triangle, circle, coordinate, graph}
 *           statistics+algebra（overlap0.75）→ MERGE → math-general
 *           calculus（health低/util0.05）→ RETIRE
 *   Round3: graph（util0.95/acc0.92/nov0.9/cost0.85）→ SPLIT → {bfs, dfs, shortestpath, flow}
 */
export function runExpertEvolutionDemo(): ExpertEvolutionResult {
  return runExpertEvolution('数学エコシステムの進化', {
    initialPool: ['math'],
    specialtyMap: {
      math: ['geometry', 'algebra', 'calculus', 'statistics'],
      geometry: ['triangle', 'circle', 'coordinate', 'graph'],
      graph: ['bfs', 'dfs', 'shortestpath', 'flow'],
    },
    mergePairs: [{ a: 'statistics', b: 'algebra', overlap: 0.75, target: 'math-general' }],
    metrics: [
      // Round 1
      {
        math: { accuracy: 0.85, novelty: 0.8, cost: 0.7, latency: 0.4, confidence: 0.8, memory: 0.3, battery: 0.5, gpu: 0.6, temperature: 0.4, utilization: 1.0, overlap: 0.2 },
      },
      // Round 2
      {
        geometry: { accuracy: 0.9, novelty: 0.85, cost: 0.8, latency: 0.5, confidence: 0.85, memory: 0.4, battery: 0.4, gpu: 0.7, temperature: 0.5, utilization: 0.9, overlap: 0.2 },
        statistics: { accuracy: 0.6, novelty: 0.15, cost: 0.2, latency: 0.3, confidence: 0.6, memory: 0.2, battery: 0.5, gpu: 0.2, temperature: 0.3, utilization: 0.3, overlap: 0.3 },
        algebra: { accuracy: 0.7, novelty: 0.3, cost: 0.3, latency: 0.35, confidence: 0.7, memory: 0.25, battery: 0.5, gpu: 0.3, temperature: 0.35, utilization: 0.35, overlap: 0.3 },
        calculus: { accuracy: 0.4, novelty: 0.1, cost: 0.3, latency: 0.4, confidence: 0.4, memory: 0.3, battery: 0.6, gpu: 0.4, temperature: 0.5, utilization: 0.05, overlap: 0.4 },
      },
      // Round 3
      {
        graph: { accuracy: 0.92, novelty: 0.9, cost: 0.85, latency: 0.5, confidence: 0.9, memory: 0.5, battery: 0.4, gpu: 0.8, temperature: 0.6, utilization: 0.95, overlap: 0.2 },
      },
    ],
  });
}

/** Expert Evolution の人間可読表示（進化ツリー + 客観的理由） */
export function renderExpertEvolution(r: ExpertEvolutionResult): string {
  const lines: string[] = [`=== Expert Evolution (${r.text}) ===`];
  for (const rd of r.rounds) {
    lines.push(`Round ${rd.round}:`);
    for (const op of rd.ops) {
      if (op.kind === 'split') lines.push(`  SPLIT  ${op.source} → ${op.children?.join(', ')}`);
      else if (op.kind === 'merge') lines.push(`  MERGE  ${op.source} → ${op.target}`);
      else lines.push(`  RETIRE ${op.source}`);
      lines.push(`    ↳ ${op.reason}`);
    }
    if (rd.ops.length === 0) lines.push('  （変化なし）');
    lines.push(`  pool: ${rd.pool.join(', ')}`);
  }
  lines.push(`FINAL : ${r.finalPool.join(', ')}`);
  return lines.join('\n');
}
