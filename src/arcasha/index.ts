#!/usr/bin/env node
/**
 * ArcAsha v0.1 — Demo CLI
 *
 * エキスパート 3 台 (Qwen3-0.6B / SmolLM2-360M / Gemma-3-1B) に接続し、
 * 検証済みパイプライン (LinUCB-Shadow) を事前学習してから、
 * 複合タスクを Planner → Router → Verifier → Memory で実行する。
 *
 * 起動:
 *   npx tsx src/arcasha/index.ts
 *   (先に run_node_hetero.py で 3 ノードを :8080 に接続しておく)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArcAshaController } from './controller/controller.js';
import type { Capability, Task } from './core/types.js';
import { ExpertHub } from './experts/registry.js';
import { EpisodeMemory } from './memory/memory.js';
import { RuleBasedPlanner } from './planner/decomposer.js';
import { FixedRouter, LinUCBShadowRouter, UCBShadowRouter } from './router/router.js';
import { Verifier } from './verifier/verifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadTasks(): Task[] {
  const promptsPath = path.resolve(
    __dirname, '../../experiments/qwen3_0.6b/EXP-0003/prompts.jsonl',
  );
  const lines = fs.readFileSync(promptsPath, 'utf8').split('\n').filter(Boolean);
  return lines.map((l, i) => {
    const m = JSON.parse(l);
    return { id: `train-${i}`, capability: m.capability as Capability, prompt: m.prompt };
  });
}

function line(label: string, text: string): void {
  console.log(`\n  ${label}\n  ${'-'.repeat(60)}\n${text.split('\n').map(x => `  ${x}`).join('\n')}`);
}

async function main(): Promise<void> {
  console.log('═'.repeat(64));
  console.log('  ArcAsha v0.1 — Observation-Driven Controller (Phase 5)');
  console.log('═'.repeat(64));

  const tasks = loadTasks();
  console.log(`\n  📚 training tasks: ${tasks.length} (EXP-0003 prompts.jsonl)`);

  const hub = new ExpertHub();
  const port = 8080;
  const minNodes = 3;

  await new Promise<void>((resolve) => {
    hub.start(port, minNodes, resolve);
  });

  console.log('\n  🧠 experts registered:');
  for (const e of hub.experts) {
    console.log(`     - ${e.nodeId}  (${e.modelId}, ${e.paramsM}M params)`);
  }

  // ── 3 コントローラ (同一ハブ, 独立した状態/ポリシー) ──────────────
  const planner = new RuleBasedPlanner();
  const verifier = new Verifier(0.4);
  const lin = new ArcAshaController(hub, new LinUCBShadowRouter(hub.experts), planner, verifier, new EpisodeMemory());
  const ucb = new ArcAshaController(hub, new UCBShadowRouter(hub.experts), planner, verifier, new EpisodeMemory());
  const fixed = new ArcAshaController(hub, new FixedRouter(hub.experts), planner, verifier, new EpisodeMemory());

  // ── Phase 1: シャドウ学習 (決定論出力キャッシュで高速) ─────────────
  // 直列実行: 1 コントローラ目が 72 回の LLM 呼び出しをし、2・3 コントローラ目はキャッシュヒット
  console.log('\n  🎓 warmup (shadow learning, sequential for cache) ...');
  const t0 = Date.now();
  await lin.warmup(tasks);
  await ucb.warmup(tasks);
  await fixed.warmup(tasks);
  const warmupMs = Date.now() - t0;
  console.log(`     done in ${(warmupMs / 1000).toFixed(1)}s  (cache miss=${hub.cacheMiss} hit=${hub.cacheHit})`);
  console.log(`     cumulative regret: LinUCB-Shadow=${lin.totalCumulativeRegret().toFixed(3)}  UCB-Shadow=${ucb.totalCumulativeRegret().toFixed(3)}  Fixed=${fixed.totalCumulativeRegret().toFixed(3)}`);

  // ── Phase 2: 実タスク実行 (Planner → Router → Verifier → Memory) ──
  const demoTasks: Task[] = [
    { id: 'demo-web', capability: 'coding', prompt: 'Write a Python web scraper that fetches a webpage and extracts all links (href) from the HTML.' },
    { id: 'demo-train', capability: 'math', prompt: 'A train travels 60 km in 45 minutes. What is its average speed in km/h? Show your work.' },
    { id: 'demo-feather', capability: 'reasoning', prompt: 'Which weighs more: a kilogram of feathers or a kilogram of iron? Explain your reasoning.' },
  ];

  for (const task of demoTasks) {
    console.log(`\n  🚀 TASK [${task.id}] (${task.capability}): ${task.prompt}`);
    const run = await lin.execute(task);
    console.log(`     planner: ${run.decomposition.rationale}`);
    for (const d of run.decisions) {
      const v = run.verifications.find(x => x.subtask.id === d.subtask.id);
      console.log(`       [${d.subtask.order}] ${d.subtask.role.padEnd(9)} -> ${d.nodeId}  (score=${d.result.score.toFixed(3)}, regret=${d.regret.toFixed(3)}, ${v?.passed ? 'PASS' : 'FAIL'})`);
    }
    line('INTEGRATED RESULT', run.integrated);
    console.log(`     → episode #${run.episodeId} saved to memory`);
  }

  // ── Phase 3: 学習済み重みの可視化 ────────────────────────────────
  console.log('\n  📊 learned LinUCB weights (mean across experts):');
  const w = lin.weights();
  if (w) {
    const names = ['bias', 'capability', 'latency', 'cost', 'stability', 'confidence', 'memory', 'temperature'];
    const nodeIds = Object.keys(w);
    const mean = names.map((_, i) => nodeIds.reduce((s, id) => s + w[id][i], 0) / nodeIds.length);
    names.forEach((n, i) => console.log(`     ${n.padEnd(12)} ${mean[i].toFixed(3)}`));
  }

  console.log('\n  🧠 belief snapshot (LinUCB-Shadow):');
  const snap = lin.beliefSnapshot();
  for (const [nodeId, caps] of Object.entries(snap)) {
    console.log(`     ${nodeId}: coding μ=${caps.coding.mu} (n=${caps.coding.n})  math μ=${caps.math.mu} (n=${caps.math.n})  reasoning μ=${caps.reasoning.mu} (n=${caps.reasoning.n})`);
  }

  hub.close();
  console.log('\n  ✅ ArcAsha v0.1 demo complete. hub closed.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ demo failed:', err);
  process.exit(1);
});
