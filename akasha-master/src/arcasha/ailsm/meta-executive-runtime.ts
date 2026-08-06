/**
 * Meta Executive Runtime（Phase 2.7）— Executive を学習する Executive
 *
 *   Executive policy → 実行 → 評価 → 改善 のオンライン学習ループ:
 *     - 複数の Executive 設定（Search Policy / Beam / Explore / Expert 編成）を試す
 *     - 結果（accuracy / latency / cost）から metaScore で最良設定を推定
 *     - 推奨設定を学習（meanAccuracy / bestAccuracy を蓄積）
 *     - Search Policy 自体を切り替える（Beam → Best-First → MCTS → DFS）
 *
 *   Thinking Budget: 「そもそも今考えるべきか？」を OS が判断する
 *     - 2+2 → Reasoning 禁止（予算 0）
 *     - 新理論 → 大予算（Beam 大 / Depth 大 / 全 Expert）
 *     - Battery 8% → Reasoning 禁止
 *
 *   Transformer/MoE にはない「推論戦略・推論予算・資源配分を学習して改善する層」。
 */

import { compile, AilsmError } from './compiler.js';
import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import { hypothesesOf } from './reasoning.js';
import type { EvaluationSignals, Hypothesis } from './reasoning.js';
import { runExecutive } from './executive-runtime.js';
import type { ExecutiveConfig } from './executive.js';
import { metaExecutive, estimateBudget } from './meta-executive.js';
import type { ThinkingBudget } from './meta-executive.js';
import type { BootResult } from './expert-runtime.js';
import type { ExpertDriver } from './driver.js';
import type { HypothesisCandidate } from './reasoning-runtime.js';

export interface MetaTrial {
  trial: number;
  config: ExecutiveConfig;
  policy: string;
  outcome: { accuracy: number; latencyMs: number; cost: number };
  metaScore: number;
  learned: { visits: number; meanAccuracy: number; bestAccuracy: number };
  recommended: boolean;
  finalText: string | null;
}

export interface MetaExecutiveResult {
  graph: AilsmGraph;
  taskId: number;
  metaExecutiveId: number;
  text: string;
  budget: ThinkingBudget;
  trials: MetaTrial[];
  recommendedConfig: ExecutiveConfig | null;
  finalText: string | null;
  finalConfidence: number | null;
  policySwitches: string[]; // 試行間で切り替えた Search Policy
  actions: string[];
}

export interface MetaExecutiveOptions {
  candidates: ExecutiveConfig[]; // 試す Executive 設定（決定論順）
  initial: HypothesisCandidate[];
  generateChildren: (parent: Hypothesis, depth: number) => HypothesisCandidate[];
  evaluator: (cand: HypothesisCandidate, result: string | null, ok: boolean) => EvaluationSignals;
  resolver?: (expert: string) => ExpertDriver | undefined;
  budget?: ThinkingBudget; // 指定がなければ estimateBudget で推定
  battery?: number; // 0-1（Thinking Budget の資源制約）
  latencyMs?: (config: ExecutiveConfig, evaluations: number) => number; // 決定論レイテンシ
  acceptThreshold?: number;
  killThreshold?: number;
  mergeText?: (hs: Hypothesis[]) => string;
}

/** デフォルトの決定論レイテンシ（Beam 幅 = 資源量、評価数 = 実行量に比例） */
export function defaultLatency(config: ExecutiveConfig, evaluations: number): number {
  return 600 + config.beam * 500 + evaluations * 60;
}

/** 実行結果の精度: 採用仮説の最大 score → なければ未淘汰仮説の最大 → なければ 0 */
function accuracyOf(g: AilsmGraph, taskId: number): number {
  const hyps = hypothesesOf(g, taskId);
  const accepted = hyps.filter((h) => h.state === 'accepted').map((h) => h.score ?? 0);
  if (accepted.length > 0) return Math.max(...accepted);
  const alive = hyps.filter((h) => h.state !== 'killed' && h.state !== 'rejected').map((h) => h.score ?? 0);
  if (alive.length > 0) return Math.max(...alive);
  return 0;
}

/** metaScore = 精度 - レイテンシ罰 - コスト罰 */
function metaScoreOf(accuracy: number, latencyMs: number, cost: number): number {
  return accuracy - latencyMs / 10000 - cost * 0.02;
}

/**
 * Meta Executive 学習ループ:
 *   各 candidate 設定で runExecutive を試行 → 結果から metaScore で最良設定を学習 → 推奨
 */
export async function runMetaExecutive(text: string, booted: BootResult, opts: MetaExecutiveOptions): Promise<MetaExecutiveResult> {
  const budget = opts.budget ?? estimateBudget(text, { battery: opts.battery });
  const actions: string[] = [];
  actions.push(`BUDGET: ${budget.reason} allowReasoning=${budget.allowReasoning} maxExpansions=${budget.maxExpansions} beam=${budget.beam} battery=${budget.battery.toFixed(2)}`);

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
    taskId = b.addNode('task', 'meta', 'unknown', { domain: 'reasoning', intent: 'unknown' });
    g = b.graph();
  }

  // ── Thinking Budget: Reasoning 禁止（2+2 / Battery 8% など）──
  if (!budget.allowReasoning) {
    const meInit = metaExecutive(g, taskId, text, { policy: 'none', beam: 0, explore: 0, experts: budget.experts });
    g = meInit.graph;
    actions.push(`META: Reasoning 禁止（${budget.reason}）→ 直接解決（予算 0 / Expert: ${budget.experts.join(',') || 'none'}）`);
    return {
      graph: g,
      taskId,
      metaExecutiveId: meInit.id,
      text,
      budget,
      trials: [],
      recommendedConfig: null,
      finalText: null,
      finalConfidence: null,
      policySwitches: [],
      actions,
    };
  }

  // ── Meta Executive 起動 ──
  const meInit = metaExecutive(g, taskId, text);
  g = meInit.graph;

  const trials: MetaTrial[] = [];
  const policySwitches: string[] = [];
  let bestTrial: { config: ExecutiveConfig; metaScore: number; result: { graph: AilsmGraph; taskId: number; executiveId: number; finalText: string | null; finalConfidence: number | null } } | null = null;

  for (let i = 0; i < opts.candidates.length; i++) {
    const config = opts.candidates[i];
    const trialBudget = Math.min(budget.maxExpansions, 4); // 各試行は予算内の小さな探索
    const r = await runExecutive(text, booted, {
      startConfig: config,
      initial: opts.initial,
      generateChildren: opts.generateChildren,
      evaluator: opts.evaluator,
      resolver: opts.resolver,
      budget: trialBudget,
      mergeText: opts.mergeText,
      acceptThreshold: opts.acceptThreshold,
      killThreshold: opts.killThreshold,
    });

    const accuracy = accuracyOf(r.graph, r.taskId);
    const latencyMs = (opts.latencyMs ?? defaultLatency)(config, r.evaluations);
    const cost = r.expansions;
    const metaScore = metaScoreOf(accuracy, latencyMs, cost);

    // 学習（設定 → 結果 の蓄積）
    const key = `${config.policy}|b${config.beam}|e${config.weights.explore.toFixed(1)}`;
    const visits = trials.filter((t) => `${t.config.policy}|b${t.config.beam}|e${t.config.weights.explore.toFixed(1)}` === key).length + 1;
    const prev = trials.filter((t) => `${t.config.policy}|b${t.config.beam}|e${t.config.weights.explore.toFixed(1)}` === key);
    const meanAccuracy = prev.length === 0 ? accuracy : (prev.reduce((s, t) => s + t.outcome.accuracy, 0) + accuracy) / visits;
    const bestAccuracy = Math.max(accuracy, ...prev.map((t) => t.outcome.accuracy));

    const trial: MetaTrial = {
      trial: i + 1,
      config,
      policy: config.policy,
      outcome: { accuracy, latencyMs, cost },
      metaScore,
      learned: { visits, meanAccuracy, bestAccuracy },
      recommended: false,
      finalText: r.finalText,
    };
    trials.push(trial);
    actions.push(`TRIAL ${i + 1}: ${config.policy} beam=${config.beam} explore=${config.weights.explore.toFixed(1)} experts=[${config.experts.join(',')}] → acc=${accuracy.toFixed(2)} lat=${latencyMs}ms cost=${cost} meta=${metaScore.toFixed(3)}`);
    if (i > 0 && config.policy !== opts.candidates[i - 1].policy) {
      policySwitches.push(`${opts.candidates[i - 1].policy}→${config.policy}`);
      actions.push(`META: Search Policy 切替 ${policySwitches[policySwitches.length - 1]}`);
    }

    if (!bestTrial || metaScore > bestTrial.metaScore) {
      bestTrial = { config, metaScore, result: { graph: r.graph, taskId: r.taskId, executiveId: r.executiveId, finalText: r.finalText, finalConfidence: r.finalConfidence } };
    }
  }

  // ── 推奨設定（学習結果）──
  const recommendedConfig = bestTrial!.config;
  for (const t of trials) {
    if (t.config === recommendedConfig) t.recommended = true;
  }
  const best = trials.find((t) => t.recommended)!;
  actions.push(`META: 学習結果 → 推奨 ${recommendedConfig.policy} beam=${recommendedConfig.beam} explore=${recommendedConfig.weights.explore.toFixed(1)} experts=[${recommendedConfig.experts.join(',')}]（acc=${best.outcome.accuracy.toFixed(2)} lat=${best.outcome.latencyMs}ms）`);

  // ── 最終グラフ: 最良試行のグラフに Meta Executive を追加（manages で接続）──
  let fg = bestTrial!.result.graph;
  {
    const b = new AilsmBuilder();
    const remap = new Map<number, number>();
    for (const n of fg.nodes) {
      const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
      remap.set(n.id, id);
    }
    const meId = b.addNode('metaexecutive', 'metaexecutive', 'unknown', {
      goal: text,
      policy: recommendedConfig.policy,
      beam: recommendedConfig.beam,
      explore: recommendedConfig.weights.explore,
      experts: recommendedConfig.experts,
      trials: trials.length,
      bestAccuracy: best.outcome.accuracy,
      bestLatency: best.outcome.latencyMs,
    });
    const t = remap.get(bestTrial!.result.taskId);
    const e = remap.get(bestTrial!.result.executiveId);
    if (t !== undefined && t !== meId) b.connect(t, meId, 'manages');
    if (e !== undefined && e !== meId) b.connect(meId, e, 'manages');
    for (const ed of fg.edges) {
      const from = remap.get(ed.from);
      const to = remap.get(ed.to);
      if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, ed.rel);
    }
    fg = b.graph();
  }

  return {
    graph: fg,
    taskId: bestTrial!.result.taskId,
    metaExecutiveId: fg.nodes.find((n) => n.kind === 'metaexecutive')!.id,
    text,
    budget,
    trials,
    recommendedConfig,
    finalText: bestTrial!.result.finalText,
    finalConfidence: bestTrial!.result.finalConfidence,
    policySwitches,
    actions,
  };
}

/**
 * デモ: 「数学の新理論を考える」— Meta Executive が 3 つの Executive 設定を試して最良を学習
 *
 *   T1 beam  / beam2 / explore0.4 → 探索が強すぎて有望仮説を殺す（acc=0）
 *   T2 best-first / beam1 / explore0.2 → 停滞を検知して探索へ切替 → 統合仮説（acc=0.71）
 *   T3 mcts  / beam2 / explore0.5 → 同上に失敗（acc=0）
 *
 *   → 推奨: best-first beam1 explore0.2（Search Expert は不要 = 編成から外れた）
 */
export async function runMetaExecutiveDemo(): Promise<MetaExecutiveResult> {
  const booted = await import('./expert-runtime.js').then((m) => m.boot());
  return runMetaExecutive('数学の新理論を考える', booted, {
    battery: 1.0,
    candidates: [
      { policy: 'beam', beam: 2, weights: { explore: 0.4, costPenalty: 0.3 }, temperature: 0.4, experts: ['math', 'reasoning', 'search'] },
      { policy: 'best-first', beam: 1, weights: { explore: 0.2, costPenalty: 0.3 }, temperature: 0.2, experts: ['math'] },
      { policy: 'mcts', beam: 2, weights: { explore: 0.5, costPenalty: 0.3 }, temperature: 0.5, experts: ['math', 'reasoning'] },
    ],
    initial: [{ text: '既存の枠組みを疑う', confidence: 0.4, expert: 'reasoning' }],
    generateChildren: (parent) => {
      if (parent.text.includes('枠組み')) return [{ text: '計算を重ねる', confidence: 0.45, expert: 'math' }];
      if (parent.text.includes('計算')) {
        return [
          { text: '統計的に検証する', confidence: 0.5, expert: 'math' },
          { text: '幾何学的に解釈する', confidence: 0.5, expert: 'math' },
          { text: '文献を鵜呑みにする', confidence: 0.3, expert: 'search' },
        ];
      }
      if (parent.text.includes('幾何')) return [{ text: '位相で一般化する', confidence: 0.6, expert: 'reasoning' }];
      return [];
    },
    evaluator: (cand) => {
      if (cand.text.includes('統計')) return { score: 0.55, novelty: 0.9, cost: 0.1, consistency: 0.8 };
      if (cand.text.includes('計算')) return { score: 0.45, novelty: 0.1, cost: 0.05, consistency: 0.6 };
      if (cand.text.includes('幾何')) return { score: 0.8, novelty: 0.4, cost: 0.1, consistency: 0.9 };
      if (cand.text.includes('位相')) return { score: 0.7, novelty: 0.95, cost: 0.15, consistency: 0.85 };
      if (cand.text.includes('鵜呑み')) return { score: 0.3, novelty: 0.05, cost: 0.05, consistency: 0.2 };
      return { score: 0.5, novelty: 0.5, cost: 0.1, consistency: 0.7 };
    },
    acceptThreshold: 0.62,
    killThreshold: 0.3,
    mergeText: (hs) => `${hs.map((h) => h.text).join(' + ')}（統合仮説）`,
  });
}

/** Meta Executive の人間可読表示（Thinking Budget + 学習試行テーブル） */
export function renderMetaExecutive(r: MetaExecutiveResult): string {
  const lines: string[] = [`=== Meta Executive (${r.text}) ===`];
  lines.push(`BUDGET : ${r.budget.reason} allowReasoning=${r.budget.allowReasoning} maxExpansions=${r.budget.maxExpansions} beam=${r.budget.beam} depth=${r.budget.depth} battery=${(r.budget.battery * 100).toFixed(0)}%`);
  if (r.trials.length === 0) {
    lines.push(`META   : Reasoning 禁止（${r.budget.reason}）→ 直接解決`);
    return lines.join('\n');
  }
  for (const t of r.trials) {
    const mark = t.recommended ? ' ◀ 推奨' : '';
    lines.push(`T${t.trial} ${t.policy.padEnd(10)} beam=${t.config.beam} explore=${t.config.weights.explore.toFixed(1)} experts=[${t.config.experts.join(',')}] → acc=${t.outcome.accuracy.toFixed(2)} lat=${t.outcome.latencyMs}ms cost=${t.outcome.cost} meta=${t.metaScore.toFixed(3)}${mark}`);
  }
  if (r.policySwitches.length > 0) {
    lines.push(`POLICY : ${r.policySwitches.join(' → ')}`);
  }
  lines.push(`FINAL  : ${r.finalText ?? '(なし)'}`);
  return lines.join('\n');
}
