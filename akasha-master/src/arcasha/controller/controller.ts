/**
 * ArcAsha — Emergent Controller (EXP-0005F)
 *
 * Task → Planner → Subtasks → Router (LinUCB-Shadow) → Experts → Verifier → Memory → Integrator
 * の一貫した「思考ループ」。ポリシーは固定テーブルではなく、タスクごとに Planner が
 * その場で生成する (Emergent Policy)。
 *
 * 内部エンジン (検証済みパイプライン):
 *   Observation → State Estimation → Belief → Confidence → Feature Vector
 *   → LinUCB-Shadow Router → Shadow Feedback
 */

import { BayesianBelief, EmaLatency } from '../belief/bayesian.js';
import { computeRewards, findOracle } from '../core/observation.js';
import type {
  Capability, Decomposition, EvalResult, ExpertInfo, NodeState,
  StepContext, Subtask, Task,
} from '../core/types.js';
import type { ExpertHub } from '../experts/registry.js';
import type { EpisodeMemory } from '../memory/memory.js';
import type { Planner } from '../planner/decomposer.js';
import { Reflector, type Reflection } from '../reflect/reflector.js';
import type { Router } from '../router/router.js';
import { evaluateAll, type Injection } from '../shadow/shadow.js';
import type { Verifier, Verification } from '../verifier/verifier.js';

const CAPS: Capability[] = ['coding', 'math', 'reasoning'];

/** 実行結果の計画スコア: サブタスク検証スコアの平均 (Tree Search / Reflection 共通) */
export function planScore(run: RunResult): number {
  if (run.decisions.length === 0) return 0;
  const s = run.decisions.reduce((acc, d) => acc + d.result.score, 0) / run.decisions.length;
  return Math.round(s * 1000) / 1000;
}

export interface Decision {
  subtask: Subtask;
  nodeId: string;
  oracle: string;
  result: EvalResult;
  regret: number;
  /** EXP-0005C: topK でコミットしたが選ばれなかった参照エキスパート */
  consulted: string[];
}

export interface RunResult {
  task: Task;
  decomposition: Decomposition;
  decisions: Decision[];
  verifications: Verification[];
  integrated: string;
  episodeId: number;
  totalRegret: number;
}

export interface ReflectiveIteration {
  iteration: number;
  reflections: Reflection[];
  nextPlan: Decomposition;
  nextRun: RunResult;
}

export interface ReflectiveRun {
  task: Task;
  initialRun: RunResult;
  finalPlan: Decomposition;
  finalRun: RunResult;
  iterations: ReflectiveIteration[];
}

export class ArcAshaController {
  private states: Record<string, NodeState> = {};
  private beliefs: Record<string, Record<Capability, BayesianBelief>> = {};
  private latencies: Record<string, EmaLatency> = {};
  private stepCounter = 0;
  private totalRegret = 0;
  public name: string;

  constructor(
    private readonly hub: ExpertHub,
    private readonly router: Router,
    private readonly planner: Planner,
    private readonly verifier: Verifier,
    private readonly memory: EpisodeMemory,
  ) {
    this.name = router.name;
  }

  private ensureStates(): void {
    for (const e of this.hub.experts) {
      if (this.states[e.nodeId]) continue;
      this.beliefs[e.nodeId] = {
        coding: new BayesianBelief(),
        math: new BayesianBelief(),
        reasoning: new BayesianBelief(),
      };
      this.latencies[e.nodeId] = new EmaLatency();
      const cap: NodeState['capability'] = {} as NodeState['capability'];
      for (const c of CAPS) cap[c] = this.beliefs[e.nodeId][c].snapshot();
      this.states[e.nodeId] = { capability: cap, latencyMs: 0, stability: 1.0 };
    }
  }

  /** シャドウ評価: 全エキスパートを評価し、状態 (信念/レイテンシ) を更新 */
  private async shadowStep(task: Task, inject?: Injection | null): Promise<{
    results: Record<string, EvalResult>;
    oracle: string;
    rewards: Record<string, number>;
  }> {
    this.ensureStates();
    const results = await evaluateAll(
      this.hub.experts,
      task,
      (n, t) => this.hub.compute(n, t),
      inject ?? null,
    );
    for (const e of this.hub.experts) {
      const r = results[e.nodeId];
      this.beliefs[e.nodeId][task.capability].update(r.score);
      this.latencies[e.nodeId].observe(r.latencyMs);
      this.states[e.nodeId].latencyMs = r.latencyMs; // 注入後レイテンシ (特徴量用)
      this.states[e.nodeId].capability[task.capability] = this.beliefs[e.nodeId][task.capability].snapshot();
    }
    const maxLat = Math.max(...this.hub.experts.map(e => this.states[e.nodeId].latencyMs), 1);
    const maxParams = Math.max(...this.hub.experts.map(e => e.paramsM), 1);
    const rewards = computeRewards(this.hub.experts, results, this.states, maxLat, maxParams);
    const oracle = findOracle(results);
    return { results, oracle, rewards };
  }

  /** 1 サブタスク: シャドウ評価 → 選択 → 観測更新 (Full Information) */
  async routeStep(subtask: Subtask, inject?: Injection | null): Promise<Decision> {
    const { results, oracle, rewards } = await this.shadowStep(subtask, inject);
    this.stepCounter += 1;
    const ctx: StepContext = {
      task: subtask,
      states: this.states,
      rewards,
      order: this.hub.experts.map(e => e.nodeId),
      step: this.stepCounter,
    };

    // EXP-0005C Dynamic Expert Assignment / Self Reflection:
    //   force — 信念診断による強制ルーティング
    //   topK>1 — UCB スコア上位 K をコミットし、その中で最高品質を採用 (committee)
    const force = subtask.expertPolicy?.force;
    const topK = subtask.expertPolicy?.topK ?? 1;
    let decision: string;
    let consulted: string[] = [];
    if (force && results[force]) {
      decision = force;
    } else if (topK > 1) {
      const scores = this.router.scores(ctx);
      const ranked = [...this.hub.experts].map(e => e.nodeId).sort((a, b) => scores[b] - scores[a]);
      const top = ranked.slice(0, Math.min(topK, ranked.length));
      decision = [...top].sort((a, b) => results[b].score - results[a].score)[0];
      consulted = top.filter(n => n !== decision);
    } else {
      decision = this.router.select(ctx);
    }

    this.router.observe(ctx);
    const regret = Math.max(0, results[oracle].score - results[decision].score);
    this.totalRegret += regret;
    return { subtask, nodeId: decision, oracle, result: results[decision], regret, consulted };
  }

  /** タスク実行: 分解 → 各サブタスクをルーティング → 検証 → 統合 → 記憶 */
  async execute(
    task: Task,
    opts?: { inject?: Injection | null; planner?: Planner },
  ): Promise<RunResult> {
    const planner = opts?.planner ?? this.planner;
    const decomposition = await planner.decompose(task);
    return this.executePlan(decomposition, { inject: opts?.inject ?? null, task });
  }

  /** 与えられた分解をそのまま実行 (Tree Search / プラン比較用) */
  async executePlan(
    decomposition: Decomposition,
    opts?: { inject?: Injection | null; task?: Task },
  ): Promise<RunResult> {
    const task = opts?.task ?? decomposition.task;
    const decisions: Decision[] = [];
    const verifications: Verification[] = [];
    const subResults: Record<string, EvalResult> = {};

    const runOne = async (st: Subtask): Promise<void> => {
      const d = await this.routeStep(st, opts?.inject ?? null);
      decisions.push(d);
      verifications.push(this.verifier.verify(st, d.result));
      subResults[st.id] = d.result;
    };

    // EXP-0005C: 並列 vs 逐次 (分解結果が parallel なら Promise.all)
    if (decomposition.parallel) {
      await Promise.all(decomposition.subtasks.map(runOne));
    } else {
      for (const st of decomposition.subtasks) await runOne(st);
    }

    const integrated = this.verifier.integrate(decomposition.subtasks, subResults);
    const episodeId = this.memory.record({
      task,
      decisions: decisions.map(d => ({
        subtaskId: d.subtask.id, nodeId: d.nodeId, score: d.result.score, capability: d.subtask.capability,
      })),
      integrated,
    });
    return { task, decomposition, decisions, verifications, integrated, episodeId, totalRegret: this.totalRegret };
  }

  /**
   * Long-term Memory → 事前信念 μ₀ (Closed Bayesian Loop)
   * 類似エピソードの決定を集計し、新タスクの信念を μ₀/n₀ で初期化する。
   * その後 Observation (Shadow) が μ へ更新する:  μ₀ → Observation → μ → Memory → μ₀'
   */
  seedBeliefsFromMemory(task: Task, k = 3): void {
    this.ensureStates();
    const prior = this.memory.priorFor(task, k);
    for (const [nodeId, caps] of Object.entries(prior)) {
      if (!this.beliefs[nodeId]) continue;
      for (const [cap, p] of Object.entries(caps)) {
        if (!p) continue;
        const c = cap as Capability;
        this.beliefs[nodeId][c] = new BayesianBelief({ mu: p.mu, n: p.n });
        this.states[nodeId].capability[c] = this.beliefs[nodeId][c].snapshot();
      }
    }
  }

  /**
   * Self Reflection (Belief-Driven Self-Improvement):
   *   Verifier が失敗を検出 → Reflector が Belief (μ, n) から原因診断 →
   *   Planner が次プラン生成 (re-route / committee / re-decompose) →
   *   再実行 → 合格数 or スコアが改善した場合のみ採用
   */
  async executeReflective(
    task: Task,
    opts?: { maxIter?: number; planner?: Planner },
  ): Promise<ReflectiveRun> {
    const planner = opts?.planner ?? this.planner;
    const maxIter = opts?.maxIter ?? 2;
    const reflector = new Reflector(() => this.beliefSnapshot());
    let plan = await planner.decompose(task);
    const initialRun = await this.executePlan(plan);
    let run = initialRun;
    const iterations: ReflectiveIteration[] = [];

    for (let i = 0; i < maxIter; i++) {
      const reflections = reflector.reflect(run);
      if (reflections.length === 0) break;
      const nextPlan = reflector.remedyPlan(run, plan);
      if (!nextPlan) break;
      const nextRun = await this.executePlan(nextPlan);
      iterations.push({ iteration: i, reflections, nextPlan, nextRun });
      const passBefore = run.verifications.filter(v => v.passed).length;
      const passAfter = nextRun.verifications.filter(v => v.passed).length;
      if (passAfter > passBefore || (passAfter === passBefore && planScore(nextRun) > planScore(run))) {
        plan = nextPlan;
        run = nextRun;
      } else {
        break; // 改善なし → 探索打ち切り
      }
    }
    return { task, initialRun, finalPlan: plan, finalRun: run, iterations };
  }

  /** 学習タスク: 分解なしでシャドウ学習だけ回す (Router の事前学習) */
  async warmup(tasks: Task[], shuffleSeed = 42): Promise<void> {
    const order = [...tasks].map((t, i) => ({ t, i }))
      .sort((a, b) => ((a.i * 7919 + shuffleSeed) % 1000) - ((b.i * 7919 + shuffleSeed) % 1000));
    for (const { t } of order) {
      const st: Subtask = { ...t, parentId: t.id, order: 0, role: 'leaf' };
      await this.routeStep(st);
    }
  }

  /** 学習済み重み (LinUCB のみ) */
  weights(): Record<string, number[]> | null {
    return this.router.learnedWeights();
  }

  /** ベイズ信念のスナップショット (可視化用) */
  beliefSnapshot(): Record<string, Record<Capability, NodeState['capability'][Capability]>> {
    this.ensureStates();
    const out: Record<string, Record<Capability, NodeState['capability'][Capability]>> = {};
    for (const e of this.hub.experts as ExpertInfo[]) {
      out[e.nodeId] = this.states[e.nodeId].capability;
    }
    return out;
  }

  totalCumulativeRegret(): number {
    return this.totalRegret;
  }
}

