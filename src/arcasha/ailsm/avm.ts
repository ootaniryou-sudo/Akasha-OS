/**
 * AI Virtual Memory（Phase 0.20）— Context / Page / Slice / Cache / Long Context ABI の統合
 *
 *   入力(500ページPDF)
 *     → Context Object（そのまま持たない）
 *     → 固定サイズ Page（Page Manager）
 *     → Slice Loader（Expert ごとに必要なページだけ）
 *     → Long Context ABI（ContextRef: 実体ではなく参照）
 *     → Expert（実体は Kernel が保持）→ Context Cache（AST/Equation を再利用）
 *
 * 既存 LLM の「コンテキストウィンドウを拡大する」設計ではなく、
 * 「AI OS が巨大な知識空間を仮想メモリとして管理し、必要な部分だけを供給する」設計。
 */

import type { AilsmGraph } from './ailsm.js';
import { createContext, contextOf, pagesOf } from './context.js';
import type { ContextObject } from './context.js';
import { DEFAULT_PAGE_SIZE } from './context.js';
import { selectPages } from './slice.js';
import type { ExpertKind } from './slice.js';
import { cacheArtifact, getCached } from './cache.js';
import type { CacheKind } from './cache.js';
import { buildContextArgument } from './abi.js';
import type { ContextRef } from './abi.js';

export interface SliceLoad {
  contextId: number;
  sliceId: number;
  expert: ExpertKind;
  pageIds: number[];
  loadedText: string; // 実際に Expert へ供給するテキスト（数ページだけ）
  ref: ContextRef; // Long Context ABI: 参照
  argument: ReturnType<typeof buildContextArgument>; // ABI 引数（type=context）
}

export interface AvmStats {
  context: ContextObject;
  totalPages: number;
  totalChars: number;
  loadedPages: number;
  loadedChars: number;
  loadedRatio: number; // 全知識のうち Expert へ供給した割合（< 1 が理想）
}

export interface StoreResult {
  graph: AilsmGraph;
  context: ContextObject;
}

/** Layer 1+2: Context Object をページ分割して Memory 空間へ置く */
export function storeContext(
  g: AilsmGraph,
  title: string,
  text: string,
  pageSize = DEFAULT_PAGE_SIZE,
): StoreResult {
  const created = createContext(g, title, text, pageSize);
  const context = contextOf(created.graph, created.contextId);
  if (!context) throw new Error('AVM: context を作成できませんでした');
  return { graph: created.graph, context };
}

export interface SliceRequestResult {
  graph: AilsmGraph;
  load: SliceLoad;
  stats: AvmStats;
}

/** Layer 3: Expert ごとに必要なページだけをロード（Slice Loader） */
export function requestSlice(
  g: AilsmGraph,
  contextId: number,
  expert: ExpertKind,
  query = '',
): SliceRequestResult {
  const sliced = selectPages(g, contextId, expert, query);
  const context = contextOf(sliced.graph, contextId);
  if (!context) throw new Error('AVM: context がありません');
  const allPages = pagesOf(sliced.graph, contextId);
  const loaded = allPages.filter((p) => sliced.pageIds.includes(p.id));
  const loadedText = loaded.map((p) => p.text).join('\n');
  const ref: ContextRef = { contextId, pageIds: sliced.pageIds, sliceId: sliced.sliceId };
  const argument = buildContextArgument(0, ref);
  return {
    graph: sliced.graph,
    load: {
      contextId,
      sliceId: sliced.sliceId,
      expert,
      pageIds: sliced.pageIds,
      loadedText,
      ref,
      argument,
    },
    stats: {
      context,
      totalPages: allPages.length,
      totalChars: context.text.length,
      loadedPages: loaded.length,
      loadedChars: loadedText.length,
      loadedRatio: context.text.length > 0 ? loadedText.length / context.text.length : 0,
    },
  };
}

export interface AvmCacheResult {
  graph: AilsmGraph;
  hit: boolean;
  value: string | null;
}

/** Layer 5: 解析結果をキャッシュ。2回目以降は再解析不要 */
export function cacheResult(
  g: AilsmGraph,
  contextId: number,
  kind: CacheKind,
  key: string,
  value: string,
): AvmCacheResult {
  const existing = getCached(g, contextId, kind, key);
  if (existing !== undefined) {
    return { graph: g, hit: true, value: existing };
  }
  const res = cacheArtifact(g, contextId, kind, key, value);
  return { graph: res.graph, hit: res.hit, value };
}

export interface DemoExpertResult {
  expert: ExpertKind;
  driverId: string;
  driverResult: string | number | null;
  slice: SliceLoad;
  stats: AvmStats;
  cacheHit: boolean;
  cacheValue: string | null;
}

export interface AvmDemoResult {
  graph: AilsmGraph;
  contextId: number;
  results: DemoExpertResult[];
  totalChars: number;
  maxLoadedRatio: number; // 全 Expert 中の最大供給割合
}

/**
 * AVM デモ: 巨大な知識空間（長文）を 2 つの Expert（math / search / planning）が
 * 必要なページだけ読んで処理する。
 */
export function runAvmDemo(): AvmDemoResult {
  const text = [
    'これはAI仮想記憶の概要ノート。本稿ではContext ObjectをOSが管理する方式を提案し、ページングとスライスにより必要な知識だけを供給する。',
    'まず式x^2+2x+1=0を考える。これは(x+1)^2=0と因数分解でき、解はx=-1である。次に積分∫x dx=(1/2)x^2+Cを確認する。',
    'ここでは導関数d/dx(x^3)=3x^2を計算する。また行列の固有値はλ^2-5λ+6=0を満たす。',
    '検索結果: arXivの論文は巨大な知識空間を扱う。referenceはdoc1であり、doc2はContext Pagingに関する研究である。',
    '検索結果: doc3はSlice Loaderの実装、doc4はContext Cacheの評価である。',
    'まとめ: 要約すると、AI OSは全ての入力をモデルに投げるのではなく、仮想メモリとして管理し必要部分だけをExpertへ供給する。',
  ].join('\n');

  let g = createContext({ nodes: [], edges: [] }, 'AI-VM研究ノート', text, DEFAULT_PAGE_SIZE).graph;
  const context = contextOf(g, 1);
  if (!context) throw new Error('AVM: コンテキスト初期化に失敗');
  const contextId = context.id;
  const results: DemoExpertResult[] = [];

  // Math Expert: 数式ページだけを読む
  const m = requestSlice(g, contextId, 'math');
  g = m.graph;
  const mCached = getCached(g, contextId, 'equation', 'parsed');
  const mRes = mCached !== undefined
    ? { graph: g, hit: true, value: mCached }
    : cacheResult(g, contextId, 'equation', 'parsed', m.load.loadedText);
  g = mRes.graph;
  results.push({
    expert: 'math',
    driverId: 'math',
    driverResult: m.load.loadedText,
    slice: m.load,
    stats: m.stats,
    cacheHit: mRes.hit,
    cacheValue: mRes.value,
  });

  // Search Expert: 検索語を含むページだけを読む
  const s = requestSlice(g, contextId, 'search', '検索結果');
  g = s.graph;
  results.push({
    expert: 'search',
    driverId: 'search',
    driverResult: s.load.loadedText,
    slice: s.load,
    stats: s.stats,
    cacheHit: false,
    cacheValue: null,
  });

  // Planning Expert: 概要（先頭 + 要約）だけを読む
  const p = requestSlice(g, contextId, 'planning');
  g = p.graph;
  const pCached = getCached(g, contextId, 'summary', 'overview');
  const pRes = pCached !== undefined
    ? { graph: g, hit: true, value: pCached }
    : cacheResult(g, contextId, 'summary', 'overview', p.load.loadedText);
  g = pRes.graph;
  results.push({
    expert: 'planning',
    driverId: 'planning',
    driverResult: pRes.value,
    slice: p.load,
    stats: p.stats,
    cacheHit: pRes.hit,
    cacheValue: pRes.value,
  });

  return {
    graph: g,
    contextId,
    results,
    totalChars: context.text.length,
    maxLoadedRatio: Math.max(...results.map((r) => r.stats.loadedRatio)),
  };
}
