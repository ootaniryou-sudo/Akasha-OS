/**
 * ArcAsha — Planner / Task Decomposition (EXP-0005A)
 *
 * タスクをサブタスクに分解する。ルールベース (v0.1) と LLM ベース (hook) を提供。
 * 分解結果は「その場で生成されるポリシー」= Emergent Controller の入力。
 */

import type { Capability, Decomposition, Subtask, Task } from '../core/types.js';

/** ルールベース分解: タスク能力に応じたサブタスクロール列 (topK = EXP-0005C の動的割当) */
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

/** サブタスクを並列実行するか (EXP-0005C: 並列 vs 逐次) */
const RULE_PARALLEL: Record<Capability, boolean> = {
  coding: true,   // design/code/test/review は自己完結プロンプトなので並列可
  math: false,    // solve → verify は依存
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

/** LLM ベース分解のためのプロンプト生成 (EXP-0005B 拡張用) */
export function llmDecomposePrompt(task: Task): string {
  return [
    `You are a planner. Break the following task into 2-4 concrete subtasks.`,
    `Return one subtask per line, each prefixed with the required capability:`,
    `[coding] | [math] | [reasoning]`,
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
