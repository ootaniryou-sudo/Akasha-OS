/**
 * AILSA Runtime — コンパイル → 実行 → 状態遷移（AI State SSA）
 *
 * run(text):
 *   compile → execute（組み込み解決）
 *     resolved    → Result → Memory SSA
 *     needsExpert → Belief SSA → CALL（Phase 1 で実機委譲）
 *
 * 実行トレース（steps）は「AIが何を考え、何を信じ、何を記憶したか」を
 * 全て記録する。State Visualizer で可視化できる。
 */

import { compileAndRun } from './compiler.js';
import { believe, remember } from './state.js';
import type { AilsmGraph } from './ailsm.js';

export interface RuntimeStep {
  kind: 'input' | 'compile' | 'resolve' | 'belief' | 'call' | 'result' | 'memory' | 'reflect';
  label: string;
}

export interface RuntimeTrace {
  text: string;
  graph: AilsmGraph;
  steps: RuntimeStep[];
  needsExpert: boolean;
  resolvedValue: number | string | null;
}

export function run(text: string, level: 0 | 1 | 2 | 3 = 2): RuntimeTrace {
  const { compile: compiled, execution } = compileAndRun(text, level);
  let graph = execution.after;
  const steps: RuntimeStep[] = [
    { kind: 'input', label: `Input: ${text}` },
    { kind: 'compile', label: `Compile: ${compiled.capability.domain} / ${compiled.capability.expert}` },
  ];
  const task = graph.nodes.find((n) => n.kind === 'task');
  const taskId = task?.id;

  // ローカル解決: Result → Memory SSA
  if (execution.resolved && taskId !== undefined) {
    const value = execution.value;
    steps.push({ kind: 'resolve', label: `Resolve: ${execution.steps.join('; ') || 'local'}` });
    steps.push({ kind: 'result', label: `Result: ${String(value)}` });
    graph = remember(graph, taskId, 'result', value ?? 0).graph;
    steps.push({ kind: 'memory', label: `Memory stores result=${String(value)}` });
    return { text, graph, steps, needsExpert: false, resolvedValue: value };
  }

  // Expert 委譲: Belief SSA → CALL（Phase 1 で実機へ）
  if (execution.needsExpert && taskId !== undefined) {
    const expert = compiled.capability.expert;
    const confidence = Math.min(0.95, 0.5 + compiled.capability.confidence * 0.2);
    graph = believe(graph, taskId, expert, confidence, `needs ${expert} expert`).graph;
    steps.push({ kind: 'belief', label: `Belief: expert=${expert}, conf=${confidence.toFixed(2)}` });
    steps.push({ kind: 'call', label: `CALL ${expert} (pending — Phase 1 で実機委譲)` });
    return { text, graph, steps, needsExpert: true, resolvedValue: null };
  }

  return { text, graph, steps, needsExpert: false, resolvedValue: null };
}
