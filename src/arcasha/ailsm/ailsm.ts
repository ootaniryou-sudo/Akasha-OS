/**
 * AILSM — SSA風ID付き意味グラフ（共有IR）
 *
 * 全ノードに一意ID（Task#N / Object#N / Value#N）を付与し、参照はIDで表現する。
 * Planner / Tree Search / Reflection / Memory / Verifier / ODAR は全てこのグラフを見る
 * （CPUで「全員が同じメモリを見る」のに等しい）。
 */

import type { AilsmType } from './types.js';

export type NodeKind = 'task' | 'object' | 'value';

export interface AilsmNode {
  id: number;
  kind: NodeKind;
  label: string;
  type: AilsmType;
  attrs: Record<string, string | number | boolean | string[]>;
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

const KIND_LABEL: Record<NodeKind, string> = { task: 'Task', object: 'Object', value: 'Value' };

export function nodeKindLabel(kind: NodeKind): string {
  return KIND_LABEL[kind];
}

export class AilsmBuilder {
  private readonly nodes = new Map<number, AilsmNode>();
  private readonly edges: AilsmEdge[] = [];
  private nextId = 1;

  addNode(
    kind: NodeKind,
    label: string,
    type: AilsmType,
    attrs: AilsmNode['attrs'] = {},
  ): number {
    const id = this.nextId++;
    this.nodes.set(id, { id, kind, label, type, attrs });
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
    lines.push(
      `${nodeKindLabel(n.kind)}#${n.id} : ${n.type}${attrText ? ` {${attrText}}` : ''}`,
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
