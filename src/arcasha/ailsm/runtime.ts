/**
 * AILSA Runtime — コンパイル → AI Process生成 → 実行 → 状態遷移（AI OS の実行基盤）
 *
 * run(text):
 *   compile → execute（組み込み解決）
 *     → AIProcess#N 生成（owner / priority / memory）
 *     → AIThread#N 生成（task 対応）
 *     → ローカル解決: Result → Memory SSA → Process finished
 *     → Expert委譲:   Belief → Capability → Schedule → CALL → Process waiting
 *
 * 実行トレース（steps）+ Runtime Events（SPAWN/CALL/WAIT/FINISH...）で
 * 全ての状態遷移を再現可能に記録する（AI Runtime Model v1.0）。
 */

import { compileAndRun } from './compiler.js';
import {
  believe,
  capability,
  createProcess,
  remember,
  schedule,
  setProcessState,
  spawnThread,
} from './state.js';
import type { AilsmGraph } from './ailsm.js';
import type { RuntimeEvent } from './scheduler.js';

export interface RuntimeStep {
  kind:
    | 'input' | 'compile' | 'resolve'
    | 'process' | 'thread'
    | 'belief' | 'capability' | 'schedule' | 'call'
    | 'result' | 'memory' | 'finish' | 'wait' | 'reflect';
  label: string;
}

export interface RuntimeTrace {
  text: string;
  graph: AilsmGraph;
  steps: RuntimeStep[];
  events: RuntimeEvent[];
  needsExpert: boolean;
  resolvedValue: number | string | null;
  processId?: number;
  threadId?: number;
}

/** 静的エキスパート特性表（Phase 2 で ODAR の学習値に置き換える） */
const EXPERT_META: Record<string, { accuracy: number; latencyMs: number; cost: number }> = {
  math: { accuracy: 0.91, latencyMs: 24, cost: 0.4 },
  code: { accuracy: 0.88, latencyMs: 30, cost: 0.5 },
  search: { accuracy: 0.85, latencyMs: 18, cost: 0.3 },
  reasoning: { accuracy: 0.93, latencyMs: 40, cost: 0.6 },
  general: { accuracy: 0.8, latencyMs: 25, cost: 0.4 },
};

export function run(text: string, level: 0 | 1 | 2 | 3 = 2): RuntimeTrace {
  const { compile: compiled, execution } = compileAndRun(text, level);
  let graph = execution.after;
  const steps: RuntimeStep[] = [
    { kind: 'input', label: `Input: ${text}` },
    { kind: 'compile', label: `Compile: ${compiled.capability.domain} / ${compiled.capability.expert}` },
  ];
  const events: RuntimeEvent[] = [];
  let seq = 0;

  const task = graph.nodes.find((n) => n.kind === 'task');
  const taskId = task?.id;

  // ── AI Process / AIThread 生成 ──
  const owner = execution.needsExpert ? compiled.capability.expert : 'local';
  const priority = execution.needsExpert
    ? Math.min(0.99, 0.6 + compiled.capability.confidence * 0.2)
    : 0.9;
  let processId: number | undefined;
  let threadId: number | undefined;

  if (taskId !== undefined) {
    const pr = createProcess(graph, taskId, { owner, priority, memoryBytes: 48 * 1024 });
    graph = pr.graph;
    processId = pr.id;
    events.push({ seq: seq++, kind: 'SPAWN', processId, detail: `AIProcess#${processId} owner=${owner} priority=${priority.toFixed(2)}` });
    steps.push({ kind: 'process', label: `Process#${processId}: owner=${owner} priority=${priority.toFixed(2)} state=created` });

    const th = spawnThread(graph, processId, task?.label ?? 'task');
    graph = th.graph;
    threadId = th.id;
    events.push({ seq: seq++, kind: 'SPAWN', processId, threadId, detail: `AIThread#${threadId} task=${task?.label}` });
    steps.push({ kind: 'thread', label: `Thread#${threadId}: task=${task?.label}` });

    // ライフサイクル: created → ready → running
    graph = setProcessState(graph, processId, 'ready').graph;
    graph = setProcessState(graph, processId, 'running').graph;
  }

  // ── ローカル解決: Result → Memory SSA → finished ──
  if (execution.resolved && processId !== undefined && taskId !== undefined) {
    const value = execution.value;
    steps.push({ kind: 'resolve', label: `Resolve: ${execution.steps.join('; ') || 'local'}` });
    steps.push({ kind: 'result', label: `Result: ${String(value)}` });
    graph = remember(graph, taskId, 'result', value ?? 0).graph;
    steps.push({ kind: 'memory', label: `Memory stores result=${String(value)}` });
    graph = setProcessState(graph, processId, 'finished').graph;
    events.push({ seq: seq++, kind: 'FINISH', processId, detail: `result=${String(value)}` });
    steps.push({ kind: 'finish', label: `Process#${processId} finished` });
    return { text, graph, steps, events, needsExpert: false, resolvedValue: value, processId, threadId };
  }

  // ── Expert 委譲: Belief → Capability → Schedule → CALL → waiting ──
  if (execution.needsExpert && processId !== undefined && taskId !== undefined) {
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

    const prio = Math.min(0.99, confidence + meta.accuracy * 0.05);
    graph = schedule(graph, taskId, expert, prio, meta.latencyMs, meta.cost).graph;
    steps.push({
      kind: 'schedule',
      label: `Schedule: node=${expert} priority=${prio.toFixed(2)} ETA=${meta.latencyMs}ms`,
    });

    graph = setProcessState(graph, processId, 'waiting').graph;
    events.push({ seq: seq++, kind: 'CALL', processId, threadId, detail: `CALL ${expert} (Phase 1 で実機委譲)` });
    steps.push({ kind: 'call', label: `CALL ${expert} (pending — Phase 1 で実機委譲)` });
    events.push({ seq: seq++, kind: 'WAIT', processId, threadId, detail: 'awaiting expert result' });
    steps.push({ kind: 'wait', label: `Process#${processId} waiting` });
    return { text, graph, steps, events, needsExpert: true, resolvedValue: null, processId, threadId };
  }

  return { text, graph, steps, events, needsExpert: false, resolvedValue: null, processId, threadId };
}
