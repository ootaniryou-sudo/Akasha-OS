/**
 * AI Benchmark（Phase 0.23）— Long Context 比較
 *
 * 既存 LLM（Qwen: 全トークンを読む）vs ArcAsha（Page Fault で必要ページだけ読む）の比較。
 *
 *   指標:
 *     - Token 削減率（1 - loaded/total）
 *     - ページロード率（loadedPages/totalPages）
 *     - Context Fault Rate
 *     - TLB Hit Rate
 *     - レイテンシ比較（baseline vs arcasha → speedup）
 *
 *   baselineMs = 全トークン × PER_TOKEN_MS
 *   arcashaMs  = ロードトークン × PER_TOKEN_MS + Fault 数 × FAULT_MS
 */

import { createContext, pagesOf } from './context.js';
import { requestSlice } from './avm.js';
import type { ExpertKind } from './slice.js';
import { ContextTlb, translateSpan } from './context-tlb.js';
import { TierManager } from './tier.js';
import type { AiPerf } from './perf.js';
import type { AiProfiler } from './profiler.js';

export const PER_TOKEN_MS = 0.05; // 仮想的な 1 トークン処理時間（推論コストが支配的）
export const FAULT_MS = 0.8; // Context Fault のオーバーヘッド

export type PageKind = 'text' | 'equation' | 'search' | 'summary';

/** ページ種別の決定論的な配置（7/5/3 周期） */
export function pageKindOfIndex(i: number): PageKind {
  if (i % 7 === 0) return 'equation';
  if (i % 5 === 0) return 'search';
  if (i % 3 === 0) return 'summary';
  return 'text';
}

/** 固定サイズのページブロックを生成（各ブロック = ちょうど pageSize 文字） */
export function synthesizePageBlock(i: number, pageSize: number): string {
  const kind = pageKindOfIndex(i);
  const base =
    kind === 'equation' ? `式${i}: x^2+2x+1=0 を解く。`
    : kind === 'search' ? `検索結果: doc${i} の要約。`
    : kind === 'summary' ? `要約: 第${i}章の概要。`
    : `本文: 第${i}章の内容。`;
  return base.padEnd(pageSize, '。').slice(0, pageSize);
}

/** pageCount ページの長文 Context を合成（ページ境界がブロックと一致） */
export function synthesizeContext(title: string, pageCount: number, pageSize = 64) {
  const blocks: string[] = [];
  for (let i = 0; i < pageCount; i++) blocks.push(synthesizePageBlock(i, pageSize));
  return createContext({ nodes: [], edges: [] }, title, blocks.join(''), pageSize);
}

export interface BenchQuestion {
  expert: ExpertKind;
  query?: string;
}

export function defaultQuestions(): BenchQuestion[] {
  return [
    { expert: 'math' },
    { expert: 'search', query: '検索結果' },
    { expert: 'planning' },
    { expert: 'math' },
    { expert: 'search', query: '検索結果' },
    { expert: 'planning' },
    { expert: 'math' },
    { expert: 'search', query: '検索結果' },
    { expert: 'planning' },
    { expert: 'math' },
  ];
}

export interface BenchCaseResult {
  question: number;
  expert: ExpertKind;
  totalPages: number;
  loadedPages: number;
  totalTokens: number;
  loadedTokens: number;
  tokenReduction: number; // 1 - loaded/total
  pageLoadRatio: number; // loadedPages/totalPages
  requests: number;
  faults: number;
  faultRate: number;
  baselineMs: number; // Qwen: 全ページ読む
  arcashaMs: number; // 必要ページだけ + Fault コスト
}

export interface BenchTotals {
  totalTokens: number;
  loadedTokens: number;
  tokenReduction: number;
  avgLoadedPages: number;
  avgPageLoadRatio: number;
  totalFaultRate: number;
  baselineMs: number;
  arcashaMs: number;
  speedup: number; // baseline / arcasha
  tlbHitRate: number;
}

export interface BenchResult {
  pageCount: number;
  cases: BenchCaseResult[];
  totals: BenchTotals;
}

export interface BenchInstruments {
  perf?: AiPerf;
  profiler?: AiProfiler;
  tlb?: ContextTlb;
  tier?: TierManager;
}

function tokensOf(chars: number): number {
  return Math.ceil(chars / 4); // 1 トークン ≒ 4 文字（近似）
}

/** Long Context ベンチマーク（同じ Context を複数質問で共有 → 後半は Fault が減る） */
export function runLongContextBenchmark(
  questions: BenchQuestion[] = defaultQuestions(),
  pageCount = 200,
  pageSize = 64,
  instruments: BenchInstruments = {},
): BenchResult {
  const tlb = instruments.tlb ?? new ContextTlb();
  const tier = instruments.tier ?? new TierManager();

  const syn = synthesizeContext('論文', pageCount, pageSize);
  const contextId = syn.contextId;
  const pages = pagesOf(syn.graph, contextId);
  const totalTokens = tokensOf(pages.reduce((a, p) => a + p.text.length, 0));

  let g = syn.graph;
  const cases: BenchCaseResult[] = [];
  let totalLoadedTokens = 0;
  let totalFaults = 0;
  let totalRequests = 0;
  let tlbLookups = 0;
  let tlbHits = 0;

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const slice = requestSlice(g, contextId, q.expert, q.query ?? '');
    g = slice.graph;
    const loadedPages = pagesOf(g, contextId).filter((p) => slice.load.pageIds.includes(p.id));
    const loadedTokens = tokensOf(loadedPages.reduce((a, p) => a + p.text.length, 0));
    totalLoadedTokens += loadedTokens;

    let faults = 0;
    let requests = 0;
    for (const p of loadedPages) {
      requests++;
      const cold = tier.tierOf(p.id) === 'cold';
      if (cold) {
        faults++;
        tier.touch(p.id);
        tier.touch(p.id);
        tier.touch(p.id); // 初回ロードで HOT へ
        instruments.profiler?.recordFault(p.id);
      } else {
        tier.touch(p.id);
      }
      instruments.perf?.recordPageRequest(cold);
      instruments.profiler?.recordPageAccess(p.id, contextId);
      const t = translateSpan(tlb, g, contextId, p.id, 'equation');
      tlbLookups++;
      if (t.hit) tlbHits++;
    }
    totalFaults += faults;
    totalRequests += requests;

    const caseMs = loadedTokens * PER_TOKEN_MS + faults * FAULT_MS;
    instruments.perf?.beginCall(q.expert, caseMs);
    instruments.profiler?.recordExpert(q.expert, caseMs);

    cases.push({
      question: qi,
      expert: q.expert,
      totalPages: pages.length,
      loadedPages: loadedPages.length,
      totalTokens,
      loadedTokens,
      tokenReduction: 1 - loadedTokens / totalTokens,
      pageLoadRatio: loadedPages.length / pages.length,
      requests,
      faults,
      faultRate: requests === 0 ? 0 : faults / requests,
      baselineMs: totalTokens * PER_TOKEN_MS,
      arcashaMs: caseMs,
    });
  }

  const baselineMs = totalTokens * PER_TOKEN_MS * questions.length;
  const arcashaMs = cases.reduce((a, c) => a + c.arcashaMs, 0);
  const totalTokensAll = totalTokens * questions.length; // 全問合計（Qwen が全ページ読む量）

  return {
    pageCount,
    cases,
    totals: {
      totalTokens: totalTokensAll,
      loadedTokens: totalLoadedTokens,
      tokenReduction: 1 - totalLoadedTokens / totalTokensAll,
      avgLoadedPages: cases.reduce((a, c) => a + c.loadedPages, 0) / cases.length,
      avgPageLoadRatio: cases.reduce((a, c) => a + c.pageLoadRatio, 0) / cases.length,
      totalFaultRate: totalRequests === 0 ? 0 : totalFaults / totalRequests,
      baselineMs,
      arcashaMs,
      speedup: arcashaMs === 0 ? 1 : baselineMs / arcashaMs,
      tlbHitRate: tlbLookups === 0 ? 0 : tlbHits / tlbLookups,
    },
  };
}

/** ベンチマークの見出し（論文の Table に相当） */
export function renderBenchmark(b: BenchResult): string {
  const t = b.totals;
  const lines: string[] = ['=== Long Context Benchmark ==='];
  lines.push(`Context Pages  : ${b.pageCount}`);
  lines.push(`Questions      : ${b.cases.length}`);
  lines.push(`Total Tokens   : ${t.totalTokens} / loaded ${t.loadedTokens}`);
  lines.push(`Token Reduction: ${(t.tokenReduction * 100).toFixed(1)}%`);
  lines.push(`Avg Loaded Page: ${t.avgLoadedPages.toFixed(1)} / ${b.pageCount}`);
  lines.push(`Page Load Rate : ${(t.avgPageLoadRatio * 100).toFixed(1)}%`);
  lines.push(`Context Fault  : ${(t.totalFaultRate * 100).toFixed(1)}%`);
  lines.push(`TLB Hit Rate   : ${(t.tlbHitRate * 100).toFixed(1)}%`);
  lines.push(`Latency        : baseline ${t.baselineMs.toFixed(1)}ms vs arcasha ${t.arcashaMs.toFixed(1)}ms`);
  lines.push(`Speedup        : ${t.speedup.toFixed(2)}x`);
  return lines.join('\n');
}
