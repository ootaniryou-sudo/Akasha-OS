/**
 * ArcAsha — Episode Memory (EXP-0005E) + Vector Memory + Prior Belief
 *
 * タスク実行のエピソードを保存し、後のルーティング/計画に参照させる。
 * Vector Memory: 外部モデル不要の自己完結 Embedding (文字 n-gram ハッシュ)
 * で類似エピソードを検索し、Agent らしい「記憶からの帰還」を実現する。
 * Prior Belief: 類似エピソードの決定 (node, capability, score) を集計し、
 * **Bayesian 事前分布 μ₀ / n₀** として新タスクの信念を初期化する (Closed Bayesian Loop)。
 */

import type { Capability, Task } from '../core/types.js';

export interface EpisodeDecision {
  subtaskId: string;
  nodeId: string;
  score: number;
  capability: Capability;
}

export interface Episode {
  id: number;
  task: Task;
  decisions: EpisodeDecision[];
  integrated: string;
  timestamp: string;
}

// ── 自己完結 Embedding (文字 bigram ハッシュ → L2 正規化) ──────────

export function embedText(text: string, dim = 256): Float64Array {
  const v = new Float64Array(dim);
  const s = text.toLowerCase();
  for (let i = 0; i <= s.length - 2; i++) {
    const gram = s.slice(i, i + 2);
    let h = 0;
    for (let j = 0; j < gram.length; j++) h = (h * 31 + gram.charCodeAt(j)) >>> 0;
    v[h % dim] += 1;
  }
  // 単語境界の bigram を強くする軽量な重み
  for (const token of s.split(/\s+/)) {
    if (token.length >= 3) {
      let h = 0;
      for (let j = 0; j < token.length; j++) h = (h * 31 + token.charCodeAt(j)) >>> 0;
      v[h % dim] += 2;
    }
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

export function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export class EpisodeMemory {
  private episodes: Episode[] = [];
  private nextId = 0;

  /** エピソードを保存し、ID を返す */
  record(ep: Omit<Episode, 'id' | 'timestamp'>): number {
    const id = this.nextId++;
    this.episodes.push({ ...ep, id, timestamp: new Date().toISOString() });
    return id;
  }

  all(): Episode[] {
    return [...this.episodes];
  }

  /** 直近 k 件を取得 (コンテキスト参照用) */
  recent(k: number): Episode[] {
    return this.episodes.slice(-k);
  }

  /** タスク能力で絞り込み */
  byCapability(cap: string): Episode[] {
    return this.episodes.filter(e => e.task.capability === cap);
  }

  size(): number {
    return this.episodes.length;
  }

  /** Vector Memory: クエリに類似したエピソードを cosine 類似度で上位 k 件返す */
  search(query: string, k = 3): { episode: Episode; similarity: number }[] {
    const q = embedText(query);
    return this.episodes
      .map(ep => ({
        episode: ep,
        similarity: cosine(q, embedText(`${ep.task.capability} ${ep.task.prompt} ${ep.integrated}`)),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  /** 事前信念 (Prior): 類似エピソードの決定を (node, capability) ごとに集計し μ₀/n₀ を返す */
  priorFor(
    task: Task,
    k = 3,
  ): Record<string, Partial<Record<Capability, { mu: number; n: number }>>> {
    const similar = this.search(task.prompt, k);
    const acc: Record<string, Partial<Record<Capability, { sum: number; n: number }>>> = {};
    for (const { episode } of similar) {
      for (const d of episode.decisions) {
        if (!acc[d.nodeId]) acc[d.nodeId] = {};
        const node = acc[d.nodeId];
        if (!node[d.capability]) node[d.capability] = { sum: 0, n: 0 };
        node[d.capability]!.sum += d.score;
        node[d.capability]!.n += 1;
      }
    }
    const out: Record<string, Partial<Record<Capability, { mu: number; n: number }>>> = {};
    for (const [nodeId, caps] of Object.entries(acc)) {
      out[nodeId] = {};
      for (const [cap, v] of Object.entries(caps)) {
        if (!v) continue;
        out[nodeId][cap as Capability] = { mu: Math.round((v.sum / v.n) * 1000) / 1000, n: v.n };
      }
    }
    return out;
  }
}
