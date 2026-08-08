/**
 * Search Policy（Phase 2.5）— 交換可能な「推論カーネル」の探索戦略
 *
 * Reasoning Search Runtime の探索アルゴリズムをプラグイン化する:
 *   Beam Search / Best-First / DFS / BFS / MCTS
 *
 * 探索と活用（exploration vs. exploitation）:
 *   selectionScore = score*(1-explore) + novelty*explore - cost*costPenalty
 *   → score が高くても既出なら（novelty 低）殺せる / score 低くても新発想は残す
 */

import type { Hypothesis } from './reasoning.js';

export interface SearchWeights {
  explore: number; // 0-1（novelty 重視。1 に近いほど探索寄り）
  costPenalty: number; // cost のペナルティ係数
}

export const DEFAULT_WEIGHTS: SearchWeights = { explore: 0.5, costPenalty: 0.3 };

/** 探索と活用を両立した選択スコア */
export function selectionScore(h: Hypothesis, w: SearchWeights = DEFAULT_WEIGHTS): number {
  const score = h.score ?? 0;
  const novelty = h.novelty ?? 0.5;
  const cost = h.cost ?? 0.1;
  return score * (1 - w.explore) + novelty * w.explore - cost * w.costPenalty;
}

export interface SearchPolicy {
  name: string;
  /** READY（proposed かつ未展開）の仮説から beam 個を選ぶ（決定論） */
  select(ready: Hypothesis[], beam: number, weights: SearchWeights): Hypothesis[];
  /** 展開後のフック（MCTS の visit 更新など） */
  onExpand?(hyp: Hypothesis): void;
  /** 評価後のフック（MCTS の結果記録など） */
  onResult?(hyp: Hypothesis, accepted: boolean): void;
}

function topBy(ready: Hypothesis[], key: (h: Hypothesis, w: SearchWeights) => number, beam: number, w: SearchWeights): Hypothesis[] {
  return [...ready].sort((a, b) => key(b, w) - key(a, w)).slice(0, beam);
}

/** Beam Search: selectionScore 上位 beam 個（決定論） */
export class BeamSearchPolicy implements SearchPolicy {
  readonly name = 'beam';
  select(ready: Hypothesis[], beam: number, w: SearchWeights): Hypothesis[] {
    return topBy(ready, (h, ww) => selectionScore(h, ww), beam, w);
  }
}

/** Best-First: selectionScore 最大を 1 つ（貪欲） */
export class BestFirstPolicy implements SearchPolicy {
  readonly name = 'best-first';
  select(ready: Hypothesis[], beam: number, w: SearchWeights): Hypothesis[] {
    return topBy(ready, (h, ww) => selectionScore(h, ww), Math.min(beam, 1), w);
  }
}

/** DFS: 深い仮説を優先（深さ優先） */
export class DFSPolicy implements SearchPolicy {
  readonly name = 'dfs';
  select(ready: Hypothesis[], beam: number, w: SearchWeights): Hypothesis[] {
    return topBy(ready, (h) => h.depth + selectionScore(h, w) / 100, beam, w);
  }
}

/** BFS: 浅い仮説を優先（幅優先） */
export class BFSPolicy implements SearchPolicy {
  readonly name = 'bfs';
  select(ready: Hypothesis[], beam: number, w: SearchWeights): Hypothesis[] {
    return topBy(ready, (h) => -h.depth + selectionScore(h, w) / 100, beam, w);
  }
}

/**
 * MCTS 風: UCB1 選択（score + C*sqrt(ln(N+1)/(visits+1))）
 * 実行回数が少ない（visits 低）ほど探索ボーナスが大きい。
 */
export class MctsPolicy implements SearchPolicy {
  readonly name = 'mcts';
  private readonly visits = new Map<number, number>();
  private readonly wins = new Map<number, number>();
  private readonly C = 1.4;

  select(ready: Hypothesis[], beam: number, w: SearchWeights): Hypothesis[] {
    const N = [...this.visits.values()].reduce((a, b) => a + b, 0);
    const ucb = (h: Hypothesis): number => {
      const n = this.visits.get(h.id) ?? 0;
      const winRate = n === 0 ? 0.5 : (this.wins.get(h.id) ?? 0) / n;
      return winRate + this.C * Math.sqrt(Math.log(N + 1) / (n + 1)) + selectionScore(h, w) / 100;
    };
    return topBy(ready, ucb, beam, w);
  }

  onExpand(hyp: Hypothesis): void {
    this.visits.set(hyp.id, (this.visits.get(hyp.id) ?? 0) + 1);
  }

  onResult(hyp: Hypothesis, accepted: boolean): void {
    this.visits.set(hyp.id, (this.visits.get(hyp.id) ?? 0) + 1);
    if (accepted) this.wins.set(hyp.id, (this.wins.get(hyp.id) ?? 0) + 1);
  }
}

export const SEARCH_POLICIES = {
  beam: () => new BeamSearchPolicy(),
  'best-first': () => new BestFirstPolicy(),
  dfs: () => new DFSPolicy(),
  bfs: () => new BFSPolicy(),
  mcts: () => new MctsPolicy(),
};

