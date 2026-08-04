/**
 * AILSM — SSA風ID付き意味グラフ（共有IR）
 *
 * 全ノードに一意ID（Task#N / Object#N / Value#N）を付与し、参照はIDで表現する。
 * Planner / Tree Search / Reflection / Memory / Verifier / ODAR は全てこのグラフを見る
 * （CPUで「全員が同じメモリを見る」のに等しい）。
 */

import type { AilsmTypeRef, NodeConstraints } from './types.js';

export type NodeKind =
  | 'task'
  | 'object'
  | 'value'
  | 'memory'
  | 'belief'
  | 'plan'
  | 'reflection'
  | 'capability'
  | 'schedule'
  | 'process'
  | 'thread'
  | 'namespace'
  | 'context'
  | 'page'
  | 'slice'
  | 'cache';

export interface AilsmNode {
  id: number;
  kind: NodeKind;
  label: string;
  type: AilsmTypeRef;
  attrs: Record<string, string | number | boolean | string[]>;
  constraints?: NodeConstraints;
}

export interface AilsmEdge {
  from: number;
  to: number;
  rel: string; // 'uses' | 'input' | 'output' | ...
}

export interface AilsmGraph {
  nodes: AilsmNode[];
  edges: AilsmEdge[];
}

const KIND_LABEL: Record<NodeKind, string> = {
  task: 'Task',
  object: 'Object',
  value: 'Value',
  memory: 'Memory',
  belief: 'Belief',
  plan: 'Plan',
  reflection: 'Reflection',
  capability: 'Capability',
  schedule: 'Schedule',
  process: 'Process',
  thread: 'Thread',
  namespace: 'Namespace',
  context: 'Context',
  page: 'Page',
  slice: 'Slice',
  cache: 'Cache',
};

export function nodeKindLabel(kind: NodeKind): string {
  return KIND_LABEL[kind];
}

function formatTypeRef(t: Exclude<AilsmTypeRef, string>): string {
  if (t.kind === 'union') return `union(${t.types.join('|')})`;
  return `optional(${t.type})`;
}

export class AilsmBuilder {
  private readonly nodes = new Map<number, AilsmNode>();
  private readonly edges: AilsmEdge[] = [];
  private nextId = 1;

  addNode(
    kind: NodeKind,
    label: string,
    type: AilsmTypeRef,
    attrs: AilsmNode['attrs'] = {},
    constraints?: NodeConstraints,
  ): number {
    const id = this.nextId++;
    this.nodes.set(id, { id, kind, label, type, attrs, constraints });
    return id;
  }

  connect(from: number, to: number, rel: string): void {
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      throw new Error(`AILSM: 存在しないノードへの接続 ${from} -${rel}-> ${to}`);
    }
    this.edges.push({ from, to, rel });
  }

  getNode(id: number): AilsmNode | undefined {
    return this.nodes.get(id);
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.length;
  }

  graph(): AilsmGraph {
    return {
      nodes: [...this.nodes.values()].sort((a, b) => a.id - b.id),
      edges: [...this.edges],
    };
  }
}

/** デバッグ用の人間可読ダンプ（文字列ではなく意味ノードで比較できる） */
export function describeGraph(g: AilsmGraph): string {
  const lines: string[] = [];
  for (const n of g.nodes) {
    const attrText = Object.entries(n.attrs)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    const typeText = typeof n.type === 'string' ? n.type : formatTypeRef(n.type);
    const constrText = n.constraints ? ` ${JSON.stringify(n.constraints)}` : '';
    lines.push(
      `${nodeKindLabel(n.kind)}#${n.id} : ${typeText}${attrText ? ` {${attrText}}` : ''}${constrText}`,
    );
  }
  for (const e of g.edges) {
    lines.push(`${kindById(g, e.from)}#${e.from} ${e.rel}(${kindById(g, e.to)}#${e.to})`);
  }
  return lines.join('\n');
}

function kindById(g: AilsmGraph, id: number): string {
  const n = g.nodes.find((x) => x.id === id);
  return n ? nodeKindLabel(n.kind) : '?';
}
