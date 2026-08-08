/**
 * ArcAsha — Tree Search (Emergent Planning, FRAMEWORK §7)
 *
 * Planner は単一プランではなく複数プラン (Plan A/B/C ...) を生成し、
 * 信念ベースのコスト見積もりで枝刈り (Beam) → 各プランをシャドウ実行 →
 * Verifier でスコアリング → 最良プランを採用。
 *
 * さらに最良プランの「最も弱いサブタスク」を再帰的に展開 (子サブタスク生成) する
 * ことで、探索空間に深さを持たせる (Reasoning Tree)。
 *
 *   Task → generate N plans → estimate (belief, no LLM) → beam → execute → score
 *       → best → expand(weakest subtask) → re-execute → accept if improved
 *
 * 決定論 (T=0) と (node,prompt) キャッシュにより、プラン間で共有されるサブタスク
 * は再推論されない (再現性 + 効率)。
 */

import type { Capability, Decomposition, Subtask, Task } from '../core/types.js';
import type { BeliefSnapshot } from '../belief/bayesian.js';
import { planScore, type ArcAshaController, type RunResult } from '../controller/controller.js';
import type { LLMPlanner } from '../planner/llm_planner.js';
import { RuleBasedPlanner } from '../planner/decomposer.js';

type BeliefMap = Record<string, Record<Capability, BeliefSnapshot>>;

export interface PlanOutcome {
  plan: Decomposition;
  run: RunResult;
  score: number;
}

export interface TreeSearchResult {
  task: Task;
  best: PlanOutcome;
  alternatives: PlanOutcome[];
  beamEstimates: { plan: Decomposition; estimate: number }[];
}

/** 最弱サブタスク (最低スコアの決定) */
function weakestSubtask(run: RunResult): Subtask {
  return run.decisions.reduce((a, b) => (a.result.score < b.result.score ? a : b)).subtask;
}

/**
 * プラン生成器: 同一タスクから複数の分解バリアントを決定的に生成する。
 * バリアント (rationale):
 *   standard      — ルールベース標準分解
 *   deep          — 標準 + refactor サブタスク (より深い分解)
 *   committee     — 全サブタスク topK=2 (委員会形式)
 *   coarse        — 少ないサブタスクに集約
 *   llm           — LLM Planner による分解 (フォールバック付き)
 */
export class PlanGenerator {
  constructor(
    private readonly rule: RuleBasedPlanner,
    private readonly llm?: LLMPlanner,
  ) {}

  async generate(task: Task, n: number): Promise<Decomposition[]> {
    const plans: Decomposition[] = [];
    const push = (p: Decomposition): void => {
      if (!plans.some(x => x.rationale === p.rationale)) plans.push(p);
    };
    push(await this.rule.decompose(task));
    push(await this.deepVariant(task));
    push(await this.committeeVariant(task));
    push(await this.coarseVariant(task));
    if (this.llm) push(await this.llm.decompose(task));
    return plans.slice(0, n);
  }

  private async deepVariant(task: Task): Promise<Decomposition> {
    const base = await this.rule.decompose(task);
    const extra: Subtask = {
      id: `${task.id}-deep`,
      parentId: task.id,
      order: base.subtasks.length,
      role: 'refactor',
      capability: task.capability === 'coding' ? 'coding' : 'reasoning',
      prompt: `Review and refactor the solution for correctness and edge cases.\nTask: ${task.prompt}`,
    };
    return { task, subtasks: [...base.subtasks, extra], parallel: base.parallel, rationale: 'deep (+refactor)' };
  }

  private async committeeVariant(task: Task): Promise<Decomposition> {
    const base = await this.rule.decompose(task);
    const subtasks = base.subtasks.map(s => ({ ...s, expertPolicy: { topK: 2 } }));
    return { task, subtasks, parallel: base.parallel, rationale: 'committee (all topK=2)' };
  }

  private async coarseVariant(task: Task): Promise<Decomposition> {
    if (task.capability === 'coding') {
      const subtasks: Subtask[] = [
        {
          id: `${task.id}-c0`, parentId: task.id, order: 0, role: 'design+code', capability: 'coding',
          prompt: `Design and implement the solution in Python.\nTask: ${task.prompt}`, expertPolicy: { topK: 2 },
        },
        {
          id: `${task.id}-c1`, parentId: task.id, order: 1, role: 'test+review', capability: 'reasoning',
          prompt: `Propose test cases and review the implementation.\nTask: ${task.prompt}`,
        },
      ];
      return { task, subtasks, parallel: true, rationale: 'coarse (2 subtasks)' };
    }
    return this.rule.decompose(task); // math/reasoning は標準と同型 (dedup で除外)
  }

  /** 信念ベースのプラン事前評価 (LLM 不要): 平均の最高有効能力 − サブタスク数ペナルティ */
  estimate(beliefs: BeliefMap, plan: Decomposition): number {
    let sum = 0;
    for (const st of plan.subtasks) {
      let best = 0;
      for (const b of Object.values(beliefs)) best = Math.max(best, b[st.capability].effective);
      sum += best;
    }
    const avg = plan.subtasks.length > 0 ? sum / plan.subtasks.length : 0;
    return Math.round((avg - 0.05 * plan.subtasks.length) * 1000) / 1000;
  }

  /** 最弱サブタスクを 2 つの子サブタスクへ展開 (探索の深さ) */
  async expand(plan: Decomposition, subtask: Subtask): Promise<Decomposition> {
    const children: Subtask[] = [
      {
        id: `${subtask.id}-a`, parentId: subtask.parentId, order: subtask.order,
        role: `${subtask.role}:step1`, capability: subtask.capability,
        prompt: `Part 1 — ${subtask.prompt}`,
      },
      {
        id: `${subtask.id}-b`, parentId: subtask.parentId, order: subtask.order + 1,
        role: `${subtask.role}:step2`, capability: subtask.capability,
        prompt: `Part 2 — ${subtask.prompt}`, ...(subtask.expertPolicy ? { expertPolicy: subtask.expertPolicy } : {}),
      },
    ];
    const subtasks = plan.subtasks.flatMap(s => (s.id === subtask.id ? children : [s]));
    return { ...plan, subtasks, rationale: `${plan.rationale} → expand(${subtask.role})` };
  }
}

/**
 * Tree Search: generate → estimate → beam → execute → score → best → expand → accept-if-improved
 */
export class TreeSearch {
  constructor(
    private readonly ctrl: ArcAshaController,
    private readonly generator: PlanGenerator,
    private readonly candidates = 5,
    private readonly beam = 2,
    private readonly expandDepth = 1,
  ) {}

  async search(task: Task): Promise<TreeSearchResult> {
    const plans = await this.generator.generate(task, this.candidates);
    const beliefs = this.ctrl.beliefSnapshot();
    const beamEstimates = plans.map(plan => ({ plan, estimate: this.generator.estimate(beliefs, plan) }));
    beamEstimates.sort((a, b) => b.estimate - a.estimate);
    const beam = beamEstimates.slice(0, this.beam);

    // ビーム内の各プランをシャドウ実行 → Verifier スコアで選抜
    const outcomes: PlanOutcome[] = [];
    for (const { plan } of beam) {
      const run = await this.ctrl.executePlan(plan);
      outcomes.push({ plan, run, score: planScore(run) });
    }
    outcomes.sort((a, b) => b.score - a.score);
    let best = outcomes[0];

    // 深さ: 最良プランの最弱サブタスクを展開し、改善した場合のみ採用
    for (let depth = 0; depth < this.expandDepth; depth++) {
      const expandedPlan = await this.generator.expand(best.plan, weakestSubtask(best.run));
      const run = await this.ctrl.executePlan(expandedPlan);
      const score = planScore(run);
      if (score > best.score) {
        best = { plan: expandedPlan, run, score };
      } else {
        break; // 改善なし → 探索打ち切り
      }
    }

    return {
      task,
      best,
      alternatives: outcomes.filter(o => o !== best),
      beamEstimates,
    };
  }
}

