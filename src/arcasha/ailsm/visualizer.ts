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
  const prefix =
    n.kind === 'task' ? 'T'
    : n.kind === 'object' ? 'O'
    : n.kind === 'value' ? 'V'
    : n.kind === 'memory' ? 'M'
    : n.kind === 'belief' ? 'B'
    : n.kind === 'plan' ? 'P'
    : n.kind === 'reflection' ? 'R'
    : n.kind === 'capability' ? 'C'
    : n.kind === 'schedule' ? 'Sc'
    : n.kind === 'process' ? 'Ps'
    : n.kind === 'thread' ? 'Th'
    : n.kind === 'context' ? 'Ct'
    : n.kind === 'page' ? 'Pg'
    : n.kind === 'slice' ? 'Sl'
    : n.kind === 'cache' ? 'Ca'
    : n.kind === 'execution' ? 'Ex'
    : n.kind === 'chunk' ? 'Ch'
    : n.kind === 'span' ? 'Sp'
    : n.kind === 'frame' ? 'Fr'
    : 'Ns'; // namespace
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
    else if (n.kind === 'value') lines.push(`  ${id}{"${label}"}`);
    else if (n.kind === 'memory') lines.push(`  ${id}[("${label}")]`); // シリンダー
    else if (n.kind === 'belief') lines.push(`  ${id}/"${label}"/`); // 平行四辺形
    else if (n.kind === 'plan') lines.push(`  ${id}[["${label}"]]`); // サブルーチン
    else if (n.kind === 'reflection') lines.push(`  ${id}{{"${label}"}}`); // 六角形
    else if (n.kind === 'capability') lines.push(`  ${id}[/"${label}"/]`); // 平行四辺形（縦）
    else if (n.kind === 'schedule') lines.push(`  ${id}>"${label}"]`); // フラグ
    else if (n.kind === 'process') lines.push(`  ${id}((("${label}")))`); // 二重丸
    else if (n.kind === 'thread') lines.push(`  ${id}(("${label}"))`); // 丸
    else if (n.kind === 'context') lines.push(`  ${id}(["${label}"])`); // フォルダ（文書）
    else if (n.kind === 'page') lines.push(`  ${id}["${label}"]`); // 箱（ページ）
    else if (n.kind === 'slice') lines.push(`  ${id}/"${label}"/`); // 平行四辺形（スライス）
    else if (n.kind === 'cache') lines.push(`  ${id}[("${label}")]`); // シリンダー（キャッシュ）
    else if (n.kind === 'execution') lines.push(`  ${id}("${label}")`); // 円（プロセスコンテキスト）
    else if (n.kind === 'chunk') lines.push(`  ${id}["${label}"]`); // 箱（チャンク）
    else if (n.kind === 'span') lines.push(`  ${id}[["${label}"]]`); // サブルーチン（スパン）
    else if (n.kind === 'frame') lines.push(`  ${id}/"${label}"/`); // 平行四辺形（推論フレーム）
    else lines.push(`  ${id}(["${label}"])`); // スタジアム（namespace）
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
  const shape: Record<string, string> = {
    task: 'box',
    object: 'ellipse',
    value: 'diamond',
    memory: 'cylinder',
    belief: 'note',
    plan: 'box3d',
    reflection: 'component',
    capability: 'note',
    schedule: 'record',
    process: 'doublecircle',
    thread: 'ellipse',
    namespace: 'box',
    context: 'folder',
    page: 'box',
    slice: 'note',
    cache: 'cylinder',
    execution: 'box3d',
    chunk: 'box',
    span: 'note',
    frame: 'component',
  };
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

/** 状態遷移図の入力（Runtime の RuntimeStep と構造互換） */
export interface StateStepLike {
  kind: string;
  label: string;
}

/** 実行トレース → Mermaid stateDiagram（状態遷移の可視化） */
export function toStateDiagram(steps: StateStepLike[]): string {
  if (steps.length === 0) return 'stateDiagram-v2\n  [*] --> [*]';
  const lines = ['stateDiagram-v2'];
  const ids: string[] = [];
  steps.forEach((s, i) => {
    const id = `S${i}`;
    ids.push(id);
    lines.push(`  ${id} : ${s.label.replace(/"/g, "'")}`);
  });
  lines.push(`  [*] --> ${ids[0]}`);
  for (let i = 0; i < ids.length - 1; i++) {
    lines.push(`  ${ids[i]} --> ${ids[i + 1]}`);
  }
  lines.push(`  ${ids[ids.length - 1]} --> [*]`);
  return lines.join('\n');
}
