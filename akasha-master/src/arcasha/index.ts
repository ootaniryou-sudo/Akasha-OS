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
import { ArcAshaController, planScore } from './controller/controller.js';
import type { Capability, Task } from './core/types.js';
import { ExpertHub } from './experts/registry.js';
import { EpisodeMemory } from './memory/memory.js';
import { LLMPlanner } from './planner/llm_planner.js';
import { RuleBasedPlanner } from './planner/decomposer.js';
import { FixedRouter, LinUCBShadowRouter, UCBShadowRouter } from './router/router.js';
import { PlanGenerator, TreeSearch } from './search/tree.js';
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
  const mem = new EpisodeMemory(); // Lin と共有 (Vector Memory 参照用)
  const lin = new ArcAshaController(hub, new LinUCBShadowRouter(hub.experts), planner, verifier, mem);
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
  const llmPlanner = new LLMPlanner(hub, 'node-qwen');
  const demoTasks: { task: Task; planner?: typeof llmPlanner }[] = [
    { task: { id: 'demo-web', capability: 'coding', prompt: 'Write a Python web scraper that fetches a webpage and extracts all links (href) from the HTML.' } },
    { task: { id: 'demo-train', capability: 'math', prompt: 'A train travels 60 km in 45 minutes. What is its average speed in km/h? Show your work.' } },
  ];

  for (const { task, planner: taskPlanner } of demoTasks) {
    console.log(`\n  🚀 TASK [${task.id}] (${task.capability}): ${task.prompt}`);
    const run = await lin.execute(task, { planner: taskPlanner });
    console.log(`     planner: ${run.decomposition.rationale}  (parallel=${run.decomposition.parallel ?? false})`);
    for (const d of run.decisions) {
      const v = run.verifications.find(x => x.subtask.id === d.subtask.id);
      const topk = d.subtask.expertPolicy?.topK ? ` topK=${d.subtask.expertPolicy.topK}` : '';
      const consulted = d.consulted.length > 0 ? ` (consulted: ${d.consulted.join(', ')})` : '';
      console.log(`       [${d.subtask.order}] ${d.subtask.role.padEnd(9)} -> ${d.nodeId}${topk}${consulted}  (score=${d.result.score.toFixed(3)}, regret=${d.regret.toFixed(3)}, ${v?.passed ? 'PASS' : 'FAIL'})`);
    }
    line('INTEGRATED RESULT', run.integrated);
    console.log(`     → episode #${run.episodeId} saved to memory`);
  }

  // ── Phase 2.5: Tree Search (Plan A/B/C → Beam → Verifier → Best Plan) ──
  const featherTask: Task = {
    id: 'demo-feather', capability: 'reasoning',
    prompt: 'Which weighs more: a kilogram of feathers or a kilogram of iron? Explain your reasoning.',
  };
  console.log('\n  🌳 Tree Search: 5 plans → beam=2 → expand(weakest)');
  const generator = new PlanGenerator(new RuleBasedPlanner(), llmPlanner);
  const search = new TreeSearch(lin, generator, 5, 2, 1);
  const ts = await search.search(featherTask);
  console.log('     generated plans (belief-based estimate):');
  for (const e of ts.beamEstimates) {
    console.log(`       [est=${e.estimate.toFixed(3)}] ${e.plan.rationale} (${e.plan.subtasks.length} subtasks)`);
  }
  console.log('     executed (verifier score):');
  const all = [ts.best, ...ts.alternatives];
  for (const o of all) {
    console.log(`       [score=${o.score.toFixed(3)}] ${o.plan.rationale}${o === ts.best ? '  ← BEST' : ''}`);
  }
  console.log(`     → BEST: ${ts.best.plan.rationale}  (score=${ts.best.score.toFixed(3)}), alternatives=${ts.alternatives.length}`);
  line('INTEGRATED RESULT (Tree Search)', ts.best.run.integrated);
  console.log(`     → episodes ${ts.best.run.episodeId} saved to memory`);

  // ── Phase 2.6: Self Reflection (Verifier → Failure reason → Planner → Next plan) ──
  const reflectTask: Task = {
    id: 'demo-reflect', capability: 'coding',
    prompt: 'Write a Python function that checks if a string is a palindrome (ignoring case) and returns True or False.',
  };
  console.log('\n  🔄 Self Reflection: fail → diagnose (Belief) → remedy → re-run (maxIter=2)');
  const rr = await lin.executeReflective(reflectTask, { maxIter: 2 });
  console.log(`     initial: ${rr.initialRun.decomposition.rationale}  (pass=${rr.initialRun.verifications.filter(v => v.passed).length}/${rr.initialRun.verifications.length})`);
  for (const v of rr.initialRun.verifications) {
    const d = rr.initialRun.decisions.find(x => x.subtask.id === v.subtask.id)!;
    console.log(`       [${v.subtask.order}] ${v.subtask.role.padEnd(9)} -> ${d.nodeId}  score=${d.result.score.toFixed(3)}  ${v.passed ? 'PASS' : 'FAIL'}`);
  }
  for (const it of rr.iterations) {
    console.log(`     iter ${it.iteration + 1}:`);
    for (const r of it.reflections) {
      console.log(`       ✗ ${r.cause.padEnd(18)} → ${r.remedy.padEnd(12)} (${r.detail})`);
    }
    console.log(`       next plan: ${it.nextPlan.rationale}  (pass=${it.nextRun.verifications.filter(v => v.passed).length}/${it.nextRun.verifications.length}, score=${planScore(it.nextRun).toFixed(3)})`);
    for (const v of it.nextRun.verifications) {
      const d = it.nextRun.decisions.find(x => x.subtask.id === v.subtask.id)!;
      const forced = d.subtask.expertPolicy?.force ? ` [forced:${d.subtask.expertPolicy.force}]` : '';
      console.log(`         [${v.subtask.order}] ${v.subtask.role.padEnd(9)} -> ${d.nodeId}${forced}  score=${d.result.score.toFixed(3)}  ${v.passed ? 'PASS' : 'FAIL'}`);
    }
  }
  console.log(`     → final: ${rr.finalPlan.rationale}  (pass=${rr.finalRun.verifications.filter(v => v.passed).length}/${rr.finalRun.verifications.length}, score=${planScore(rr.finalRun).toFixed(3)})`);
  line('INTEGRATED RESULT (Reflection)', rr.finalRun.integrated);
  console.log(`     → episode #${rr.finalRun.episodeId} saved to memory`);

  // ── Phase 2.7: Long-term Memory → Prior Belief μ₀ (Closed Bayesian Loop) ──
  const priorTask: Task = {
    id: 'demo-memory', capability: 'coding',
    prompt: 'Write a Python function that extracts all URLs (href attributes) from an HTML string.',
  };
  console.log('\n  🧠 long-term memory → prior belief μ₀  (μ₀ → Observation → μ → Memory → μ₀\')');
  console.log(`     task: ${priorTask.prompt.slice(0, 60)}...`);
  const fresh = new ArcAshaController(hub, new LinUCBShadowRouter(hub.experts), new RuleBasedPlanner(), new Verifier(0.4), mem);
  console.log('     default μ₀ (no memory): all μ=0.500 n=0');
  fresh.seedBeliefsFromMemory(priorTask, 3);
  const priorSnap = fresh.beliefSnapshot();
  for (const [nodeId, caps] of Object.entries(priorSnap)) {
    console.log(`     μ₀ ${nodeId}: coding μ=${caps.coding.mu.toFixed(3)} (n=${caps.coding.n})  math μ=${caps.math.mu.toFixed(3)} (n=${caps.math.n})  reasoning μ=${caps.reasoning.mu.toFixed(3)} (n=${caps.reasoning.n})`);
  }
  const runMem = await fresh.execute(priorTask);
  const postSnap = fresh.beliefSnapshot();
  for (const [nodeId, caps] of Object.entries(postSnap)) {
    console.log(`     μ  ${nodeId}: coding μ=${caps.coding.mu.toFixed(3)} (n=${caps.coding.n})  math μ=${caps.math.mu.toFixed(3)} (n=${caps.math.n})  reasoning μ=${caps.reasoning.mu.toFixed(3)} (n=${caps.reasoning.n})`);
  }
  console.log(`     executed → posterior: pass=${runMem.verifications.filter(v => v.passed).length}/${runMem.verifications.length}  → episode #${runMem.episodeId} (μ₀' として保存)`);

  // ── Phase 2.8: Vector Memory (類似エピソード検索) ────────────────
  console.log('\n  🔍 vector memory: search "python web scraper extract links"');
  const hits = mem.search('python web scraper extract links', 2);
  if (hits.length === 0) {
    console.log('     (no episodes yet)');
  }
  for (const { episode, similarity } of hits) {
    console.log(`     episode #${episode.id} (${episode.task.capability}, sim=${similarity.toFixed(3)})  task: ${episode.task.prompt.slice(0, 60)}`);
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

