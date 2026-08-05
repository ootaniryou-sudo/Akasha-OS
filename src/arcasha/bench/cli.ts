/**
 * 'arcasha benchmark' CLI（Phase 4.1）— 全ベンチを一発実行しレポートを自動生成
 *
 *   npm run benchmark
 *
 *   出力:
 *     External Benchmarks（GSM8K/MATH500/HumanEval/MBPP/MMLU/LiveCodeBench）
 *     Long Context / Reasoning / Robot / Power / Temperature
 *     OS Overhead（Kernel/Scheduler/AVM/Executive/Attachment の資源内訳）
 *     reports/benchmark/report.{json,csv,md}
 */

import { runExternalBenchmarks, renderExternalBenchmarks } from './run.js';
import { allOverheadProfiles, renderOverhead } from './overhead.js';
import { writeReports, VALIDATION_KIND, VALIDATION_NOTE } from './report.js';
import { runRealDeviceBenchmark, renderRealDeviceBenchmark } from './real-device.js';
import { explainExecutive, renderExplanation } from '../attachments/explain.js';
import {
  runLongContextValidation,
  renderLongContextValidation,
  runReasoningBenchmark,
  renderReasoningBenchmark,
  runRobotValidation,
  renderRobotValidation,
} from '../attachments/scientific.js';
import { runModeValidation, renderModeValidation } from '../attachments/validation.js';

const DIVIDER = '='.repeat(60);

export async function main(reportDir = 'reports/benchmark'): Promise<void> {
  console.log(DIVIDER);
  console.log('ArcAsha Benchmark — Real Benchmark Suite (Phase 4.2)');
  console.log(DIVIDER);
  console.log(`Validation kind: ${VALIDATION_KIND}（${VALIDATION_NOTE}）`);

  // 1. External Benchmarks（Validation E — Simulation）
  const rows = runExternalBenchmarks();
  console.log('\n' + renderExternalBenchmarks(rows));

  // 2. Long Context
  console.log('\n' + renderLongContextValidation(runLongContextValidation()));

  // 3. Reasoning
  console.log('\n' + renderReasoningBenchmark(await runReasoningBenchmark()));

  // 4. Robot
  console.log('\n' + renderRobotValidation(runRobotValidation()));

  // 5. Power / Temperature
  console.log('\n' + renderModeValidation(await runModeValidation()));

  // 6. OS Overhead
  console.log('\n' + renderOverhead(allOverheadProfiles()));

  // 7. Decision Explanation（なぜ Executive はこの構成を選んだか）
  const booted = (await import('../ailsm/expert-runtime.js')).boot();
  console.log('\n' + renderExplanation(await explainExecutive('新しいアルゴリズムを考えて', booted, { mode: 'auto', budgetMs: 1000 })));

  // 8. Real Device Benchmark（実機実測 — Simulation と分離）
  console.log('\n' + renderRealDeviceBenchmark(await runRealDeviceBenchmark()));

  // 9. レポート生成
  const files = await writeReports(reportDir, rows, allOverheadProfiles());
  console.log('\n' + DIVIDER);
  console.log('Reports generated (kind=simulation):');
  for (const f of files) console.log(`  ${f}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
