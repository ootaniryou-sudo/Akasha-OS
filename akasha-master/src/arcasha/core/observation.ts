/**
 * ArcAsha — Observation (タスク評価 + 報酬)
 *
 * ルールベースのタスク評価 (coding / math / reasoning) と、
 * 多目的報酬 (Quality + Latency + Cost + Stability) の計算。
 * ⚠️ cost は EstimatedCost (params 比例の proxy, 実測ではない)。
 */

import type { Capability, EvalResult, ExpertInfo, NodeState } from '../core/types.js';

// ── ルールベース評価 (0003 系と同一仕様) ──────────────────────────────

export function evaluateCoding(text: string): number {
  const lower = text.toLowerCase();
  const structural = ['def ', 'return ', 'import ', 'class ', 'print(', 'for ', 'if ', 'else:', 'while ', 'len(', 'range('];
  const structHits = structural.filter(k => lower.includes(k)).length;
  const structScore = Math.min(1.0, structHits / 5);
  const refusal = ['sorry', 'cannot', 'unable', 'as an ai', 'i am'];
  const refusalHits = refusal.filter(k => lower.includes(k)).length;
  const refusalPenalty = refusalHits * 0.35;
  return Math.max(0.0, Math.min(1.0, structScore - refusalPenalty));
}

export function evaluateMath(text: string): number {
  const lower = text.toLowerCase();
  const mathSignals = ['=', '+', '*', '/', '^', 'result', 'answer', 'solution', 'sum', 'product', 'integral', 'derivative', 'x ='];
  const signalHits = mathSignals.filter(k => lower.includes(k)).length;
  const signalScore = Math.min(1.0, signalHits / 4);
  const hasNumbers = /\d+/.test(text);
  const numberBonus = hasNumbers ? 0.2 : 0;
  const refusal = ['sorry', 'cannot', 'unable', 'as an ai', 'i am'];
  const refusalHits = refusal.filter(k => lower.includes(k)).length;
  const refusalPenalty = refusalHits * 0.35;
  return Math.max(0.0, Math.min(1.0, signalScore + numberBonus - refusalPenalty));
}

export function evaluateReasoning(text: string): number {
  const lower = text.toLowerCase();
  const signals = ['because', 'therefore', 'if ', 'then', 'since', 'first', 'second', 'step', 'thus', 'answer', 'reason', 'so '];
  const signalHits = signals.filter(k => lower.includes(k)).length;
  const signalScore = Math.min(1.0, signalHits / 4);
  const hasNumbers = /\d+/.test(text);
  const numberBonus = hasNumbers ? 0.2 : 0;
  const refusal = ['sorry', 'cannot', 'unable', 'as an ai', 'i am'];
  const refusalHits = refusal.filter(k => lower.includes(k)).length;
  const refusalPenalty = refusalHits * 0.35;
  return Math.max(0.0, Math.min(1.0, signalScore + numberBonus - refusalPenalty));
}

export function evaluateTask(capability: Capability, text: string): number {
  switch (capability) {
    case 'coding': return Math.round(evaluateCoding(text) * 1000) / 1000;
    case 'math': return Math.round(evaluateMath(text) * 1000) / 1000;
    case 'reasoning': return Math.round(evaluateReasoning(text) * 1000) / 1000;
  }
}

// ── 多目的報酬 (EstimatedCost を含む) ────────────────────────────────

export const REWARD_W = { q: 1.0, lat: 0.10, cost: 0.10, stab: 0.10 };

export function rewardFor(
  node: ExpertInfo,
  result: EvalResult,
  state: NodeState,
  maxLatencyMs: number,
  maxParamsM: number,
): number {
  return REWARD_W.q * result.score
    + REWARD_W.lat * (1 - result.latencyMs / Math.max(1, maxLatencyMs))
    + REWARD_W.cost * (1 - node.paramsM / Math.max(1, maxParamsM))   // EstimatedCost
    + REWARD_W.stab * state.stability;
}

export function computeRewards(
  experts: ExpertInfo[],
  results: Record<string, EvalResult>,
  states: Record<string, NodeState>,
  maxLatencyMs: number,
  maxParamsM: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of experts) {
    out[n.nodeId] = rewardFor(n, results[n.nodeId], states[n.nodeId], maxLatencyMs, maxParamsM);
  }
  return out;
}

/** Oracle: Quality が最大のノード */
export function findOracle(results: Record<string, EvalResult>): string {
  let best = '';
  let bestScore = -Infinity;
  for (const [id, r] of Object.entries(results)) {
    if (r.score > bestScore) { bestScore = r.score; best = id; }
  }
  return best;
}

/** 結果のシリアライズ (ログ/メモリ用) */
export function formatResult(r: EvalResult): string {
  return `[${r.nodeId}] score=${r.score.toFixed(3)} lat=${r.latencyMs}ms: ${r.text.slice(0, 60).replace(/\n/g, ' ')}`;
}
