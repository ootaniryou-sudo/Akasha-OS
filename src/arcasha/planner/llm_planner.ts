/**
 * ArcAsha — LLM Planner (EXP-0005B)
 *
 * ルールベース分解をエキスパート (LLM) による分解へ置き換える。
 * Planner 自身もタスク実行の一部として学習対象になる (分解品質はタスクレベル
 * リグレットで測る。FRAMEWORK §7)。
 *
 * - エキスパートに分解プロンプトを投げ、`[coding] | [math] | [reasoning]` 付き行を
 *   サブタスクへ変換
 * - フォーマット不適合・エラー時は RuleBasedPlanner へフォールバック
 */

import type { Decomposition, Task } from '../core/types.js';
import type { ExpertHub } from '../experts/registry.js';
import { llmDecomposePrompt, parseSubtasks, RuleBasedPlanner, type Planner } from './decomposer.js';

export class LLMPlanner implements Planner {
  private readonly fallback = new RuleBasedPlanner();

  constructor(
    private readonly hub: ExpertHub,
    private readonly nodeId: string,
  ) {}

  async decompose(task: Task): Promise<Decomposition> {
    try {
      const prompt = llmDecomposePrompt(task);
      const raw = await this.hub.generate(this.nodeId, prompt, 220);
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
