/**
 * Capability オンライン学習（Phase 2 — ODAR 完成）— Static Scheduler → Learning Scheduler
 *
 * 毎回の実実行結果（accuracy / latency / cost）で Capability SSA を更新し、
 * ODAR（Oracle of Choice）が「学習するルーター」になる。
 *
 *   - CapabilityLearner: 指数移動平均（EMA）で能力値を逐次更新
 *   - score(): 精度が高く・速く・安いほど高スコア
 *   - pick(): 学習済み Capability から最良 Expert を選択（Learning Scheduler）
 *   - updateCapabilitySsa(): AILSM の Capability ノードを in-place 更新
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import { capability } from './state.js';

export interface CapabilityObservation {
  accuracy: number; // 0-1（正解率・成功確率）
  latencyMs: number;
  cost: number;
}

export interface LearnedCapability {
  expert: string;
  accuracy: number;
  latencyMs: number;
  cost: number;
  samples: number;
}

const DEFAULT_CAP: Omit<LearnedCapability, 'expert'> = { accuracy: 0.5, latencyMs: 100, cost: 0.5, samples: 0 };

export class CapabilityLearner {
  private readonly caps = new Map<string, LearnedCapability>();
  private readonly alpha: number; // EMA 係数（新しい観測を重視）

  constructor(alpha = 0.3) {
    this.alpha = alpha;
  }

  /** 実実行の観測で能力値を更新（EMA） */
  observe(expert: string, obs: CapabilityObservation): LearnedCapability {
    const prev = this.caps.get(expert) ?? { expert, ...DEFAULT_CAP };
    const w = this.alpha;
    const next: LearnedCapability = {
      expert,
      accuracy: prev.accuracy * (1 - w) + obs.accuracy * w,
      latencyMs: prev.latencyMs * (1 - w) + obs.latencyMs * w,
      cost: prev.cost * (1 - w) + obs.cost * w,
      samples: prev.samples + 1,
    };
    this.caps.set(expert, next);
    return next;
  }

  get(expert: string): LearnedCapability {
    return this.caps.get(expert) ?? { expert, ...DEFAULT_CAP };
  }

  all(): LearnedCapability[] {
    return [...this.caps.values()];
  }

  /** スコア: 精度が高く・速く・安いほど良い（Latency/Cost は正規化） */
  score(expert: string): number {
    const c = this.get(expert);
    return c.accuracy / (c.latencyMs / 100 + c.cost + 0.1);
  }

  /** Learning Scheduler: 学習済み Capability から最良 Expert を選ぶ（決定論） */
  pick(candidates: string[]): string {
    let best = candidates[0];
    for (const c of candidates) {
      if (this.score(c) > this.score(best)) best = c;
    }
    return best;
  }
}

/** AILSM の Capability ノードをオンライン学習値で更新（既存ノードを in-place 更新） */
export function updateCapabilitySsa(
  g: AilsmGraph,
  taskId: number,
  expert: string,
  obs: CapabilityObservation,
): { graph: AilsmGraph; id: number } {
  const existing = g.nodes.find(
    (n) => n.kind === 'capability' && n.attrs.expert === expert && g.edges.some((e) => e.from === taskId && e.to === n.id && e.rel === 'informs'),
  );
  if (!existing) {
    const r = capability(g, taskId, expert, obs.accuracy, obs.latencyMs, obs.cost);
    return { graph: r.graph, id: r.id };
  }
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(
      n.kind,
      n.label,
      n.type,
      n.id === existing.id
        ? { ...n.attrs, accuracy: obs.accuracy, latency: obs.latencyMs, cost: obs.cost, learned: true }
        : n.attrs,
      n.constraints,
    );
    remap.set(n.id, id);
  }
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), id: existing.id };
}
