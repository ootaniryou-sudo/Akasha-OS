/**
 * AILSM Semantic Analyzer — 型検査・矛盾検出（100% 決定論）
 *
 * グラフの参照整合、ドメイン/意図の矛盾、解釈不能入力（Stage 2 LLM残差への
 * 委譲点）を検出する。
 */

import type { AilsmBuilder } from './ailsm.js';
import type { AilsmGraph } from './ailsm.js';

export interface SemanticResult {
  graph: AilsmGraph;
  issues: string[];
}

export function analyze(b: AilsmBuilder): SemanticResult {
  const g = b.graph();
  const issues: string[] = [];

  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      issues.push(`dangling edge: ${e.from} -${e.rel}-> ${e.to}`);
    }
  }

  const task = g.nodes.find((n) => n.kind === 'task');
  if (!task) {
    issues.push('task ノードが存在しない');
    return { graph: g, issues };
  }

  const domain = String(task.attrs.domain ?? 'unknown');
  const intent = String(task.attrs.intent ?? 'unknown');

  if (domain === 'search' && intent === 'solve') {
    issues.push('矛盾: domain=search / intent=solve');
  }
  if (domain === 'code' && intent === 'summarize') {
    issues.push('矛盾: domain=code / intent=summarize');
  }
  if (domain === 'unknown' && intent === 'unknown') {
    issues.push('意味を解釈できません（Stage 2 LLM残差へ委譲すべき）');
  }

  return { graph: g, issues };
}

