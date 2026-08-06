#!/usr/bin/env node
/**
 * ArcAsha — Benchmark CLI (評価・比較実験)
 *
 * 3 エキスパート (Qwen3-0.6B / SmolLM2-360M / Gemma-3-1B) に接続し、
 * ArcAsha (LinUCB-Shadow) を UCB-Shadow / Fixed / Random / RoundRobin と公平に比較する。
 *
 * 起動:
 *   npx tsx src/arcasha/benchmark/run_benchmark.ts [--seeds N] [--port 8080]
 *   (先に run_node_hetero.py で 3 ノードを :8080 に接続しておく)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkRunner, defaultSpecs, formatBenchmarkTable } from './benchmark.js';
import { benchmarkTasks } from './tasks.js';
import { ExpertHub } from '../experts/registry.js';
import { Verifier } from '../verifier/verifier.js';
import type { Task } from '../core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadWarmup(): Task[] {
  const promptsPath = path.resolve(__dirname, '../../../experiments/qwen3_0.6b/EXP-0003/prompts.jsonl');
  const lines = fs.readFileSync(promptsPath, 'utf8').split('\n').filter(Boolean);
  return lines.map((l, i) => {
    const m = JSON.parse(l);
    return { id: `train-${i}`, capability: m.capability as Task['capability'], prompt: m.prompt };
  });
}

function argInt(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? parseInt(process.argv[i + 1] ?? String(def), 10) : def;
}

async function main(): Promise<void> {
  const seeds = argInt('--seeds', 3);
  const port = argInt('--port', 8080);

  console.log('═'.repeat(64));
  console.log('  ArcAsha Benchmark — 手法比較 (LinUCB-Shadow vs baselines)');
  console.log('═'.repeat(64));

  const warmup = loadWarmup();
  const evalTasks = benchmarkTasks();
  console.log(`\n  📚 warmup: ${warmup.length} tasks | eval (held-out): ${evalTasks.length} tasks | seeds: ${seeds}`);

  const hub = new ExpertHub();
  await new Promise<void>(resolve => hub.start(port, 3, resolve));

  console.log('\n  🧠 experts:');
  for (const e of hub.experts) console.log(`     - ${e.nodeId}  (${e.modelId}, ${e.paramsM}M)`);

  const runner = new BenchmarkRunner(new Verifier(0.4));
  const reports = [];
  const t0 = Date.now();

  for (let s = 0; s < seeds; s++) {
    const report = await runner.run(hub, warmup, evalTasks, s, defaultSpecs());
    reports.push(report);
    console.log(`\n${formatBenchmarkTable(report)}`);
  }

  // 平均 (複数シード)
  if (seeds > 1) {
    const names = defaultSpecs().map(s => s.name);
    console.log('\n  📊 mean over seeds:');
    console.log('| 手法 | meanScore | passRate | cumRegret |');
    console.log('|---|---|---|---|');
    for (const name of names) {
      const rs = reports.map(r => r.results.find(x => x.controller === name)!);
      const mean = (k: 'meanScore' | 'passRate' | 'cumulativeRegret') => rs.reduce((a, x) => a + x[k], 0) / rs.length;
      console.log(`| ${name} | ${mean('meanScore').toFixed(3)} | ${mean('passRate').toFixed(3)} | ${mean('cumulativeRegret').toFixed(3)} |`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  ⏱  benchmark done in ${elapsed}s  (cache miss=${hub.cacheMiss} hit=${hub.cacheHit})`);

  // レポート保存
  const outDir = path.resolve(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const md = reports.map(r => formatBenchmarkTable(r)).join('\n');
  const summary = `# ArcAsha Benchmark Report\n\n- date: ${new Date().toISOString()}\n- experts: ${hub.experts.map(e => e.modelId).join(', ')}\n- seeds: ${seeds}\n- warmup: ${warmup.length} | eval: ${evalTasks.length}\n\n${md}\n`;
  fs.writeFileSync(path.join(outDir, `benchmark_${new Date().toISOString().slice(0, 10)}.md`), summary);
  fs.writeFileSync(path.join(outDir, 'benchmark_latest.md'), summary);
  console.log(`  💾 report saved to src/arcasha/benchmark/reports/benchmark_latest.md`);

  hub.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌ benchmark failed:', err);
  process.exit(1);
});
