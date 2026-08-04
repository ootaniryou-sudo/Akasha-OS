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
import { believe, capability, remember, schedule } from './state.js';
import type { AilsmGraph } from './ailsm.js';

export interface RuntimeStep {
  kind:
    | 'input' | 'compile' | 'resolve'
    | 'belief' | 'capability' | 'schedule' | 'call'
    | 'result' | 'memory' | 'reflect';
  label: string;
}

/** 静的エキスパート特性表（Phase 2 で ODAR の学習値に置き換える） */
const EXPERT_META: Record<string, { accuracy: number; latencyMs: number; cost: number }> = {
  math: { accuracy: 0.91, latencyMs: 24, cost: 0.4 },
  code: { accuracy: 0.88, latencyMs: 30, cost: 0.5 },
  search: { accuracy: 0.85, latencyMs: 18, cost: 0.3 },
  reasoning: { accuracy: 0.93, latencyMs: 40, cost: 0.6 },
  general: { accuracy: 0.8, latencyMs: 25, cost: 0.4 },
};

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

  // Expert 委譲: Belief → Capability → Schedule → CALL（全部 SSA、ODAR = SSA）
  if (execution.needsExpert && taskId !== undefined) {
    const expert = compiled.capability.expert;
    const confidence = Math.min(0.95, 0.5 + compiled.capability.confidence * 0.2);
    const meta = EXPERT_META[expert] ?? EXPERT_META.general;

    graph = believe(graph, taskId, expert, confidence, `needs ${expert} expert`).graph;
    steps.push({ kind: 'belief', label: `Belief: expert=${expert}, conf=${confidence.toFixed(2)}` });

    graph = capability(graph, taskId, expert, meta.accuracy, meta.latencyMs, meta.cost, 'IR').graph;
    steps.push({
      kind: 'capability',
      label: `Capability: ${expert} acc=${meta.accuracy} lat=${meta.latencyMs}ms cost=${meta.cost}`,
    });

    const priority = Math.min(0.99, confidence + meta.accuracy * 0.05);
    graph = schedule(graph, taskId, expert, priority, meta.latencyMs, meta.cost).graph;
    steps.push({
      kind: 'schedule',
      label: `Schedule: node=${expert} priority=${priority.toFixed(2)} ETA=${meta.latencyMs}ms`,
    });

    steps.push({ kind: 'call', label: `CALL ${expert} (pending — Phase 1 で実機委譲)` });
    return { text, graph, steps, needsExpert: true, resolvedValue: null };
  }

  return { text, graph, steps, needsExpert: false, resolvedValue: null };
}
