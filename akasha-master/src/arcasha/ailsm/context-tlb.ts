/**
 * Context TLB（Phase 0.22）— Context Translation Cache
 *
 * CPU の TLB（Page Fault のあとの高速変換キャッシュ）に相当。
 * ContextID + PageID + SpanKind → SpanID の変換をキャッシュし、2回目以降は
 * **Fault せず**（走査せず）直接 Span へアクセスできる。
 *
 *   Math → ContextID 52 → Page17 → Equation# → キャッシュ
 *   2回目 → Fault しない
 */

import type { AilsmGraph } from './ailsm.js';
import { spansOfKind } from './chunk.js';
import type { SpanKind } from './chunk.js';

export interface Translation {
  hit: boolean;
  spanIds: number[];
}

export class ContextTlb {
  private readonly map = new Map<string, number[]>();
  private hits = 0;
  private misses = 0;

  private key(contextId: number, pageId: number, spanKind: SpanKind): string {
    return `${contextId}:${pageId}:${spanKind}`;
  }

  lookup(contextId: number, pageId: number, spanKind: SpanKind): number[] | undefined {
    const v = this.map.get(this.key(contextId, pageId, spanKind));
    if (v !== undefined) this.hits++;
    else this.misses++;
    return v;
  }

  store(contextId: number, pageId: number, spanKind: SpanKind, spanIds: number[]): void {
    this.map.set(this.key(contextId, pageId, spanKind), spanIds);
  }

  /** TLB ヒット率（翻訳キャッシュの効率） */
  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  hitCount(): number {
    return this.hits;
  }

  missCount(): number {
    return this.misses;
  }

  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/**
 * Context 翻訳: TLB にヒットすれば走査なしで SpanID を返す。
 * ミスならページのスパンを走査して翻訳をキャッシュ（= 2回目から Fault しない）。
 */
export function translateSpan(
  tlb: ContextTlb,
  g: AilsmGraph,
  contextId: number,
  pageId: number,
  spanKind: SpanKind,
): Translation {
  const cached = tlb.lookup(contextId, pageId, spanKind);
  if (cached !== undefined) return { hit: true, spanIds: cached };
  const ids = spansOfKind(g, pageId, spanKind).map((s) => s.id);
  tlb.store(contextId, pageId, spanKind, ids);
  return { hit: false, spanIds: ids };
}

