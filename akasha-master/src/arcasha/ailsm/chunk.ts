/**
 * Context Chunk / Span 階層（Phase 0.22）— ページより細かい単位
 *
 * CPU の「SSD → Page → Cache Line → Register」に対応する AI 版メモリ階層。
 *
 *   Document → Page → Chunk（段落）→ Span（文 / 数式）
 *
 * Math Expert は「Page 321-323 全部」ではなく「Equation スパンだけ」を読む。
 * Span は kind（equation / code / query / text）で分類され、Slice Loader や TLB が使う。
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import { pagesOf } from './context.js';
import { hasEquation } from './slice.js';

export type SpanKind = 'equation' | 'code' | 'query' | 'text';

export interface ChunkObject {
  id: number;
  pageId: number;
  index: number;
  text: string;
}

export interface SpanObject {
  id: number;
  chunkId: number;
  pageId: number;
  index: number;
  kind: SpanKind;
  text: string;
}

/** ページ → チャンク（段落 = 改行区切り） */
export function splitChunks(pageText: string): string[] {
  return pageText
    .split('\n')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** チャンク → スパン（文 = 句点・改行区切り） */
export function splitSpans(chunkText: string): string[] {
  const spans: string[] = [];
  for (const part of chunkText.split(/(?<=[。．!?！？])\s*/)) {
    const t = part.trim();
    if (t.length > 0) spans.push(t);
  }
  return spans.length > 0 ? spans : [chunkText.trim()];
}

/** スパン分類（数式 / コード / クエリ / テキスト） */
export function spanKindOf(text: string): SpanKind {
  if (hasEquation(text)) return 'equation';
  if (text.includes('function') || /[{}();]/.test(text)) return 'code';
  if (text.includes('?')) return 'query';
  return 'text';
}

export interface SubdivideResult {
  graph: AilsmGraph;
  chunkIds: number[];
  spanIds: number[];
}

/** Context 配下の各ページを Chunk → Span へ細分化（page `contains` chunk `contains` span） */
export function subdivideContext(g: AilsmGraph, contextId: number): SubdivideResult {
  const pages = pagesOf(g, contextId);
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const chunkIds: number[] = [];
  const spanIds: number[] = [];
  for (const page of pages) {
    const chunks = splitChunks(page.text);
    chunks.forEach((cText, ci) => {
      const cid = b.addNode('chunk', `chunk`, 'string', {
        page: page.id,
        index: ci,
        text: cText,
      });
      chunkIds.push(cid);
      const pageNew = remap.get(page.id);
      if (pageNew !== undefined && pageNew !== cid) b.connect(pageNew, cid, 'contains');
      const spans = splitSpans(cText);
      spans.forEach((sText, si) => {
        const sid = b.addNode('span', 'span', 'string', {
          chunk: cid,
          page: page.id,
          index: si,
          kind: spanKindOf(sText),
          text: sText,
        });
        spanIds.push(sid);
        b.connect(cid, sid, 'contains');
      });
    });
  }
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), chunkIds, spanIds };
}

/** ページ配下のチャンクを列挙 */
export function chunksOf(g: AilsmGraph, pageId: number): ChunkObject[] {
  return g.nodes
    .filter((n) => n.kind === 'chunk' && n.attrs.page === pageId)
    .sort((a, b) => Number(a.attrs.index) - Number(b.attrs.index))
    .map((n) => ({
      id: n.id,
      pageId: Number(n.attrs.page),
      index: Number(n.attrs.index),
      text: String(n.attrs.text ?? ''),
    }));
}

/** ページ配下のスパンを列挙 */
export function spansOf(g: AilsmGraph, pageId: number): SpanObject[] {
  return g.nodes
    .filter((n) => n.kind === 'span' && n.attrs.page === pageId)
    .sort((a, b) => Number(a.attrs.index) - Number(b.attrs.index))
    .map((n) => ({
      id: n.id,
      chunkId: Number(n.attrs.chunk),
      pageId: Number(n.attrs.page),
      index: Number(n.attrs.index),
      kind: (n.attrs.kind as SpanKind) ?? 'text',
      text: String(n.attrs.text ?? ''),
    }));
}

/** 指定 kind のスパンだけを列挙（Equation only 等） */
export function spansOfKind(g: AilsmGraph, pageId: number, kind: SpanKind): SpanObject[] {
  return spansOf(g, pageId).filter((s) => s.kind === kind);
}
