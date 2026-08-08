/**
 * Reasoning Search Runtime（Phase 2.5）— 推論そのものを OS のスケジューリング対象に
 *
 *   SPAWN → EXPAND（Reasoning Tree）→ EVALUATE（マルチシグナル）
 *     → REFLECT（ACCEPT / KILL / MERGE）→ SPAWN → EXPAND → ...（ループ）
 *
 * - Expert = 実行資源 / Hypothesis = プロセス / Reflection = スケジューラへの FB
 * - Reasoning Graph = 実行グラフ / Kernel = 探索全体の管理者
 * - 探索戦略（Beam / Best-First / DFS / BFS / MCTS）は SearchPolicy として交換可能
 * - 探索と活用: selectionScore = score*(1-explore) + novelty*explore - cost*penalty
 */

import { compile, AilsmError } from './compiler.js';
import { createProcess } from './state.js';
import { Opcode } from '../ailsa/opcode.js';
import { Slot } from '../ailsa/vocab.js';
import { ABI_VERSION_1_0 } from './abi.js';
import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import {
  accept, activate, childrenOf, evaluate, expand, hypothesisOf, hypothesesOf, hypothesize, kill, markExpanded, merge,
} from './reasoning.js';
import type { EvaluationSignals, Hypothesis } from './reasoning.js';
import { DEFAULT_WEIGHTS, selectionScore } from './search.js';
import type { SearchPolicy, SearchWeights } from './search.js';
import type { BootResult } from './expert-runtime.js';
import type { ExpertDriver } from './driver.js';
import type { HypothesisCandidate } from './reasoning-runtime.js';

export interface SearchTreeItem {
  id: number;
  text: string;
  depth: number;
  state: string;
  expert: string | null;
  score: number | null;
  novelty: number;
  cost: number;
  parentId: number | null;
}

export interface SearchRound {
  round: number;
  expanded: { parentId: number; childIds: number[] }[];
  evaluated: { hypothesisId: number; text: string; expert: string; signals: EvaluationSignals }[];
  accepted: number[];
  killed: number[];
}

export interface SearchResult {
  graph: AilsmGraph;
  taskId: number;
  text: string;
  policy: string;
  rounds: SearchRound[];
  tree: SearchTreeItem[];
  expansions: number;
  evaluations: number;
  acceptedTexts: string[];
  killedCount: number;
  finalText: string | null;
  finalConfidence: number | null;
  actions: string[];
}

export interface SearchOptions {
  policy: SearchPolicy;
  initial: HypothesisCandidate[];
  /** EXPAND: 親仮説から子仮説を生成 */
  generateChildren: (parent: Hypothesis, depth: number) => HypothesisCandidate[];
  /** EVALUATE: マルチシグナル（score / novelty / diversity / cost / consistency） */
  evaluator: (cand: HypothesisCandidate, result: string | null, ok: boolean) => EvaluationSignals;
  resolver?: (expert: string) => ExpertDriver | undefined;
  budget: number; // 最大 EXPAND 回数
  beam: number;
  acceptThreshold?: number;
  killThreshold?: number;
  weights?: SearchWeights;
  mergeText?: (hs: Hypothesis[]) => string;
}

/** Reasoning Search Runtime: SPAWN → EXPAND → EVAL → REFLECT → ... のループ */
export async function runSearch(text: string, booted: BootResult, opts: SearchOptions): Promise<SearchResult> {
  const acceptThreshold = opts.acceptThreshold ?? 0.6;
  const killThreshold = opts.killThreshold ?? 0.25;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const policy = opts.policy;

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
    taskId = b.addNode('task', 'search', 'unknown', { domain: 'reasoning', intent: 'unknown' });
    g = b.graph();
  }

  const actions: string[] = [];
  const rounds: SearchRound[] = [];
  let expansions = 0;
  let evaluations = 0;

  // ── 初期 SPAWN（depth 0）──
  for (const c of opts.initial) {
    const r = hypothesize(g, taskId, c.text, c.confidence, c.expert);
    g = r.graph;
    const pr = createProcess(g, taskId, { owner: c.expert, priority: c.confidence });
    g = pr.graph;
    actions.push(`SPAWN #${r.id} "${c.text}" (${c.expert}, conf=${c.confidence.toFixed(2)})`);
  }

  // ── 探索ループ ──
  let round = 0;
  while (true) {
    // READY = 未展開の仮説（proposed は未評価 / active は評価済みで再展開可能 = Hypothesis Queue）
    const ready = hypothesesOf(g, taskId).filter((h) => (h.state === 'proposed' || h.state === 'active') && !h.expanded);
    if (ready.length === 0 || expansions >= opts.budget) break;
    const selected = policy.select(ready, opts.beam, weights);
    if (selected.length === 0) break;

    const expanded: SearchRound['expanded'] = [];
    const evaluated: SearchRound['evaluated'] = [];
    const acceptedIds: number[] = [];
    const killedIds: number[] = [];

    for (const parent of selected) {
      // EXPAND
      const children = opts.generateChildren(parent, parent.depth);
      const ex = expand(g, taskId, parent.id, children);
      g = ex.graph;
      g = markExpanded(g, parent.id).graph;
      policy.onExpand?.(parent);
      expanded.push({ parentId: parent.id, childIds: ex.ids });
      actions.push(`EXPAND #${parent.id} → ${ex.ids.map((i) => `#${i}`).join(',')}`);
      for (const id of ex.ids) {
        void id;
        const pr = createProcess(g, taskId, { owner: 'reasoning', priority: 0.5 });
        g = pr.graph;
      }
      expansions++;

      // EVALUATE + REFLECT（各子仮説）
      for (const id of ex.ids) {
        const hyp = hypothesisOf(g, id)!;
        const expert = hyp.expert ?? 'general';
        const driver = opts.resolver ? opts.resolver(expert) : booted.drivers.get(expert);
        let result: string | null = null;
        let ok = false;
        if (driver) {
          const resp = await driver.invoke({
            program: [
              { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: expert }, { slot: Slot.INPUT, value: hyp.text }] },
            ],
            abiVersion: ABI_VERSION_1_0,
          });
          ok = resp.ok;
          result = resp.ok ? String(resp.result ?? '') : null;
        }
        const signals = opts.evaluator({ text: hyp.text, confidence: hyp.confidence, expert }, result, ok);
        g = activate(g, id, expert).graph;
        g = evaluate(g, id, signals).graph;
        evaluations++;
        evaluated.push({ hypothesisId: id, text: hyp.text, expert, signals });
        actions.push(`EVAL #${id} ${expert} → score=${signals.score.toFixed(2)} nov=${(signals.novelty ?? 0.5).toFixed(2)}`);

        const mergedHyp = { ...hyp, score: signals.score, novelty: signals.novelty ?? 0.5, cost: signals.cost ?? 0.1 };
        const sel = selectionScore(mergedHyp, weights);
        if (sel >= acceptThreshold) {
          g = accept(g, id).graph;
          acceptedIds.push(id);
          actions.push(`ACCEPT #${id}`);
          policy.onResult?.(hypothesisOf(g, id)!, true);
        } else if (sel <= killThreshold) {
          g = kill(g, id).graph;
          killedIds.push(id);
          actions.push(`KILL #${id}`);
          policy.onResult?.(hypothesisOf(g, id)!, false);
        }
      }
    }

    rounds.push({ round, expanded, evaluated, accepted: acceptedIds, killed: killedIds });
    round++;
  }

  // ── 最終 MERGE（ラウンド横断の採用仮説を統合。merge が元を merged にする）──
  const acceptedHyps = hypothesesOf(g, taskId).filter((h) => h.state === 'accepted');
  if (acceptedHyps.length >= 2) {
    const mergedText = opts.mergeText ? opts.mergeText(acceptedHyps) : acceptedHyps.map((h) => h.text).join(' と ');
    const mr = merge(g, taskId, acceptedHyps.map((h) => h.id), mergedText, Math.min(1, Math.max(...acceptedHyps.map((h) => h.confidence)) + 0.1));
    g = mr.graph;
    g = evaluate(g, mr.id, Math.max(...acceptedHyps.map((h) => h.score ?? 0)) + 0.01).graph;
    g = accept(g, mr.id).graph;
    actions.push(`MERGE #${acceptedHyps.map((h) => h.id).join(',')} → #${mr.id} "${mergedText}"`);
  }

  const allAccepted = hypothesesOf(g, taskId).filter((h) => h.state === 'accepted');
  const final = allAccepted.sort((a, b) => (b.parentIds.length - a.parentIds.length) || (b.score ?? 0) - (a.score ?? 0))[0] ?? null;
  const tree: SearchTreeItem[] = hypothesesOf(g, taskId).map((h) => ({
    id: h.id,
    text: h.text,
    depth: h.depth,
    state: h.state,
    expert: h.expert,
    score: h.score,
    novelty: h.novelty,
    cost: h.cost,
    parentId: h.parentIds.length ? h.parentIds[0] : null,
  }));

  return {
    graph: g,
    taskId,
    text,
    policy: policy.name,
    rounds,
    tree,
    expansions,
    evaluations,
    acceptedTexts: allAccepted.map((h) => h.text),
    killedCount: hypothesesOf(g, taskId).filter((h) => h.state === 'killed').length,
    finalText: final?.text ?? null,
    finalConfidence: final?.confidence ?? null,
    actions,
  };
}

/**
 * デモ: 「新しい数学の理論を考える」
 *   H1(枠組み) ──► H2(統計: score0.55/nov0.90) ── ACCEPT（探索で新発想を採用）
 *              └► H3(幾何: score0.80/nov0.40) ──► H4(位相: score0.70/nov0.95) ── ACCEPT
 *   最終 MERGE → 「統計的に検証する + 位相で一般化する」
 *   → 探索(explore=0.5)により「スコアが低くても新規性が高い」仮説が生き残る
 */
export async function runSearchDemo(): Promise<SearchResult> {
  const booted = await import('./expert-runtime.js').then((m) => m.boot());
  return runSearch('新しい数学の理論を考える', booted, {
    policy: new (await import('./search.js')).BeamSearchPolicy(),
    beam: 2,
    budget: 6,
    initial: [{ text: '既存の枠組みを疑う', confidence: 0.4, expert: 'reasoning' }],
    generateChildren: (parent) => {
      if (parent.text.includes('枠組み')) {
        return [
          { text: '統計的に検証する', confidence: 0.5, expert: 'math' },
          { text: '幾何学的に解釈する', confidence: 0.5, expert: 'math' },
          { text: '文献を鵜呑みにする', confidence: 0.3, expert: 'search' },
        ];
      }
      if (parent.text.includes('統計')) return [{ text: 'データで裏付ける', confidence: 0.6, expert: 'search' }];
      if (parent.text.includes('幾何')) return [{ text: '位相で一般化する', confidence: 0.6, expert: 'reasoning' }];
      return [];
    },
    evaluator: (cand) => {
      if (cand.text.includes('統計')) return { score: 0.55, novelty: 0.9, cost: 0.1, consistency: 0.8 };
      if (cand.text.includes('幾何')) return { score: 0.8, novelty: 0.4, cost: 0.1, consistency: 0.9 };
      if (cand.text.includes('データ')) return { score: 0.85, novelty: 0.6, cost: 0.15, consistency: 0.95 };
      if (cand.text.includes('位相')) return { score: 0.7, novelty: 0.95, cost: 0.15, consistency: 0.85 };
      if (cand.text.includes('鵜呑み')) return { score: 0.3, novelty: 0.05, cost: 0.05, consistency: 0.2 };
      return { score: 0.5, novelty: 0.5, cost: 0.1, consistency: 0.7 };
    },
    weights: { explore: 0.5, costPenalty: 0.3 },
    acceptThreshold: 0.62,
    killThreshold: 0.3,
    mergeText: (hs) => `${hs.map((h) => h.text).join(' + ')}（統合仮説）`,
  });
}

/** Reasoning Tree の人間可読表示 */
export function renderSearch(r: SearchResult): string {
  const lines: string[] = [`=== Reasoning Search (${r.policy}) ===`];
  const byParent = new Map<number | null, SearchTreeItem[]>();
  for (const t of r.tree) {
    const list = byParent.get(t.parentId) ?? [];
    list.push(t);
    byParent.set(t.parentId, list);
  }
  const render = (id: number | null, indent: number): void => {
    for (const t of byParent.get(id) ?? []) {
      const stateMark =
        t.state === 'accepted' ? ' ✅'
        : t.state === 'killed' ? ' ❌'
        : t.state === 'merged' ? ' 🔀'
        : '';
      lines.push(`${'  '.repeat(indent)}H${t.id} [${t.expert ?? '?'}] "${t.text}" score=${(t.score ?? 0).toFixed(2)} nov=${t.novelty.toFixed(2)}${stateMark}`);
      render(t.id, indent + 1);
    }
  };
  render(null, 0);
  lines.push(`EXPAND=${r.expansions} EVAL=${r.evaluations} ACCEPT=${r.acceptedTexts.length} KILL=${r.killedCount}`);
  lines.push(`FINAL : ${r.finalText ?? '(なし)'}`);
  return lines.join('\n');
}

/** 子仮説の列挙（外部利用） */
export function searchChildren(g: AilsmGraph, parentId: number): Hypothesis[] {
  return childrenOf(g, parentId);
}

