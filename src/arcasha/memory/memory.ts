/**
 * ArcAsha — Episode Memory (EXP-0005E)
 *
 * タスク実行のエピソードを保存し、後のルーティング/計画に参照させる。
 * v0.1 ではシンプルな配列 + 検索。将来はベクトル化・圧縮へ拡張。
 */

import type { Task } from '../core/types.js';

export interface Episode {
  id: number;
  task: Task;
  decisions: { subtaskId: string; nodeId: string; score: number }[];
  integrated: string;
  timestamp: string;
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
}
