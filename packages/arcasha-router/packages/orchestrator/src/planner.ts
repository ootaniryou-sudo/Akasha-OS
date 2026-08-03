/**
 * arcasha-orchestrator — Planner / Task Decomposition
 *
 * タスクをサブタスクに分解する。ルールベース (v0) と LLM ベース (EXP-0005B) を提供。
 * Dynamic Expert Assignment (EXP-0005C): topK (committee) / parallel を分解に埋め込む。
 */

import type { Capability, Decomposition, Subtask, Task } from 'arcasha-core';
import type { ComputeBackend } from './backend.js';

/** ルールベース分解: タスク能力に応じたサブタスクロール列 (topK = Dynamic Assignment) */
const RULE_PLAN: Record<Capability, { role: string; capability: Capability; template: string; topK?: number }[]> = {
  coding: [
    { role: 'design', capability: 'reasoning', template: 'Design the approach for the following task. Explain steps and data structures.\nTask: {prompt}' },
    { role: 'code', capability: 'coding', template: 'Implement the solution in Python. Write clean, working code.\nTask: {prompt}', topK: 2 },
    { role: 'test', capability: 'reasoning', template: 'Propose test cases for the implementation, including edge cases.\nTask: {prompt}' },
    { role: 'review', capability: 'reasoning', template: 'Review the implementation for correctness and suggest improvements.\nTask: {prompt}' },
  ],
  math: [
    { role: 'solve', capability: 'math', template: 'Solve the problem step by step and give the final answer.\nTask: {prompt}', topK: 2 },
    { role: 'verify', capability: 'reasoning', template: 'Verify the solution by checking the reasoning and calculations.\nTask: {prompt}' },
  ],
  reasoning: [
    { role: 'analyze', capability: 'reasoning', template: 'Analyze the question and lay out the key considerations.\nQuestion: {prompt}' },
    { role: 'conclude', capability: 'reasoning', template: 'Give the final answer with a concise explanation.\nQuestion: {prompt}', topK: 2 },
  ],
};

const RULE_PARALLEL: Record<Capability, boolean> = {
  coding: true,
  math: false,
  reasoning: true,
};

export interface Planner {
  decompose(task: Task): Promise<Decomposition>;
}

export class RuleBasedPlanner implements Planner {
  async decompose(task: Task): Promise<Decomposition> {
    const plan = RULE_PLAN[task.capability] ?? RULE_PLAN.reasoning;
    const subtasks: Subtask[] = plan.map((p, i) => ({
      id: `${task.id}-${i}`,
      parentId: task.id,
      order: i,
      role: p.role,
      capability: p.capability,
      prompt: p.template.replace('{prompt}', task.prompt),
      ...(p.topK ? { expertPolicy: { topK: p.topK } } : {}),
    }));
    return {
      task,
      subtasks,
      parallel: RULE_PARALLEL[task.capability] ?? false,
      rationale: `rule-based ${task.capability} decomposition (${subtasks.length} subtasks)`,
    };
  }
}

/** LLM 分解用プロンプト (EXP-0005B) */
export function llmDecomposePrompt(task: Task): string {
  return [
    'You are a planner. Break the following task into 2-4 concrete subtasks.',
    'Return one subtask per line, each prefixed with the required capability:',
    '[coding] | [math] | [reasoning]',
    '',
    `Task: ${task.prompt}`,
  ].join('\n');
}

/** LLM 出力 (行, [capability] 付き) を Subtask に変換 */
export function parseSubtasks(task: Task, lines: string[]): Subtask[] {
  const capOf = (s: string): Capability => {
    if (s.includes('coding')) return 'coding';
    if (s.includes('math')) return 'math';
    return 'reasoning';
  };
  return lines
    .map((line, i) => ({ line: line.trim(), i }))
    .filter(x => x.line.length > 0)
    .map((x, order) => ({
      id: `${task.id}-llm-${order}`,
      parentId: task.id,
      order,
      role: `subtask-${order + 1}`,
      capability: capOf(x.line),
      prompt: x.line.replace(/^\[(coding|math|reasoning)\]\s*/i, ''),
    }));
}

/** LLM Planner — フォーマット不適合時はルールへフォールバック */
export class LLMPlanner implements Planner {
  private readonly fallback = new RuleBasedPlanner();

  constructor(
    private readonly backend: ComputeBackend,
    private readonly nodeId: string,
  ) {}

  async decompose(task: Task): Promise<Decomposition> {
    if (!this.backend.generate) return this.fallback.decompose(task);
    try {
      const prompt = llmDecomposePrompt(task);
      const raw = await this.backend.generate(this.nodeId, prompt, 220);
      const lines = raw
        .split('\n')
        .map(l => l.trim())
        .filter(l => /^\[(coding|math|reasoning)\]/i.test(l));
      const subtasks = parseSubtasks(task, lines);
      if (subtasks.length === 0) return this.fallback.decompose(task);
      return {
        task,
        subtasks,
        parallel: task.capability === 'coding',
        rationale: `llm-planner(${this.nodeId}): ${subtasks.length} subtasks`,
      };
    } catch {
      return this.fallback.decompose(task);
    }
  }
}
