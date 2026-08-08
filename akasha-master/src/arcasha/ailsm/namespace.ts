/**
 * AI Namespace / Virtual Memory（Phase 0.13）
 *
 * - **Namespace**: プロセスごとに Memory Space を分離（Process Isolation）
 *   Process A → Memory Space A / Process B → Memory Space B（他プロセスの記憶は読めない）
 * - **Memory Paging**: Memory SSA が巨大化したら Memory Page に分割し、必要分だけ LOAD PAGE
 *   （Virtual Memory 相当）
 */

import { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';

export interface NamespaceResult {
  graph: AilsmGraph;
  id: number;
}

function rebuildWith(g: AilsmGraph, fn: (b: AilsmBuilder, remap: Map<number, number>) => void): AilsmGraph {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  fn(b, remap);
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return b.graph();
}

/** Namespace#N {name} を作成 */
export function createNamespace(g: AilsmGraph, name: string): NamespaceResult {
  const b = new AilsmBuilder();
  const remap = new Map<number, number>();
  for (const n of g.nodes) {
    const id = b.addNode(n.kind, n.label, n.type, n.attrs, n.constraints);
    remap.set(n.id, id);
  }
  const id = b.addNode('namespace', name, 'string', { name });
  for (const e of g.edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from !== undefined && to !== undefined && from !== to) b.connect(from, to, e.rel);
  }
  return { graph: b.graph(), id };
}

/** Process を Namespace に所属させる（`in` エッジ） */
export function assignNamespace(g: AilsmGraph, processId: number, namespaceId: number): NamespaceResult {
  const out = rebuildWith(g, (b, remap) => {
    const p = remap.get(processId);
    const ns = remap.get(namespaceId);
    if (p !== undefined && ns !== undefined && p !== ns) b.connect(p, ns, 'in');
  });
  return { graph: out, id: namespaceId };
}

export function namespaceOf(g: AilsmGraph, processId: number): string {
  const e = g.edges.find((x) => x.from === processId && x.rel === 'in');
  if (!e) return '';
  const ns = g.nodes.find((n) => n.id === e.to && n.kind === 'namespace');
  return ns ? String(ns.attrs.name ?? '') : '';
}

/** プロセスがメモリにアクセスできるか（namespace 分離） */
export function canAccessMemory(g: AilsmGraph, processId: number, key: string): boolean {
  const mem = g.nodes.find((n) => n.kind === 'memory' && n.attrs.key === key);
  if (!mem) return false;
  const memNs = String(mem.attrs.namespace ?? '');
  if (memNs === '') return true; // 無所属メモリは全プロセス可読
  return namespaceOf(g, processId) === memNs;
}

export interface MemoryPage {
  page: number;
  entries: { id: number; key: string }[];
}

/** Memory SSA をページに分割（Virtual Memory） */
export function pageMemory(g: AilsmGraph, pageSize = 8): MemoryPage[] {
  const mem = g.nodes
    .filter((n) => n.kind === 'memory')
    .sort((a, b) => a.id - b.id)
    .map((n) => ({ id: n.id, key: String(n.attrs.key ?? '') }));
  const pages: MemoryPage[] = [];
  for (let i = 0; i < mem.length; i += pageSize) {
    pages.push({ page: pages.length + 1, entries: mem.slice(i, i + pageSize) });
  }
  return pages;
}

/** ページをロード（参照操作 — グラフは不変） */
export function loadPage(pages: MemoryPage[], pageId: number): MemoryPage | undefined {
  return pages.find((p) => p.page === pageId);
}

