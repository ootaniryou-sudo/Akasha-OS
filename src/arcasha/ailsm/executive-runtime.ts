/**
 * Executive Runtime（Phase 2.6）— 推論全体を指揮する Executive
 *
 *   Executive（指揮官）が Reasoning Runtime の探索を制御する:
 *     - ゴール保持（task manages executive）
 *     - 優先順位変更 / Expert 編成（追加・削除 = 実行資源の再構成）
 *     - Search Policy / Beam 幅 / 温度（explore）変更 — 探索の途中で戦略切替
 *
 *   ループ: READY → EXPAND → EVALUATE → REFLECT → EXECUTIVE（戦略切替）→ 次ラウンド
 *
 *   研究テーマ: 「探索の途中で戦略を切り替える」— Transformer/MoE が内部で探索を
 *   固定したまま進めるのに対し、ArcAsha は OS レベルで戦略自体を動的に変えられる。
 *   停滞（accept=0）を検知したら探索へ、成功（accept>0）したら活用へ、と
 *   人間の「考える→違う→別方向→戻る→試す→失敗→単純化→また考える」を司る。
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
import { SEARCH_POLICIES } from './search.js';
import type { SearchPolicy, SearchWeights } from './search.js';
import { executive, updateExecutive } from './executive.js';
import type { ExecutiveConfig } from './executive.js';
import type { BootResult } from './expert-runtime.js';
import type { ExpertDriver } from './driver.js';
import type { HypothesisCandidate } from './reasoning-runtime.js';
import type { SearchTreeItem } from './reasoning-search.js';

export interface ExecutiveRound {
  round: number;
  config: ExecutiveConfig; // このラウンドの探索設定（Executive が決めたもの）
  expanded: { parentId: number; childIds: number[] }[];
  evaluated: { hypothesisId: number; text: string; expert: string; signals: EvaluationSignals }[];
  accepted: number[];
  killed: number[];
  pending: number[]; // 未決定・未展開（次ラウンドの READY）
  executiveActions: string[]; // ラウンド後に Executive が行った制御
}

export interface ExecutiveConfigChange {
  round: number;
  reason: string;
  action: string;
}

export interface ExecutiveResult {
  graph: AilsmGraph;
  taskId: number;
  executiveId: number;
  text: string;
  rounds: ExecutiveRound[];
  tree: SearchTreeItem[];
  expansions: number;
  evaluations: number;
  acceptedTexts: string[];
  killedCount: number;
  finalText: string | null;
  finalConfidence: number | null;
  configChanges: ExecutiveConfigChange[];
  actions: string[];
}

/** Executive の意思決定コンテキスト（デフォルト decide に渡す） */
export interface ExecutiveContext {
  round: number;
  config: ExecutiveConfig;
  expanded: number; // このラウンドの EXPAND 数
  accepted: number; // このラウンドの ACCEPT 数
  killed: number; // このラウンドの KILL 数
  pending: number; // 未決定・未展開の残り
  totalAccepted: number;
  killByExpert: Map<string, number>; // Expert ごとの KILL 数（弱い Expert の特定）
  expertPool: string[]; // 追加可能な Expert プール
}

export interface ExecutiveDecision {
  changes: Partial<ExecutiveConfig>;
  reason: string;
  action: string;
}

export interface ExecutiveOptions {
  initial: HypothesisCandidate[];
  generateChildren: (parent: Hypothesis, depth: number) => HypothesisCandidate[];
  evaluator: (cand: HypothesisCandidate, result: string | null, ok: boolean) => EvaluationSignals;
  resolver?: (expert: string) => ExpertDriver | undefined;
  budget: number; // 最大 EXPAND 回数
  startConfig?: Partial<ExecutiveConfig>;
  expertPool?: string[]; // 追加可能な Expert プール
  decide?: (ctx: ExecutiveContext) => ExecutiveDecision | null; // 差し替え可能
  acceptThreshold?: number;
  killThreshold?: number;
  mergeText?: (hs: Hypothesis[]) => string;
}

/**
 * デフォルト Executive 意思決定:
 *   - 停滞（accept=0 かつ expand>0）→ 探索へ（Policy/Beam/explore 切替 + Expert 追加）
 *   - 成功+淘汰（accept>0 かつ kill>0）→ 活用へ微調整 + 弱い Expert を編成から外す
 *   - 成功（accept>0）→ 活用へ（収束）
 *   - 淘汰のみ（accept=0 かつ kill>0）→ 探索を収束させる
 */
export function defaultDecide(ctx: ExecutiveContext): ExecutiveDecision | null {
  const { config, accepted, killed, expanded } = ctx;
  const r2 = (x: number): number => Math.round(x * 100) / 100;
  if (expanded > 0 && accepted === 0) {
    // 停滞: 探索へ切替
    const nextBeam = Math.min(4, config.beam + 2);
    const nextExplore = r2(Math.min(1, config.weights.explore + 0.4));
    const addExperts = ctx.expertPool.filter((e) => !config.experts.includes(e)).slice(0, 2);
    return {
      changes: {
        policy: 'beam',
        beam: nextBeam,
        weights: { explore: nextExplore, costPenalty: config.weights.costPenalty },
        temperature: nextExplore,
        experts: [...config.experts, ...addExperts],
      },
      reason: '停滞（accept=0）→ 探索へ',
      action: `停滞（accept=0）→ 探索へ切替: ${config.policy}→beam, beam ${config.beam}→${nextBeam}, explore ${config.weights.explore.toFixed(1)}→${nextExplore.toFixed(1)}${addExperts.length ? `, +${addExperts.join('+')}` : ''}`,
    };
  }
  if (accepted > 0 && killed > 0) {
    // 成功 + 淘汰: 活用へ微調整 + 弱い Expert を外す
    let remove: string | null = null;
    let maxKill = 0;
    for (const [e, k] of ctx.killByExpert) {
      if (k > maxKill && config.experts.includes(e)) {
        maxKill = k;
        remove = e;
      }
    }
    const nextBeam = Math.max(1, config.beam - 1);
    const nextExplore = r2(Math.max(0.1, config.weights.explore - 0.2));
    const experts = remove ? config.experts.filter((e) => e !== remove) : config.experts;
    return {
      changes: {
        beam: nextBeam,
        weights: { explore: nextExplore, costPenalty: config.weights.costPenalty },
        temperature: nextExplore,
        experts,
      },
      reason: '成功+淘汰 → 活用へ',
      action: `探索成功（accept=${accepted}）→ 活用へ: beam ${config.beam}→${nextBeam}, explore ${config.weights.explore.toFixed(1)}→${nextExplore.toFixed(1)}${remove ? `, remove ${remove}` : ''}`,
    };
  }
  if (accepted > 0) {
    // 収束: 活用へ
    const nextBeam = Math.max(1, config.beam - 1);
    const nextExplore = r2(Math.max(0.1, config.weights.explore - 0.2));
    return {
      changes: {
        beam: nextBeam,
        weights: { explore: nextExplore, costPenalty: config.weights.costPenalty },
        temperature: nextExplore,
      },
      reason: '収束（accept>0）→ 活用へ',
      action: `収束（accept=${accepted}）→ 活用へ: beam ${config.beam}→${nextBeam}, explore ${config.weights.explore.toFixed(1)}→${nextExplore.toFixed(1)}`,
    };
  }
  if (killed > 0) {
    const nextExplore = r2(Math.max(0.1, config.weights.explore - 0.2));
    return {
      changes: {
        weights: { explore: nextExplore, costPenalty: config.weights.costPenalty },
        temperature: nextExplore,
      },
      reason: 'KILL のみ → 探索を収束',
      action: `淘汰のみ（kill=${killed}）→ 探索を収束: explore ${config.weights.explore.toFixed(1)}→${nextExplore.toFixed(1)}`,
    };
  }
  return null;
}

/** Executive Runtime: READY → EXPAND → EVALUATE → REFLECT → EXECUTIVE → 次ラウンド */
export async function runExecutive(text: string, booted: BootResult, opts: ExecutiveOptions): Promise<ExecutiveResult> {
  const acceptThreshold = opts.acceptThreshold ?? 0.62;
  const killThreshold = opts.killThreshold ?? 0.3;
  const decide = opts.decide ?? defaultDecide;

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

  // Executive 起動（ゴール保持 + 初期戦略）
  const exInit = executive(g, taskId, text, opts.startConfig);
  g = exInit.graph;
  const executiveId = exInit.id;
  let config: ExecutiveConfig = {
    policy: 'best-first',
    beam: 1,
    weights: { explore: 0.2, costPenalty: 0.3 },
    temperature: 0.2,
    experts: ['math'],
    ...opts.startConfig,
  };

  const actions: string[] = [];
  const configChanges: ExecutiveConfigChange[] = [];
  const rounds: ExecutiveRound[] = [];
  let expansions = 0;
  let evaluations = 0;
  let totalAccepted = 0;
  let switchCount = 0;
  let policy: SearchPolicy = makePolicy(config.policy);

  // 初期 SPAWN（depth 0）
  for (const c of opts.initial) {
    const r = hypothesize(g, taskId, c.text, c.confidence, c.expert);
    g = r.graph;
    const pr = createProcess(g, taskId, { owner: c.expert, priority: c.confidence });
    g = pr.graph;
    actions.push(`SPAWN #${r.id} "${c.text}" (${c.expert}, conf=${c.confidence.toFixed(2)})`);
  }

  // ── 探索ループ（Executive が制御）──
  let round = 0;
  while (true) {
    const ready = hypothesesOf(g, taskId).filter((h) => (h.state === 'proposed' || h.state === 'active') && !h.expanded);
    if (ready.length === 0 || expansions >= opts.budget) break;
    const selected = policy.select(ready, config.beam, config.weights);
    if (selected.length === 0) break;

    const expanded: ExecutiveRound['expanded'] = [];
    const evaluated: ExecutiveRound['evaluated'] = [];
    const acceptedIds: number[] = [];
    const killedIds: number[] = [];
    const pendingIds: number[] = [];
    const killByExpert = new Map<string, number>();

    for (const parent of selected) {
      // EXPAND
      const children = opts.generateChildren(parent, parent.depth);
      const ex = expand(g, taskId, parent.id, children);
      g = ex.graph;
      g = markExpanded(g, parent.id).graph;
      expanded.push({ parentId: parent.id, childIds: ex.ids });
      actions.push(`EXPAND #${parent.id} → ${ex.ids.map((i) => `#${i}`).join(',')}`);
      for (const id of ex.ids) {
        // Executive が各仮説プロセスを管理（executive `manages` process）
        void id;
        const pr = createProcess(g, taskId, { owner: 'reasoning', priority: 0.5 });
        g = pr.graph;
        const b2 = new AilsmBuilder();
        const remap = new Map<number, number>();
        for (const n of g.nodes) {
          const nid = b2.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
          remap.set(n.id, nid);
        }
        const f = remap.get(executiveId);
        const t2 = remap.get(pr.id);
        if (f !== undefined && t2 !== undefined && f !== t2) b2.connect(f, t2, 'manages');
        for (const e of g.edges) {
          const ef = remap.get(e.from);
          const et = remap.get(e.to);
          if (ef !== undefined && et !== undefined && ef !== et) b2.connect(ef, et, e.rel);
        }
        g = b2.graph();
      }
      expansions++;

      // EVALUATE + REFLECT
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
        const sel = selectionScoreOf(mergedHyp, config.weights);
        if (sel >= acceptThreshold) {
          g = accept(g, id).graph;
          acceptedIds.push(id);
          totalAccepted++;
          actions.push(`ACCEPT #${id}`);
        } else if (sel <= killThreshold) {
          g = kill(g, id).graph;
          killedIds.push(id);
          killByExpert.set(expert, (killByExpert.get(expert) ?? 0) + 1);
          actions.push(`KILL #${id}`);
        } else {
          pendingIds.push(id);
        }
      }
    }

    // ── EXECUTIVE: ラウンド結果を評価して戦略を切替 ──
    const ctx: ExecutiveContext = {
      round,
      config,
      expanded: expanded.length,
      accepted: acceptedIds.length,
      killed: killedIds.length,
      pending: pendingIds.length,
      totalAccepted,
      killByExpert,
      expertPool: opts.expertPool ?? [],
    };
    const decision = decide(ctx);
    const execActions: string[] = [];
    if (decision) {
      switchCount++;
      config = {
        ...config,
        ...decision.changes,
        weights: decision.changes.weights ?? config.weights,
        experts: decision.changes.experts ?? config.experts,
      };
      policy = makePolicy(config.policy);
      g = updateExecutive(g, executiveId, {
        policy: config.policy,
        beam: config.beam,
        explore: config.weights.explore,
        costPenalty: config.weights.costPenalty,
        temperature: config.temperature,
        experts: config.experts,
        rounds: round + 1,
        accepts: totalAccepted,
        kills: totalKillsOf(g, taskId),
        switches: switchCount,
      }).graph;
      execActions.push(decision.action);
      actions.push(`EXECUTIVE: ${decision.action} (${decision.reason})`);
      configChanges.push({ round, reason: decision.reason, action: decision.action });
    } else {
      g = updateExecutive(g, executiveId, { rounds: round + 1, accepts: totalAccepted }).graph;
    }

    rounds.push({ round, config, expanded, evaluated, accepted: acceptedIds, killed: killedIds, pending: pendingIds, executiveActions: execActions });
    round++;
  }

  // ── 最終 MERGE（ラウンド横断の採用仮説を統合）──
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
    executiveId,
    text,
    rounds,
    tree,
    expansions,
    evaluations,
    acceptedTexts: allAccepted.map((h) => h.text),
    killedCount: hypothesesOf(g, taskId).filter((h) => h.state === 'killed').length,
    finalText: final?.text ?? null,
    finalConfidence: final?.confidence ?? null,
    configChanges,
    actions,
  };
}

function selectionScoreOf(h: Hypothesis, w: SearchWeights): number {
  const score = h.score ?? 0;
  const novelty = h.novelty ?? 0.5;
  const cost = h.cost ?? 0.1;
  return score * (1 - w.explore) + novelty * w.explore - cost * w.costPenalty;
}

function totalKillsOf(g: AilsmGraph, taskId: number): number {
  return hypothesesOf(g, taskId).filter((h) => h.state === 'killed').length;
}

/** ポリシー名から SearchPolicy を生成（unknown は beam にフォールバック） */
function makePolicy(name: string): SearchPolicy {
  const f = (SEARCH_POLICIES as Record<string, () => SearchPolicy>)[name];
  return f ? f() : SEARCH_POLICIES.beam();
}

/**
 * デモ: 「数学の新理論を考える」— Executive が探索の途中で戦略を切り替える
 *
 *   Round0（best-first / beam1 / explore0.2 = 活用）: H1 → H2 計算… accept 出ず → 停滞
 *   EXECUTIVE: 探索へ切替（→ beam, beam 1→3, explore 0.2→0.6, +search +reasoning）
 *   Round1: H2 → {統計 0.55/新規0.90 ACCEPT, 幾何 0.80, 鵜呑み 0.05 KILL}
 *   EXECUTIVE: 活用へ微調整 + remove search（弱い Expert）
 *   Round2: 幾何 → 位相 0.70/0.95 ACCEPT
 *   EXECUTIVE: 収束へ
 *   最終 MERGE → 「統計的に検証する + 位相で一般化する（統合仮説）」
 */
export async function runExecutiveDemo(): Promise<ExecutiveResult> {
  const booted = await import('./expert-runtime.js').then((m) => m.boot());
  return runExecutive('数学の新理論を考える', booted, {
    startConfig: { policy: 'best-first', beam: 1, weights: { explore: 0.2, costPenalty: 0.3 }, temperature: 0.2, experts: ['math'] },
    expertPool: ['search', 'reasoning', 'programming'],
    budget: 6,
    initial: [{ text: '既存の枠組みを疑う', confidence: 0.4, expert: 'reasoning' }],
    generateChildren: (parent) => {
      if (parent.text.includes('枠組み')) {
        return [{ text: '計算を重ねる', confidence: 0.45, expert: 'math' }];
      }
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

/** Executive Runtime の人間可読表示（ツリー + 戦略切替ログ） */
export function renderExecutive(r: ExecutiveResult): string {
  const lines: string[] = [`=== Executive Runtime (${r.text}) ===`];
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
  for (const c of r.configChanges) {
    lines.push(`  EXECUTIVE(R${c.round}): ${c.action}`);
  }
  lines.push(`FINAL : ${r.finalText ?? '(なし)'}`);
  return lines.join('\n');
}

/** Executive の子仮説列挙（外部利用） */
export function executiveChildren(g: AilsmGraph, parentId: number): Hypothesis[] {
  return childrenOf(g, parentId);
}
