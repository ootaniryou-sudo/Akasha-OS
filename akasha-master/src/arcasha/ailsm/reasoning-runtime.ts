/**
 * AI Reasoning Runtime（Phase 2.4）— Reasoning Graph / 仮説ビーム探索
 *
 * 創発的知能 = Expert 同士の循環。一本道の Planner→Math→Search ではなく、
 *   SPAWN（仮説生成）→ EVALUATE（Expert 並列 = 別プロセス）→ REFLECTION（Score）
 *   → ACCEPT / KILL / MERGE → 新仮説 SPAWN → ... 収束
 *
 * これは MoE が Transformer 内部で暗黙に行う探索を、OS（プロセス/SSA）で明示化したもの。
 * 各仮説は独立した AI Process になる（OS レベルの並列）。
 */

import { compile, AilsmError } from './compiler.js';
import { createProcess } from './state.js';
import { Opcode } from '../ailsa/opcode.js';
import { Slot } from '../ailsa/vocab.js';
import { ABI_VERSION_1_0 } from './abi.js';
import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import {
  accept, activate, evaluate, hypothesisOf, hypothesesOf, hypothesize, kill, merge,
} from './reasoning.js';
import type { Hypothesis } from './reasoning.js';
import type { BootResult } from './expert-runtime.js';
import type { ExpertDriver } from './driver.js';

export interface HypothesisCandidate {
  text: string;
  confidence: number;
  expert: string;
}

export interface EvaluatedHypothesis {
  hypothesisId: number;
  text: string;
  expert: string;
  score: number;
  result: string | null;
  ok: boolean;
}

export interface ReasoningRound {
  round: number;
  spawned: HypothesisCandidate[];
  evaluated: EvaluatedHypothesis[];
  accepted: number[];
  killed: number[];
  merged: { from: number[]; to: number; text: string }[];
}

export interface ReasoningResult {
  graph: AilsmGraph;
  taskId: number;
  text: string;
  rounds: ReasoningRound[];
  finalText: string | null;
  finalConfidence: number | null;
  actions: string[];
  expertCalls: number;
  processes: number;
}

export interface ReasoningOptions {
  initial?: HypothesisCandidate[];
  generate?: (text: string, round: number, accepted: Hypothesis[]) => HypothesisCandidate[];
  evaluator?: (cand: HypothesisCandidate, result: string | null, ok: boolean) => number;
  mergeText?: (hs: Hypothesis[]) => string;
  resolver?: (expert: string) => ExpertDriver | undefined;
  maxRounds?: number;
  acceptThreshold?: number;
  killThreshold?: number;
}

/** 既定の仮説生成（ドメイン別の決定論） */
export function defaultHypothesisGenerator(text: string): HypothesisCandidate[] {
  if (/数学|式|解く|積分|微分|x\^|計算/.test(text)) {
    return [
      { text: '直接計算で解を求める', confidence: 0.5, expert: 'math' },
      { text: '因数分解・式変形で考える', confidence: 0.4, expert: 'math' },
      { text: '対称性や一般化を検討する', confidence: 0.3, expert: 'reasoning' },
    ];
  }
  if (/作って|実装|コード|build|create/.test(text)) {
    return [
      { text: 'シンプルな MVP を実装する', confidence: 0.5, expert: 'programming' },
      { text: 'モジュール分割して作る', confidence: 0.4, expert: 'programming' },
      { text: '既存ライブラリを組み合わせる', confidence: 0.3, expert: 'search' },
    ];
  }
  return [
    { text: '主要な仮説 A を立てる', confidence: 0.4, expert: 'reasoning' },
    { text: '対立仮説 B を立てる', confidence: 0.4, expert: 'reasoning' },
    { text: '補助的な仮説 C を立てる', confidence: 0.3, expert: 'search' },
  ];
}

/**
 * Reasoning Graph Runtime: SPAWN → EVALUATE → REFLECTION（accept/kill/merge）→ 収束
 */
export async function runReasoning(
  text: string,
  booted: BootResult,
  opts: ReasoningOptions = {},
): Promise<ReasoningResult> {
  const maxRounds = opts.maxRounds ?? 4;
  const acceptThreshold = opts.acceptThreshold ?? 0.6;
  const killThreshold = opts.killThreshold ?? 0.25;
  const resolver = opts.resolver;

  // Task ノード（コンパイル成功時は AILSM グラフ、失敗時は生タスク）
  let g: AilsmGraph;
  let taskId: number;
  try {
    const compiled = compile(text);
    g = compiled.semantic.graph;
    taskId = g.nodes.find((n) => n.kind === 'task')?.id ?? -1;
  } catch (e) {
    if (!(e instanceof AilsmError)) throw e;
    const b = new AilsmBuilder();
    taskId = b.addNode('task', 'reason', 'unknown', { domain: 'reasoning', intent: 'unknown' });
    g = b.graph();
  }

  const actions: string[] = [];
  const rounds: ReasoningRound[] = [];
  let expertCalls = 0;
  let processes = 0;
  let accepted: Hypothesis[] = [];

  for (let round = 0; round < maxRounds; round++) {
    // ── SPAWN ──
    const candidates =
      round === 0
        ? opts.initial ?? (opts.generate ? opts.generate(text, 0, accepted) : defaultHypothesisGenerator(text))
        : opts.generate
          ? opts.generate(text, round, accepted)
          : [];
    const spawnedIds: number[] = [];
    for (const c of candidates) {
      const r = hypothesize(g, taskId, c.text, c.confidence, c.expert);
      g = r.graph;
      spawnedIds.push(r.id);
      const pr = createProcess(g, taskId, { owner: c.expert, priority: c.confidence });
      g = pr.graph;
      processes++;
      actions.push(`SPAWN #${r.id} "${c.text}" (${c.expert}, conf=${c.confidence.toFixed(2)})`);
    }
    if (spawnedIds.length === 0) break;

    // ── EVALUATE（各仮説は独立 Process — OS レベルの並列。決定論のため逐次実行）──
    const evaluated: EvaluatedHypothesis[] = [];
    for (const id of spawnedIds) {
      const hyp = hypothesisOf(g, id)!;
      const expert = hyp.expert ?? 'general';
      const driver = resolver ? resolver(expert) : booted.drivers.get(expert);
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
        expertCalls++;
      }
      const score = opts.evaluator
        ? opts.evaluator({ text: hyp.text, confidence: hyp.confidence, expert }, result, ok)
        : ok
          ? hyp.confidence
          : 0;
      g = activate(g, id, expert).graph;
      g = evaluate(g, id, score).graph;
      evaluated.push({ hypothesisId: id, text: hyp.text, expert, score, result, ok });
      actions.push(`EVAL #${id} ${expert} → ${score.toFixed(2)}`);
    }

    // ── REFLECTION: Score → ACCEPT / KILL / MERGE ──
    const acceptedIds: number[] = [];
    const killedIds: number[] = [];
    for (const ev of evaluated) {
      if (ev.score >= acceptThreshold) {
        g = accept(g, ev.hypothesisId).graph;
        acceptedIds.push(ev.hypothesisId);
        actions.push(`ACCEPT #${ev.hypothesisId}`);
      } else if (ev.score <= killThreshold) {
        g = kill(g, ev.hypothesisId).graph;
        killedIds.push(ev.hypothesisId);
        actions.push(`KILL #${ev.hypothesisId}`);
      }
    }
    const merged: { from: number[]; to: number; text: string }[] = [];
    if (acceptedIds.length >= 2) {
      const srcs = acceptedIds.map((id) => hypothesisOf(g, id)!);
      const mergedText = opts.mergeText ? opts.mergeText(srcs) : srcs.map((h) => h.text).join(' と ');
      const mr = merge(g, taskId, acceptedIds, mergedText, Math.min(1, Math.max(...srcs.map((h) => h.confidence)) + 0.1));
      g = mr.graph;
      g = accept(g, mr.id).graph;
      merged.push({ from: acceptedIds, to: mr.id, text: mergedText });
      actions.push(`MERGE #${acceptedIds.join(',')} → #${mr.id} "${mergedText}"`);
    }

    rounds.push({ round, spawned: candidates, evaluated, accepted: acceptedIds, killed: killedIds, merged });
    accepted = hypothesesOf(g, taskId).filter((h) => h.state === 'accepted');
    if (accepted.length > 0) break;
  }

  const final =
    hypothesesOf(g, taskId)
      .filter((h) => h.state === 'accepted')
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;
  return {
    graph: g,
    taskId,
    text,
    rounds,
    finalText: final?.text ?? null,
    finalConfidence: final?.confidence ?? null,
    actions,
    expertCalls,
    processes,
  };
}

/**
 * デモ: x^2=9 を解く
 *   SPAWN: H1 "x=3" / H2 "x=-3" / H3 "平方完成で考える"
 *   EVAL : 各仮説を Math/Reasoning Expert で評価 → Reflection がスコア
 *   REFLECTION: H1・H2 採用 → MERGE "x=±3" / H3 は KILL
 */
export async function runReasoningDemo(): Promise<ReasoningResult> {
  const booted = await import('./expert-runtime.js').then((m) => m.boot());
  return runReasoning(
    'x^2=9を解く',
    booted,
    {
      initial: [
        { text: 'x=3 が解', confidence: 0.5, expert: 'math' },
        { text: 'x=-3 が解', confidence: 0.5, expert: 'math' },
        { text: '平方完成で考える', confidence: 0.3, expert: 'reasoning' },
      ],
      evaluator: (cand) => {
        const m = cand.text.match(/x=([+-]?\d+)/);
        if (!m) return 0.2;
        const v = Number(m[1]);
        return Math.abs(v * v - 9) < 0.001 ? 0.8 : 0.3;
      },
      mergeText: () => 'x=±3',
    },
  );
}

/** Reasoning の人間可読表示 */
export function renderReasoning(r: ReasoningResult): string {
  const lines: string[] = ['=== Reasoning Graph ==='];
  for (const rd of r.rounds) {
    lines.push(`Round ${rd.round}:`);
    for (const e of rd.evaluated) {
      lines.push(`  #${e.hypothesisId} [${e.expert}] "${e.text}" score=${e.score.toFixed(2)}`);
    }
    if (rd.accepted.length) lines.push(`  ACCEPT: #${rd.accepted.join(', #')}`);
    if (rd.killed.length) lines.push(`  KILL  : #${rd.killed.join(', #')}`);
    for (const m of rd.merged) lines.push(`  MERGE : #${m.from.join(',#')} → #${m.to} "${m.text}"`);
  }
  lines.push(`FINAL  : ${r.finalText ?? '(なし)'} (conf=${r.finalConfidence?.toFixed(2) ?? '-'})`);
  lines.push(`Expert : ${r.expertCalls} calls / Processes: ${r.processes}`);
  return lines.join('\n');
}
