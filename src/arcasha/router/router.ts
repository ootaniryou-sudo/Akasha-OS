/**
 * ArcAsha — Routers (LinUCB-Shadow / UCB-Shadow)
 *
 * EXP-0003C.4 で検証した LinUCB-Shadow と、EXP-0003C.3 の UCB-Shadow を
 * 統一インターフェースで実装。どちらも「シャドウ評価で全アームの報酬を観測」
 * (Full Information) することを前提とする。
 *
 * フィーチャベクトル (8 次元):
 *   [1, capability, latency, cost, stability, confidence, memory, temperature]
 */

import type { Capability, ExpertInfo, StepContext } from '../core/types.js';
import { LinUCB } from './linucb.js';

export const FEATURE_DIM = 8;
export const FEATURE_NAMES = ['bias', 'capability', 'latency', 'cost', 'stability', 'confidence', 'memory', 'temperature'];

export interface Router {
  name: string;
  /** タスクに対するノード選択 (order 順でタイブレーク) */
  select(ctx: StepContext): string;
  /** 全ノードのスコア (EXP-0005C topK 動的割当用) */
  scores(ctx: StepContext): Record<string, number>;
  /** シャドウ評価後の全アーム観測による更新 */
  observe(ctx: StepContext): void;
  /** 学習済み重み (デバッグ/可視化用) */
  learnedWeights(): Record<string, number[]> | null;
}

/** 特徴量構築 (注入後のレイテンシは states[].latencyMs に反映済み) */
export function buildFeatures(
  experts: ExpertInfo[],
  ctx: StepContext,
  nodeId: string,
  removeIdx = -1,
): number[] {
  const st = ctx.states[nodeId];
  const node = experts.find(e => e.nodeId === nodeId)!;
  const maxLat = Math.max(...experts.map(e => ctx.states[e.nodeId].latencyMs), 1);
  const maxParams = Math.max(...experts.map(e => e.paramsM), 1);
  const cap = st.capability[ctx.task.capability];
  const full = [
    1,
    cap.mu,
    1 - st.latencyMs / maxLat,
    1 - node.paramsM / maxParams,     // EstimatedCost
    st.stability,
    cap.confidence,
    1 - node.memoryGB / 2.0,
    1 - node.temperature / 1.0,
  ];
  if (removeIdx < 0) return full;
  return full.filter((_, i) => i !== removeIdx);
}

// ── LinUCB-Shadow (EXP-0003C.4 の優勝手法) ────────────────────────

export class LinUCBShadowRouter implements Router {
  readonly name = 'LinUCB-Shadow';
  private lin: Map<string, LinUCB> = new Map();

  constructor(
    private readonly experts: ExpertInfo[],
    alpha = 0.3,
    lambda = 1.0,
    private readonly removeIdx = -1,
  ) {
    const dim = FEATURE_DIM - (removeIdx >= 0 ? 1 : 0);
    for (const e of experts) this.lin.set(e.nodeId, new LinUCB(dim, alpha, lambda));
  }

  select(ctx: StepContext): string {
    const sc = this.scores(ctx);
    let best = '';
    let bestScore = -Infinity;
    for (const id of ctx.order) {
      if (sc[id] > bestScore) { bestScore = sc[id]; best = id; }
    }
    return best;
  }

  scores(ctx: StepContext): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.experts) {
      out[e.nodeId] = this.lin.get(e.nodeId)!.score(buildFeatures(this.experts, ctx, e.nodeId, this.removeIdx));
    }
    return out;
  }

  observe(ctx: StepContext): void {
    for (const e of this.experts) {
      this.lin.get(e.nodeId)!.update(buildFeatures(this.experts, ctx, e.nodeId, this.removeIdx), ctx.rewards[e.nodeId]);
    }
  }

  learnedWeights(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const e of this.experts) out[e.nodeId] = this.lin.get(e.nodeId)!.learnedTheta();
    return out;
  }
}

// ── UCB-Shadow (EXP-0003C.3 の参照手法) ───────────────────────────

export class UCBShadowRouter implements Router {
  readonly name = 'UCB-Shadow';
  private q: Record<string, number> = {};
  private n: Record<string, number> = {};

  constructor(
    private readonly experts: ExpertInfo[],
    private readonly c = 2.0,
  ) {
    for (const e of experts) { this.q[e.nodeId] = 0; this.n[e.nodeId] = 0; }
  }

  select(ctx: StepContext): string {
    const sc = this.scores(ctx);
    let best = '';
    let bestScore = -Infinity;
    for (const id of ctx.order) {
      if (sc[id] > bestScore) { bestScore = sc[id]; best = id; }
    }
    return best;
  }

  scores(ctx: StepContext): Record<string, number> {
    const out: Record<string, number> = {};
    const t = ctx.step;
    for (const e of this.experts) {
      const id = e.nodeId;
      out[id] = this.n[id] === 0 ? Infinity : this.q[id] + Math.sqrt(this.c * Math.log(t + 1) / this.n[id]);
    }
    return out;
  }

  observe(ctx: StepContext): void {
    for (const e of this.experts) {
      const id = e.nodeId;
      this.q[id] = (this.q[id] * this.n[id] + ctx.rewards[id]) / (this.n[id] + 1);
      this.n[id] += 1;
    }
  }

  learnedWeights(): null {
    return null;
  }
}

// ── Fixed Composite (手設計 baseline, EXP-0002E 系) ──────────────

export class FixedRouter implements Router {
  readonly name = 'Fixed';
  private static W = { q: 0.60, lat: 0.20, cost: 0.05, stab: 0.15 };

  constructor(private readonly experts: ExpertInfo[]) {}

  select(ctx: StepContext): string {
    const sc = this.scores(ctx);
    let best = '';
    let bestScore = -Infinity;
    for (const id of ctx.order) {
      if (sc[id] > bestScore) { bestScore = sc[id]; best = id; }
    }
    return best;
  }

  scores(ctx: StepContext): Record<string, number> {
    const taskCap = ctx.task.capability as Capability;
    const maxLat = Math.max(...this.experts.map(e => ctx.states[e.nodeId].latencyMs), 1);
    const maxParams = Math.max(...this.experts.map(e => e.paramsM), 1);
    const out: Record<string, number> = {};
    for (const e of this.experts) {
      const st = ctx.states[e.nodeId];
      out[e.nodeId] = FixedRouter.W.q * (st.capability[taskCap].effective || 0.5)
        + FixedRouter.W.lat * (1 - st.latencyMs / maxLat)
        + FixedRouter.W.cost * (1 - e.paramsM / maxParams)
        + FixedRouter.W.stab * st.stability;
    }
    return out;
  }

  observe(_ctx: StepContext): void {
    // 手設計なので学習しない
  }

  learnedWeights(): null {
    return null;
  }
}
