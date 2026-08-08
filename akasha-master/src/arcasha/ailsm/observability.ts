/**
 * AI Observability（Phase 0.23）— aiperf / AI Trace / AI Profiler / AI Benchmark 統合
 *
 * 「OS を増やすより計測器を増やす」— Compiler → Optimizer → Runtime → Memory に加え、
 * Perf / Profiler / Trace / Benchmark を一体化した観測デモ。
 */

import { run } from './runtime.js';
import { AiPerf } from './perf.js';
import type { PerfSnapshot } from './perf.js';
import { buildRuntimeTrace, buildSchedulerTrace, renderTimeline } from './trace.js';
import type { TraceEvent } from './trace.js';
import { AiProfiler } from './profiler.js';
import type { ProfileResult } from './profiler.js';
import { ContextTlb } from './context-tlb.js';
import { TierManager } from './tier.js';
import { defaultQuestions, runLongContextBenchmark } from './benchmark.js';
import type { BenchResult } from './benchmark.js';

export interface ObservabilityDemoResult {
  perf: PerfSnapshot;
  perfText: string;
  chromeTrace: string;
  traceEventCount: number;
  timeline: string;
  profile: ProfileResult;
  profileText: string;
  benchmark: BenchResult;
  benchmarkText: string;
  headline: {
    totalTokens: number;
    loadedTokens: number;
    tokenReduction: number;
    speedup: number;
    faultRate: number;
    tlbHitRate: number;
  };
}

/**
 * 統合デモ:
 *   1. ランタイム実行（積分）→ Runtime/Scheduler Timeline → Chrome Trace
 *   2. Long Context ベンチマーク → aiperf / profiler で計測
 *   3. 見出し（token 削減率・speedup・fault rate・TLB hit）
 */
export function runObservabilityDemo(): ObservabilityDemoResult {
  const perf = new AiPerf();
  const profiler = new AiProfiler();
  const tlb = new ContextTlb();
  const tier = new TierManager();
  perf.attach(tlb, tier);

  // 1. ランタイム実行のタイムライン（compileAndRun + run）
  const runtime = run('x^2を積分して');
  const runtimeTrace = buildRuntimeTrace(runtime.steps);
  const schedulerTrace = buildSchedulerTrace(runtime.events);
  const allEvents: TraceEvent[] = [...runtimeTrace, ...schedulerTrace];
  const chromeTrace = JSON.stringify({ traceEvents: allEvents }, null, 2);

  // ランタイムで Expert に委譲された CALL を記録（EXPERT_META の latancy を利用）
  const callStep = runtime.steps.find((s) => s.kind === 'call');
  if (callStep) {
    const ms = 18; // math の推論時間（決定論）
    perf.beginCall('math', ms);
    profiler.recordExpert('math', ms);
  }

  // 2. Long Context ベンチマーク（計測器を共有）
  const benchmark = runLongContextBenchmark(defaultQuestions(), 200, 64, { perf, profiler, tlb, tier });

  return {
    perf: perf.snapshot(),
    perfText: perf.render(),
    chromeTrace,
    traceEventCount: allEvents.length,
    timeline: renderTimeline(runtimeTrace),
    profile: profiler.profile(),
    profileText: profiler.render(),
    benchmark,
    benchmarkText: renderBenchmarkText(benchmark),
    headline: {
      totalTokens: benchmark.totals.totalTokens,
      loadedTokens: benchmark.totals.loadedTokens,
      tokenReduction: benchmark.totals.tokenReduction,
      speedup: benchmark.totals.speedup,
      faultRate: perf.faultRate(),
      tlbHitRate: tlb.hitRate(),
    },
  };
}

function renderBenchmarkText(b: BenchResult): string {
  const t = b.totals;
  const lines: string[] = ['=== Long Context Benchmark ==='];
  lines.push(`Total Tokens   : ${t.totalTokens} / loaded ${t.loadedTokens}`);
  lines.push(`Token Reduction: ${(t.tokenReduction * 100).toFixed(1)}%`);
  lines.push(`Avg Loaded Page: ${t.avgLoadedPages.toFixed(1)} / ${b.pageCount}`);
  lines.push(`Context Fault  : ${(t.totalFaultRate * 100).toFixed(1)}%`);
  lines.push(`TLB Hit Rate   : ${(t.tlbHitRate * 100).toFixed(1)}%`);
  lines.push(`Speedup        : ${t.speedup.toFixed(2)}x`);
  return lines.join('\n');
}

