/**
 * Slice Loader（Phase 0.20）— Expert ごとに必要なページだけをロード
 *
 *   Task → Context → Slice（必要なページだけ）→ Expert
 *
 * Math Expert は数式だけ / Search Expert は検索結果だけ / Planning Expert は概要だけ。
 * 全 Expert が全ページを読む必要はない（200MB の知識 → 実際に処理するのは数ページ）。
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';
import { pagesOf } from './context.js';

export type ExpertKind = 'math' | 'search' | 'planning' | 'code' | 'reasoning';

export interface SliceResult {
  graph: AilsmGraph;
  sliceId: number;
  pageIds: number[];
}

/** ページが数式を含むか（Math Expert 用） */
export function hasEquation(text: string): boolean {
  return /[=∫∑∏]|\d+\s*[+\-*/^]\s*\d+|[a-z]\s*[+\-*/^=]\s*[a-z0-9]/i.test(text);
}

/** ページ選択戦略（Expert ごとに「読むページ」が異なる） */
export function selectPages(
  g: AilsmGraph,
  contextId: number,
  expert: ExpertKind,
  query = '',
): SliceResult {
  const pages = pagesOf(g, contextId);
  let selected: typeof pages = [];
  switch (expert) {
    case 'math':
      // 数式だけを読む
      selected = pages.filter((p) => hasEquation(p.text));
      break;
    case 'search': {
      // 検索結果（クエリ or 検索語）だけを読む
      const q = query.toLowerCase();
      selected = q
        ? pages.filter((p) => p.text.toLowerCase().includes(q))
        : pages.filter((p) => /検索|結果|reference|arxiv|doc/i.test(p.text));
      break;
    }
    case 'planning':
      // 概要だけ: 先頭ページ + 要約を含むページ
      selected = pages.filter((p) => p.index === 0 || /要約|概要|summary|はじめに/i.test(p.text));
      break;
    default:
      // code / reasoning: 先頭 2 ページのみ
      selected = pages.slice(0, 2);
  }

  // Slice#N ノードを SSA に追加（slice `uses` page / context `contains` slice）
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const pageIds: number[] = [];
  for (const p of selected) {
    const pid = remap.get(p.id);
    if (pid !== undefined) pageIds.push(pid);
  }
  const sliceId = b.addNode('slice', `${expert} slice`, 'unknown', {
    context: contextId,
    expert,
    query,
    pageCount: pageIds.length,
    pageIds: pageIds.map(String),
  });
  for (const pid of pageIds) {
    if (pid !== sliceId) b.connect(sliceId, pid, 'uses');
  }
  const ctx = remap.get(contextId);
  if (ctx !== undefined && ctx !== sliceId) b.connect(ctx, sliceId, 'contains');
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), sliceId, pageIds };
}

