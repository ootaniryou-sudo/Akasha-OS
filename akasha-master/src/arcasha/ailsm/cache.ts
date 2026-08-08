/**
 * Context Cache（Phase 0.20）— 解析済み Context の再利用
 *
 * Math Expert が Context18 を一度解析したら AST / Equation / Embedding をキャッシュ。
 * 次回 Context18 が来たら再解析不要（Context のキャッシュレイヤ）。
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';

export type CacheKind = 'ast' | 'embedding' | 'ir' | 'equation' | 'summary';

export interface CacheObject {
  id: number;
  contextId: number;
  kind: CacheKind;
  key: string;
  value: string;
}

export interface CacheResult {
  graph: AilsmGraph;
  cacheId: number;
  hit: boolean; // true = 既にキャッシュ済み（再解析不要）
}

export function cacheKeyOf(contextId: number, kind: CacheKind, key: string): string {
  return `${contextId}:${kind}:${key}`;
}

/** Context の解析結果をキャッシュ（context `contains` cache）。既にあれば hit */
export function cacheArtifact(
  g: AilsmGraph,
  contextId: number,
  kind: CacheKind,
  key: string,
  value: string,
): CacheResult {
  const existing = g.nodes.find(
    (n) =>
      n.kind === 'cache' &&
      n.attrs.context === contextId &&
      n.attrs.kind === kind &&
      n.attrs.key === key,
  );
  if (existing) {
    return { graph: g, cacheId: existing.id, hit: true };
  }

  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const cacheId = b.addNode('cache', `${kind}:${key}`, 'unknown', {
    context: contextId,
    kind,
    key,
    value,
  });
  const ctx = remap.get(contextId);
  if (ctx !== undefined && ctx !== cacheId) b.connect(ctx, cacheId, 'contains');
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), cacheId, hit: false };
}

/** キャッシュ参照（なければ undefined → 再解析が必要） */
export function getCached(
  g: AilsmGraph,
  contextId: number,
  kind: CacheKind,
  key: string,
): string | undefined {
  const n = g.nodes.find(
    (n) =>
      n.kind === 'cache' &&
      n.attrs.context === contextId &&
      n.attrs.kind === kind &&
      n.attrs.key === key,
  );
  return n ? String(n.attrs.value ?? '') : undefined;
}

