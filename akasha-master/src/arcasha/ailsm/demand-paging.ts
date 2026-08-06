/**
 * Demand Paging / Context Fault / Prefetcher（Phase 0.21）
 *
 * Planner がページを事前指定するのではなく、Expert が「今必要なページ」を要求し、
 * 未ロードなら **Context Fault**（= OS の Page Fault）を起こして Kernel がロードする。
 *
 *   Expert: Page45 が必要 → Context Fault → Kernel → Page45 ロード
 *
 * Prefetcher: 局所性（隣接ページ）から次のページを先読みして resident set へ入れる。
 * これでロングコンテキストは「100万Token読む」ではなく
 * 「Execution Context を維持しながら必要ページだけ読む」になる。
 */

import type { AilsmGraph } from './ailsm.js';
import { executionOf, updateExecution } from './execution.js';
import type { ExecutionContext } from './execution.js';
import { loadPage } from './context.js';

export interface FaultResult {
  graph: AilsmGraph;
  exec: ExecutionContext;
  faulted: boolean; // true = 未ロードだった（Context Fault 発生）
  resident: boolean; // true = 既にロード済みだった
  pageId: number;
  loaded: string; // ロードされたページ実体（fault 時のみ）
}

/** ページが resident set にあるか */
export function isResident(exec: ExecutionContext, pageId: number): boolean {
  return exec.residentPages.includes(pageId);
}

/**
 * Expert がページを要求 → 未ロードなら Context Fault → Kernel がロード（Demand Paging）
 * ロード済みならフォールトなしで current page を進めるだけ。
 */
export function contextFault(g: AilsmGraph, execId: number, pageId: number): FaultResult {
  const cur = executionOf(g, execId);
  if (!cur) throw new Error(`Execution#${execId} がありません`);
  if (isResident(cur, pageId)) {
    const updated = updateExecution(g, execId, { currentPage: pageId });
    return { graph: updated.graph, exec: updated.exec, faulted: false, resident: true, pageId, loaded: '' };
  }
  // Context Fault: Kernel がページ実体をロードして resident set に追加
  const page = loadPage(g, pageId);
  const text = page?.text ?? '';
  const updated = updateExecution(g, execId, {
    currentPage: pageId,
    residentPages: [...cur.residentPages, pageId],
  });
  return { graph: updated.graph, exec: updated.exec, faulted: true, resident: false, pageId, loaded: text };
}

/**
 * Prefetcher: 現在ページの隣接ページ（局所性）を先読みして resident set に入れる。
 * 現在ページが未設定なら先頭 n ページを先読みする。
 */
export function prefetch(
  g: AilsmGraph,
  execId: number,
  n = 1,
): { graph: AilsmGraph; exec: ExecutionContext; prefetched: number[] } {
  const cur = executionOf(g, execId);
  if (!cur) throw new Error(`Execution#${execId} がありません`);
  const pages = g.nodes
    .filter((x) => x.kind === 'page')
    .sort((a, b) => Number(a.attrs.index) - Number(b.attrs.index));
  const curPage = pages.find((p) => p.id === cur.currentPage);
  const curIdx = curPage ? Number(curPage.attrs.index) : null;

  const prefetched: number[] = [];
  let resident = cur.residentPages;
  for (const p of pages) {
    const idx = Number(p.attrs.index);
    const near = curIdx === null ? idx < n : Math.abs(idx - curIdx) <= n;
    if (near && !resident.includes(p.id)) {
      prefetched.push(p.id);
      resident = [...resident, p.id];
    }
  }
  const updated = updateExecution(g, execId, { residentPages: resident });
  return { graph: updated.graph, exec: updated.exec, prefetched };
}
