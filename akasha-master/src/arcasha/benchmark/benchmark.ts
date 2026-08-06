/**
 * ArcAsha — Benchmark Runner (評価・比較実験基盤)
 *
 * 同一ハブ (決定論キャッシュ共有) 上で複数コントローラを公平に比較する:
 *   - ArcAsha  (LinUCB-Shadow) — 提案手法
 *   - UCB-Shadow                 — シャドウ + 素朴探索 (0003C.3)
 *   - Fixed (手設計合成)          — 0002E 系 baseline
 *   - Random / RoundRobin        — 非学習 baseline
 *
 * 指標: meanScore (検証スコア), passRate, cumulativeRegret (Oracle 品質 − 選択品質),
 *       meanLatencyMs, meanCost (EstimatedCost proxy)。
 * シード = ワークロード乱数化 (評価タスク順 + 初期アーム順)。決定論出力のため
 * 全コントローラが (node,prompt) キャッシュを共有し、最初のコントローラのみ LLM を呼ぶ。
 */

import type { Task } from '../core/types.js';
import { ArcAshaController, planScore } from '../controller/controller.js';
import type { ExpertHub } from '../experts/registry.js';
import { EpisodeMemory } from '../memory/memory.js';
import { RuleBasedPlanner } from '../planner/decomposer.js';
import {
  FixedRouter, LinUCBShadowRouter, RandomRouter, RoundRobinRouter, UCBShadowRouter,
} from '../router/router.js';
import type { Verifier } from '../verifier/verifier.js';

export interface ControllerSpec {
  name: string;
  make: (hub: ExpertHub, verifier: Verifier) => ArcAshaController;
}

export interface BenchmarkResult {
  controller: string;
  meanScore: number;
  passRate: number;
  cumulativeRegret: number;
  meanLatencyMs: number;
  meanCost: number;
}

export interface BenchmarkReport {
  seed: number;
  results: BenchmarkResult[];
  ranking: string[]; // 降順 (meanScore)
  config: { warmupN: number; evalN: number };
}

/** 標準コントローラ仕様 (評価用) */
export function defaultSpecs(): ControllerSpec[] {
  return [
    { name: 'LinUCB-Shadow (ArcAsha)', make: (hub, v) => new ArcAshaController(hub, new LinUCBShadowRouter(hub.experts), new RuleBasedPlanner(), v, new EpisodeMemory()) },
    { name: 'UCB-Shadow', make: (hub, v) => new ArcAshaController(hub, new UCBShadowRouter(hub.experts), new RuleBasedPlanner(), v, new EpisodeMemory()) },
    { name: 'Fixed', make: (hub, v) => new ArcAshaController(hub, new FixedRouter(hub.experts), new RuleBasedPlanner(), v, new EpisodeMemory()) },
    { name: 'Random', make: (hub, v) => new ArcAshaController(hub, new RandomRouter(hub.experts, 7), new RuleBasedPlanner(), v, new EpisodeMemory()) },
    { name: 'RoundRobin', make: (hub, v) => new ArcAshaController(hub, new RoundRobinRouter(hub.experts), new RuleBasedPlanner(), v, new EpisodeMemory()) },
  ];
}

export class BenchmarkRunner {
  constructor(private readonly verifier: Verifier) {}

  /** 1 シード分の比較 (ウォームアップ → 評価) を実行 */
  async run(hub: ExpertHub, warmup: Task[], evalTasks: Task[], seed: number, specs: ControllerSpec[] = defaultSpecs()): Promise<BenchmarkReport> {
    // 評価タスク順をシードで乱数化
    const order = [...evalTasks]
      .map((t, i) => ({ t, r: (i * 7919 + seed) % 1000 }))
      .sort((a, b) => a.r - b.r)
      .map(x => x.t);

    const controllers = specs.map(s => ({ name: s.name, ctrl: s.make(hub, this.verifier) }));

    // ウォームアップ (直列: 1 コントローラ目だけ LLM、以降キャッシュヒット)
    for (const { ctrl } of controllers) await ctrl.warmup(warmup, seed);

    const results: BenchmarkResult[] = [];
    for (const { name, ctrl } of controllers) {
      let totalScore = 0;
      let pass = 0;
      let regret = 0;
      let lat = 0;
      for (const t of order) {
        const run = await ctrl.execute(t);
        totalScore += planScore(run);
        const v = run.verifications;
        pass += v.length > 0 ? v.filter(x => x.passed).length / v.length : 0;
        regret += run.decisions.reduce((s, d) => s + d.regret, 0);
        lat += run.decisions.length > 0
          ? run.decisions.reduce((s, d) => s + d.result.latencyMs, 0) / run.decisions.length
          : 0;
      }
      const n = order.length;
      results.push({
        controller: name,
        meanScore: Math.round((totalScore / n) * 1000) / 1000,
        passRate: Math.round((pass / n) * 1000) / 1000,
        cumulativeRegret: Math.round(regret * 1000) / 1000,
        meanLatencyMs: Math.round(lat / n),
        meanCost: 0, // EstimatedCost は node 別に算出 (デモでは省略)
      });
    }

    results.sort((a, b) => b.meanScore - a.meanScore);
    return {
      seed,
      results,
      ranking: results.map(r => r.controller),
      config: { warmupN: warmup.length, evalN: order.length },
    };
  }
}

/** レポートを Markdown 表にする (論文用) */
export function formatBenchmarkTable(report: BenchmarkReport): string {
  const head = `| 手法 | meanScore | passRate | cumRegret | lat(ms) |`;
  const sep = `|---|---|---|---|---|`;
  const rows = report.results.map(r =>
    `| ${r.controller} | ${r.meanScore.toFixed(3)} | ${r.passRate.toFixed(3)} | ${r.cumulativeRegret.toFixed(3)} | ${r.meanLatencyMs} |`,
  );
  return `#### seed=${report.seed} (warmup=${report.config.warmupN}, eval=${report.config.evalN})\n\n${head}\n${sep}\n${rows.join('\n')}\n`;
}
