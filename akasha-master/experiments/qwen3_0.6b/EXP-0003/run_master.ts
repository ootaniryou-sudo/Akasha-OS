#!/usr/bin/env npx tsx
/**
 * EXP-0003 — Heterogeneous Experts: Belief(Node, Task)
 *
 * 本当に異質な Expert (Qwen3-0.6B / SmolLM2-360M / Gemma-3-1B) で、
 * Belief を「ノード単位」から「ノード × タスク」に拡張する実験。
 *
 * 異種モデルではトークン重複シャドウは意味を持たない (語彙が異なる) ため、
 * 「タスク評価スコア (evaluateTask)」を観測として Belief を学習する。
 *
 *   Phase 1 (観測): 各 (node, task) に N プロンプト → evaluateTask スコア
 *                   → ベイズ更新 Belief(node, task) = {μ, confidence}
 *   Phase 2 (検証): 未観測プロンプトを提示 → Composite(node, task) で argmax
 *                   → 選択モデルの評価スコアを記録
 *
 * 比較:
 *   Fixed profile  : 事前知識 (family の一般特性) で composite を計算
 *   Belief learned : Phase 1 の観測から学習した Belief で composite を計算
 *
 * 仮説:
 *   Belief(node, task) を観測から学習すると、family の事前知識 (Fixed profile)
 *   よりもタスク別の実力を正確に捉え、高い Routing Accuracy / 平均評価を達成する。
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0003/run_master.ts --port 8080
 */

import WebSocket, { WebSocketServer } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface RemoteResult {
  type: 'result'; request_id: string; tokens: number[]; text: string;
  timing: { tokenize_ms: number; prefill_ms: number; decode_ms: number; total_ms: number };
  metadata: { node_id: string; backend: string; precision: string; model_id?: string; platform: string; role: string };
}

interface PromptEntry { prompt: string; capability: string; }

interface ConnectedNode {
  ws: WebSocket; nodeId: string; backend: string; precision: string;
  modelId: string; family: string; requestCount: number; errors: number; latencyMs: number;
}

interface Belief { mu: number; n: number; confidence: number; effective: number; }

interface StepRecord {
  step: number; phase: string; capability: string; prompt: string;
  scores: Record<string, number>;           // nodeId → evaluateTask score
  fixedChoice: string; beliefChoice: string; oracle: string;
  fixedScore: number; beliefScore: number;
  belief: Record<string, Record<string, { mu: number; n: number; confidence: number }>>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const OBSERVE_PER_TASK = 3;   // Phase 1: 各 (node, task) の観測回数
const VERIFY_TASKS = 2;       // Phase 2: 検証タスク数 (各 task 数回)

// 事前知識 (family の一般特性) — Fixed profile 用
const FIXED_PROFILE: Record<string, Record<string, number>> = {
  qwen:   { coding: 0.85, math: 0.75 },
  smollm: { coding: 0.70, math: 0.65 },
  gemma:  { coding: 0.80, math: 0.85 },
};

const WEIGHTS = { cap: 0.50, lat: 0.15, stab: 0.35 };

// ═══════════════════════════════════════════════════════════════════════════════
// Task Evaluators (EXP-0002D.1 から流用)
// ═══════════════════════════════════════════════════════════════════════════════

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  coding: ['def', 'function', 'code', 'python', 'write', 'implement', 'class', 'algorithm', 'program', 'method', 'create'],
  math: ['calculate', 'solve', 'integral', 'sum', 'equation', 'math', 'derivative', 'x^', 'x =', '% of'],
};

function classifyPrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  const scores: Record<string, number> = {};
  for (const [cap, kws] of Object.entries(CAPABILITY_KEYWORDS))
    scores[cap] = kws.filter(k => lower.includes(k.toLowerCase())).length;
  let best = 'general', bestScore = 0;
  for (const [cap, s] of Object.entries(scores))
    if (s > bestScore) { best = cap; bestScore = s; }
  return best;
}

function evaluateCoding(text: string): number {
  const lower = text.toLowerCase();
  const structural = ['def ', 'return ', 'import ', 'class ', 'print(', 'for ', 'if ', 'else:', 'while ', 'len(', 'range('];
  const structHits = structural.filter(k => lower.includes(k)).length;
  const structScore = Math.min(1.0, structHits / 5);
  const refusal = ['sorry', 'cannot', 'unable', 'as an ai', 'i am'];
  const refusalHits = refusal.filter(k => lower.includes(k)).length;
  const refusalPenalty = refusalHits * 0.35;
  return Math.max(0.0, Math.min(1.0, structScore - refusalPenalty));
}

function evaluateMath(text: string): number {
  const lower = text.toLowerCase();
  const mathSignals = ['=', '+', '*', '/', '^', 'result', 'answer', 'solution', 'sum', 'product', 'integral', 'derivative', 'x ='];
  const signalHits = mathSignals.filter(k => lower.includes(k)).length;
  const signalScore = Math.min(1.0, signalHits / 4);
  const hasNumbers = /\d+/.test(text);
  const numberBonus = hasNumbers ? 0.2 : 0;
  const refusal = ['sorry', 'cannot', 'unable', 'as an ai', 'i am'];
  const refusalHits = refusal.filter(k => lower.includes(k)).length;
  const refusalPenalty = refusalHits * 0.35;
  return Math.max(0.0, Math.min(1.0, signalScore + numberBonus - refusalPenalty));
}

function evaluateTask(capability: string, text: string): number {
  switch (capability) {
    case 'coding': return Math.round(evaluateCoding(text) * 1000) / 1000;
    case 'math': return Math.round(evaluateMath(text) * 1000) / 1000;
    default: {
      const len = Math.min(1.0, text.length / 150);
      const refusal = ['sorry', 'cannot', 'unable', 'error'];
      const refusalHits = refusal.filter(k => text.toLowerCase().includes(k)).length;
      return Math.max(0.0, Math.min(1.0, len - refusalHits * 0.3));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bayesian belief update (0002D.1 の μ/confidence 方式)
// ═══════════════════════════════════════════════════════════════════════════════

function createBelief(): Belief { return { mu: 0.5, n: 0, confidence: 0, effective: 0.5 }; }

function updateBelief(b: Belief, score: number): Belief {
  const mu = (b.n * b.mu + score) / (b.n + 1);
  const n = b.n + 1;
  const confidence = 1 - Math.exp(-n / 8);
  return {
    mu: Math.round(mu * 1000) / 1000,
    n,
    confidence: Math.round(confidence * 1000) / 1000,
    effective: Math.round(mu * confidence * 1000) / 1000,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI / Main
// ═══════════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const port = parseInt(getArg('--port', '8080'), 10);

const nodes = new Map<string, ConnectedNode>();
const records: StepRecord[] = [];
let experimentStarted = false;

function sendCompute(ws: WebSocket, requestId: string, prompt: string, chat: boolean): Promise<RemoteResult> {
  return new Promise<RemoteResult>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 120000);
    const handler = (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'result' && m.request_id === requestId) {
          clearTimeout(timeout); ws.removeListener('message', handler);
          resolve(m as RemoteResult);
        }
      } catch (_) {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'compute', request_id: requestId,
      prompt, max_new_tokens: 40, temperature: 0, top_p: 1, chat }));
  });
}

async function main() {
  console.log('═'.repeat(60));
  console.log('EXP-0003 — Heterogeneous Experts: Belief(Node, Task)');
  console.log('═'.repeat(60));
  console.log(`  Models: Qwen3-0.6B (general) | SmolLM2-360M (fast) | Gemma-3-1B (reasoning)`);
  console.log(`  Observation: ${OBSERVE_PER_TASK} prompts per (node, task)`);
  console.log(`  Compare: Fixed profile (prior) vs Belief learned (observation)\n`);

  // タスク別プロンプト (EXP-0003/prompts.jsonl — 各タスク 8 件)
  const rawPrompts: PromptEntry[] = [];
  for (const line of fs.readFileSync(path.resolve('experiments/qwen3_0.6b/EXP-0003/prompts.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line);
    if (raw.capability === 'coding' || raw.capability === 'math') {
      rawPrompts.push({ prompt: raw.prompt, capability: raw.capability });
    }
  }
  const codingPrompts = rawPrompts.filter(p => p.capability === 'coding');
  const mathPrompts = rawPrompts.filter(p => p.capability === 'math');
  console.log(`  Loaded prompts: coding=${codingPrompts.length}, math=${mathPrompts.length}\n`);

  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws: WebSocket, req) => {
    const clientIp = req.socket?.remoteAddress || 'unknown';
    let nodeId = `unknown-${clientIp}`;

    ws.on('message', (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'register') {
        nodeId = msg.node.id;
        const node: ConnectedNode = {
          ws, nodeId,
          backend: msg.node.backend || 'cpu',
          precision: msg.node.precision || 'fp16',
          modelId: msg.node.model_id || 'unknown',
          family: nodeId.split('-').pop() || 'unknown',
          requestCount: 0, errors: 0, latencyMs: 0,
        };
        nodes.set(nodeId, node);
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0003' }));
        console.log(`  ✅ ${nodeId} (${node.backend}/${node.precision}) model=${node.modelId}`);

        if (nodes.size >= 3 && !experimentStarted) {
          experimentStarted = true;
          setTimeout(() => runExperiment(), 1500);
        }
        return;
      }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); return; }
    });

    ws.on('close', () => nodes.delete(nodeId));
    ws.on('error', () => {});
  });

  async function runExperiment() {
    console.log('\n═'.repeat(60));
    console.log('EXPERIMENT — Belief(Node, Task) across heterogeneous experts');
    console.log('═'.repeat(60));

    const expertNodes = [...nodes.values()];
    console.log(`\n  Experts (${expertNodes.length}):`);
    for (const n of expertNodes) console.log(`    ${n.nodeId} — ${n.modelId} (family=${n.family})`);

    // Belief: nodeId → task → Belief
    const beliefMap: Record<string, Record<string, Belief>> = {};
    for (const n of expertNodes) {
      beliefMap[n.nodeId] = { coding: createBelief(), math: createBelief() };
    }

    const scores: Record<string, Record<string, number[]>> = {}; // nodeId → task → scores
    for (const n of expertNodes) scores[n.nodeId] = { coding: [], math: [] };

    let step = 0;

    // ── Phase 1: Observation ──────────────────────────────────────────────
    console.log('\n── Phase 1 (Observation: learn Belief(node, task)) ──\n');
    for (const task of ['coding', 'math'] as const) {
      const prompts = task === 'coding' ? codingPrompts : mathPrompts;
      for (let i = 0; i < OBSERVE_PER_TASK; i++) {
        const p = prompts[i % prompts.length];
        step++;
        const rid = `O-${task}-${i}`;
        const stepScores: Record<string, number> = {};
        for (const n of expertNodes) {
          // Qwen3 はベースモデル (raw prompt)、SmolLM/Gemma は instruct (chat template)
          const chat = n.family !== 'qwen';
          const res = await sendCompute(n.ws, `${rid}-${n.nodeId}`, p.prompt, chat);
          n.latencyMs = res.timing.total_ms;
          const score = evaluateTask(task, res.text);
          scores[n.nodeId][task].push(score);
          stepScores[n.nodeId] = score;
          beliefMap[n.nodeId][task] = updateBelief(beliefMap[n.nodeId][task], score);
          console.log(`  [${rid}] ${n.nodeId.padEnd(12)} score=${score.toFixed(3)} mu=${beliefMap[n.nodeId][task].mu.toFixed(3)} n=${beliefMap[n.nodeId][task].n}`);
        }
      }
    }

    // Phase 1 結果: 学習された Belief
    console.log('\n  Learned Belief(node, task):');
    for (const n of expertNodes) {
      const c = beliefMap[n.nodeId].coding, m = beliefMap[n.nodeId].math;
      console.log(`    ${n.nodeId.padEnd(12)} coding: μ=${c.mu.toFixed(3)} conf=${c.confidence.toFixed(3)} eff=${c.effective.toFixed(3)} | math: μ=${m.mu.toFixed(3)} conf=${m.confidence.toFixed(3)} eff=${m.effective.toFixed(3)}`);
    }

    // ── Phase 2: Verification (routing on held-out prompts) ───────────────
    console.log('\n── Phase 2 (Verification: task routing with learned belief) ──\n');
    let fixedCorrect = 0, beliefCorrect = 0, total = 0;
    let fixedScoreSum = 0, beliefScoreSum = 0;

    for (const task of ['coding', 'math'] as const) {
      const prompts = task === 'coding' ? codingPrompts : mathPrompts;
      for (let i = OBSERVE_PER_TASK; i < prompts.length; i++) {
        const p = prompts[i];
        step++;
        const rid = `V-${task}-${i}`;
        total++;

        // 各モデルに評価用プロンプトを実行
        const stepScores: Record<string, number> = {};
        const stepLat: Record<string, number> = {};
        for (const n of expertNodes) {
          const chat = n.family !== 'qwen';
          const res = await sendCompute(n.ws, `${rid}-${n.nodeId}`, p.prompt, chat);
          n.latencyMs = res.timing.total_ms;
          stepLat[n.nodeId] = res.timing.total_ms;
          stepScores[n.nodeId] = evaluateTask(task, res.text);
        }

        // ① Fixed profile: 事前知識だけで composite
        //    composite = w_cap × profile + w_lat × latScore + w_stab × conf(1.0)
        const maxLat = Math.max(...expertNodes.map(n => stepLat[n.nodeId]), 1);
        const fixedComposite: Record<string, number> = {};
        for (const n of expertNodes) {
          const profile = FIXED_PROFILE[n.family]?.[task] ?? 0.5;
          const latScore = 1 - stepLat[n.nodeId] / maxLat;
          fixedComposite[n.nodeId] = WEIGHTS.cap * profile + WEIGHTS.lat * latScore + WEIGHTS.stab * 1.0;
        }
        const fixedChoice = Object.entries(fixedComposite).sort((a, b) => b[1] - a[1])[0][0];

        // ② Belief learned: 観測から学習した Belief で composite
        const beliefComposite: Record<string, number> = {};
        for (const n of expertNodes) {
          const b = beliefMap[n.nodeId][task];
          const latScore = 1 - stepLat[n.nodeId] / maxLat;
          beliefComposite[n.nodeId] = WEIGHTS.cap * b.effective + WEIGHTS.lat * latScore + WEIGHTS.stab * b.confidence;
        }
        const beliefChoice = Object.entries(beliefComposite).sort((a, b) => b[1] - a[1])[0][0];

        // Oracle: 実際に最も良いスコアを出したノード (ground truth)
        const oracle = Object.entries(stepScores).sort((a, b) => b[1] - a[1])[0][0];

        const fCorrect = fixedChoice === oracle;
        const bCorrect = beliefChoice === oracle;
        if (fCorrect) fixedCorrect++;
        if (bCorrect) beliefCorrect++;
        fixedScoreSum += stepScores[fixedChoice];
        beliefScoreSum += stepScores[beliefChoice];

        console.log(`  [${rid}] task=${task} | scores: ${expertNodes.map(n => `${n.nodeId}=${stepScores[n.nodeId].toFixed(2)}`).join(' ')}`);
        console.log(`         oracle=${oracle} | fixed=${fixedChoice}${fCorrect ? '✓' : '✗'} belief=${beliefChoice}${bCorrect ? '✓' : '✗'}`);

        // 学習継続 (オンライン更新)
        for (const n of expertNodes) {
          beliefMap[n.nodeId][task] = updateBelief(beliefMap[n.nodeId][task], stepScores[n.nodeId]);
          scores[n.nodeId][task].push(stepScores[n.nodeId]);
        }

        records.push({
          step, phase: 'verify', capability: task, prompt: p.prompt,
          scores: stepScores, fixedChoice, beliefChoice, oracle,
          fixedScore: Math.round(stepScores[fixedChoice] * 1000) / 1000,
          beliefScore: Math.round(stepScores[beliefChoice] * 1000) / 1000,
          belief: Object.fromEntries(expertNodes.map(n => [n.nodeId, Object.fromEntries(
            (['coding', 'math'] as const).map(t => [t, { mu: beliefMap[n.nodeId][t].mu, n: beliefMap[n.nodeId][t].n, confidence: beliefMap[n.nodeId][t].confidence }])
          )])),
        });
      }
    }

    // ── Results ────────────────────────────────────────────────────────────
    console.log('\n═'.repeat(60));
    console.log('RESULTS — Fixed profile vs Belief learned');
    console.log('═'.repeat(60));

    console.log(`\n  Routing Accuracy (choice === oracle):`);
    console.log(`  ┌──────────────┬──────────────┬──────────────┬──────────────┐`);
    console.log(`  │ Policy       │ Routing Acc  │ Avg Eval     │ Best Family  │`);
    console.log(`  ├──────────────┼──────────────┼──────────────┼──────────────┤`);
    console.log(`  │ Fixed        │ ${(fixedCorrect / total * 100).toFixed(0).padStart(5)}% (${fixedCorrect}/${total}) │ ${(fixedScoreSum / total).toFixed(3).padStart(10)} │              │`);
    console.log(`  │ Belief       │ ${(beliefCorrect / total * 100).toFixed(0).padStart(5)}% (${beliefCorrect}/${total}) │ ${(beliefScoreSum / total).toFixed(3).padStart(10)} │              │`);
    console.log(`  └──────────────┴──────────────┴──────────────┴──────────────┘`);

    // タスク別
    console.log('\n  Per-task:');
    for (const task of ['coding', 'math'] as const) {
      const recs = records.filter(r => r.capability === task);
      const fAcc = recs.filter(r => r.fixedChoice === r.oracle).length;
      const bAcc = recs.filter(r => r.beliefChoice === r.oracle).length;
      const fScore = recs.reduce((s, r) => s + r.fixedScore, 0) / recs.length;
      const bScore = recs.reduce((s, r) => s + r.beliefScore, 0) / recs.length;
      console.log(`    ${task.padEnd(8)}: Fixed acc=${fAcc}/${recs.length} avg=${fScore.toFixed(3)} | Belief acc=${bAcc}/${recs.length} avg=${bScore.toFixed(3)}`);
    }

    // 学習された Belief の最終状態
    console.log('\n  Final Belief(node, task):');
    for (const n of expertNodes) {
      const c = beliefMap[n.nodeId].coding, m = beliefMap[n.nodeId].math;
      console.log(`    ${n.nodeId.padEnd(12)} coding μ=${c.mu.toFixed(3)} (n=${c.n}) | math μ=${m.mu.toFixed(3)} (n=${m.n})`);
    }

    const hypothesis = beliefCorrect >= fixedCorrect
      ? 'SUPPORTED ✅ (Belief learned >= Fixed profile)'
      : 'NOT SUPPORTED ❌ (Fixed profile better)';
    console.log(`\n  Hypothesis: Belief(Node, Task) learned from observation outperforms fixed family profile`);
    console.log(`    Verdict: ${hypothesis}`);

    // Save
    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0003/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0003',
      description: 'Heterogeneous Experts: Belief(Node, Task) learning',
      timestamp: new Date().toISOString(),
      config: {
        observe_per_task: OBSERVE_PER_TASK,
        fixed_profile: FIXED_PROFILE,
        weights: WEIGHTS,
      },
      experts: expertNodes.map(n => ({ node_id: n.nodeId, model_id: n.modelId, family: n.family })),
      metrics: {
        fixed: { routing_accuracy: fixedCorrect / total, avg_eval: Math.round(fixedScoreSum / total * 1000) / 1000 },
        belief: { routing_accuracy: beliefCorrect / total, avg_eval: Math.round(beliefScoreSum / total * 1000) / 1000 },
      },
      final_belief: Object.fromEntries(expertNodes.map(n => [n.nodeId, {
        coding: beliefMap[n.nodeId].coding, math: beliefMap[n.nodeId].math,
      }])),
      trajectory: records,
    }, null, 2));
    console.log(`\n  📁 ${outDir}/summary.json\n`);

    for (const [id, node] of nodes) node.ws.close();
    wss.close();
    process.exit(0);
  }

  console.log(`\n  🟢 Master on ws://localhost:${port}\n`);
  console.log('  Nodes needed: node-qwen, node-smollm, node-gemma (heterogeneous experts)');
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16`);
  console.log();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
