/**
 * AILSM Visualizer — AILSM（SSA風ID付き意味グラフ）を可視化する
 *
 * 「見えるIR」: デバッグ / 論文図 / 人間による理解確認 / Golden Test比較 に使う。
 * 出力形式: Mermaid（flowchart）/ Graphviz DOT / ASCIIツリー（ターミナル）
 */

import { nodeKindLabel } from './ailsm.js';
import type { AilsmGraph, AilsmNode } from './ailsm.js';
import type { AilsmTypeRef } from './types.js';

function typeText(t: AilsmTypeRef): string {
  if (typeof t === 'string') return t;
  if (t.kind === 'union') return `union(${t.types.join('|')})`;
  return `optional(${t.type})`;
}

function nodeIdOf(n: AilsmNode): string {
  const prefix = n.kind === 'task' ? 'T' : n.kind === 'object' ? 'O' : 'V';
  return `${prefix}${n.id}`;
}

function nodeLabel(n: AilsmNode): string {
  const parts = [`${nodeKindLabel(n.kind)}#${n.id} : ${typeText(n.type)}`];
  const attrText = Object.entries(n.attrs)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  if (attrText) parts.push(attrText);
  if (n.constraints) parts.push(JSON.stringify(n.constraints));
  return parts.join(' ');
}

/** Mermaid ラベル用に特殊文字をエスケープ */
function escMermaid(s: string): string {
  return s.replace(/"/g, "'").replace(/[\[\]{}|]/g, (c) => `\\${c}`);
}

function mermaidLabel(n: AilsmNode): string {
  const parts = [
    `${nodeKindLabel(n.kind)}#${n.id} : ${typeText(n.type)}`,
    ...Object.entries(n.attrs).map(([k, v]) => `${k}=${JSON.stringify(v)}`),
    ...(n.constraints ? [JSON.stringify(n.constraints)] : []),
  ];
  return escMermaid(parts.join('<br/>'));
}

/** Mermaid flowchart ソース */
export function toMermaid(g: AilsmGraph): string {
  const lines: string[] = ['flowchart TD'];
  for (const n of g.nodes) {
    const label = mermaidLabel(n);
    const id = nodeIdOf(n);
    if (n.kind === 'task') lines.push(`  ${id}["${label}"]`);
    else if (n.kind === 'object') lines.push(`  ${id}(["${label}"])`);
    else lines.push(`  ${id}{"${label}"}`);
  }
  const idByNode = new Map(g.nodes.map((n) => [n.id, nodeIdOf(n)]));
  for (const e of g.edges) {
    const from = idByNode.get(e.from);
    const to = idByNode.get(e.to);
    if (from && to) lines.push(`  ${from} -->|${escMermaid(e.rel)}| ${to}`);
  }
  return lines.join('\n');
}

/** Graphviz DOT ソース */
export function toDot(g: AilsmGraph): string {
  const shape: Record<string, string> = { task: 'box', object: 'ellipse', value: 'diamond' };
  const lines = ['digraph AILSM {', '  node [fontname="Helvetica"];'];
  for (const n of g.nodes) {
    const label = nodeLabel(n).replace(/"/g, "'").split(' ').join('\\n');
    lines.push(`  ${nodeIdOf(n)} [label="${label}", shape=${shape[n.kind] ?? 'box'}];`);
  }
  const idByNode = new Map(g.nodes.map((n) => [n.id, nodeIdOf(n)]));
  for (const e of g.edges) {
    const from = idByNode.get(e.from);
    const to = idByNode.get(e.to);
    if (from && to) lines.push(`  ${from} -> ${to} [label="${e.rel}"];`);
  }
  lines.push('}');
  return lines.join('\n');
}

function nodeById(g: AilsmGraph, id: number): AilsmNode | undefined {
  return g.nodes.find((n) => n.id === id);
}

function renderSubtree(g: AilsmGraph, id: number, prefix: string, isLast: boolean, rel: string, out: string[]): void {
  const n = nodeById(g, id);
  if (!n) return;
  out.push(`${prefix}${isLast ? '└─ ' : '├─ '}${rel} → ${nodeLabel(n)}`);
  const children = g.edges.filter((e) => e.from === id);
  const childPrefix = prefix + (isLast ? '   ' : '│  ');
  children.forEach((e, i) => renderSubtree(g, e.to, childPrefix, i === children.length - 1, e.rel, out));
}

/** ASCIIツリー（ターミナル用） */
export function toAsciiTree(g: AilsmGraph): string {
  const task = g.nodes.find((n) => n.kind === 'task');
  if (!task) return g.nodes.map((n) => nodeLabel(n)).join('\n');
  const out: string[] = [nodeLabel(task)];
  const children = g.edges.filter((e) => e.from === task.id);
  children.forEach((e, i) => renderSubtree(g, e.to, '', i === children.length - 1, e.rel, out));
  return out.join('\n');
}
