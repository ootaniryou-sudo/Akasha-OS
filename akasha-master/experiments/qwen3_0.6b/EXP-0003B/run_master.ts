#!/usr/bin/env npx tsx
/**
 * EXP-0003B — Cost-Aware Routing
 *
 * 今までのルーティングは Quality (evaluateTask) だけを見ていた。
 * 現実の分散システムでは Quality + Latency + Memory + Cost が全て重要。
 *
 * Composite に Cost 項を追加し、異種エキスパート (Qwen 596M / SmolLM 362M /
 * Gemma 1B) で「安くて十分良い」ルーティングを検証する。
 *
 * Cost モデル:
 *   Cost(node) = params に比例する実行コスト (メモリ/エネルギーに近似)
 *   cost_score(node) = 1 - params / max_params   (小さいモデルほど高い)
 *
 * 3 ポリシー比較:
 *   ① Quality-only : w_q=1.0 (Cost を無視 — 従来の EXP-0003)
 *   ② Cost-aware   : w_q=0.5, w_l=0.2, w_c=0.3 (品質とコストのバランス)
 *   ③ Quality-priority: w_q=0.7, w_l=0.2, w_c=0.1 (中間)
 *
 * 仮説:
 *   Cost-aware は Quality を大きく落とさずに Cost を削減できる。
 *   → Quality-per-Cost (QPC = quality / params) が Quality-only より高い。
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0003B/run_master.ts --port 8080
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
  scores: Record<string, number>;
  latencies: Record<string, number>;
  choices: Record<string, string>;   // policy → nodeId
  oracle: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const OBSERVE_PER_TASK = 3;
const COST_PER_PARAM = 1e-6;  // コスト係数 (params に比例; 相対比較用)

// Cost (params in millions) — 既知のモデル定数
const PARAMS_M: Record<string, number> = {
  qwen: 596, smollm: 362, gemma: 1000,
};

// 3 policies: {name, w_quality, w_lat, w_cost}
const POLICIES = [
  { name: 'quality-only', w_q: 1.0, w_l: 0.0, w_c: 0.0 },
  { name: 'quality-priority', w_q: 0.7, w_l: 0.2, w_c: 0.1 },
  { name: 'cost-aware', w_q: 0.5, w_l: 0.2, w_c: 0.3 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Task Evaluators (EXP-0002D.1 から流用)
// ═══════════════════════════════════════════════════════════════════════════════

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  coding: ['def', 'function', 'code', 'python', 'write', 'implement', 'class', 'algorithm', 'program', 'method', 'create'],
  math: ['calculate', 'solve', 'integral', 'sum', 'equation', 'math', 'derivative', 'x^', 'x =', '% of'],
};

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
// Bayesian belief update
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
  console.log('EXP-0003B — Cost-Aware Routing');
  console.log('═'.repeat(60));
  console.log('  Composite = w_q × Quality + w_l × Latency + w_c × Cost');
  console.log('  Policies: quality-only | quality-priority | cost-aware');
  console.log(`  Cost model: params-proportional (Qwen 596M / SmolLM 362M / Gemma 1000M)\n`);

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
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0003B' }));
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
    console.log('EXPERIMENT — Cost-Aware Routing across heterogeneous experts');
    console.log('═'.repeat(60));

    const expertNodes = [...nodes.values()];
    console.log(`\n  Experts (${expertNodes.length}):`);
    for (const n of expertNodes) console.log(`    ${n.nodeId} — ${n.modelId} (${PARAMS_M[n.family] ?? 500}M params)`);

    const beliefMap: Record<string, Record<string, Belief>> = {};
    for (const n of expertNodes) {
      beliefMap[n.nodeId] = { coding: createBelief(), math: createBelief() };
    }

    let step = 0;

    // ── Phase 1: Observation (Belief learning, cost 無関係) ───────────────
    console.log('\n── Phase 1 (Observation: learn Belief(node, task)) ──\n');
    for (const task of ['coding', 'math'] as const) {
      const prompts = task === 'coding' ? codingPrompts : mathPrompts;
      for (let i = 0; i < OBSERVE_PER_TASK; i++) {
        const p = prompts[i % prompts.length];
        step++;
        const rid = `O-${task}-${i}`;
        for (const n of expertNodes) {
          const chat = n.family !== 'qwen';
          const res = await sendCompute(n.ws, `${rid}-${n.nodeId}`, p.prompt, chat);
          n.latencyMs = res.timing.total_ms;
          const score = evaluateTask(task, res.text);
          beliefMap[n.nodeId][task] = updateBelief(beliefMap[n.nodeId][task], score);
        }
      }
    }

    console.log('  Learned Belief(node, task):');
    for (const n of expertNodes) {
      const c = beliefMap[n.nodeId].coding, m = beliefMap[n.nodeId].math;
      console.log(`    ${n.nodeId.padEnd(12)} coding μ=${c.mu.toFixed(3)} eff=${c.effective.toFixed(3)} | math μ=${m.mu.toFixed(3)} eff=${m.effective.toFixed(3)}`);
    }

    // ── Phase 2: Verification (3 policy 同時比較) ─────────────────────────
    console.log('\n── Phase 2 (Verification: cost-aware routing on held-out) ──\n');

    // ポリシー集計
    const stats: Record<string, { correct: number; total: number; qSum: number; latSum: number; costSum: number }> = {};
    for (const pol of POLICIES) stats[pol.name] = { correct: 0, total: 0, qSum: 0, latSum: 0, costSum: 0 };

    for (const task of ['coding', 'math'] as const) {
      const prompts = task === 'coding' ? codingPrompts : mathPrompts;
      for (let i = OBSERVE_PER_TASK; i < prompts.length; i++) {
        const p = prompts[i];
        step++;
        const rid = `V-${task}-${i}`;

        const stepScores: Record<string, number> = {};
        const stepLat: Record<string, number> = {};
        for (const n of expertNodes) {
          const chat = n.family !== 'qwen';
          const res = await sendCompute(n.ws, `${rid}-${n.nodeId}`, p.prompt, chat);
          n.latencyMs = res.timing.total_ms;
          stepLat[n.nodeId] = res.timing.total_ms;
          stepScores[n.nodeId] = evaluateTask(task, res.text);
        }

        // Oracle: 最高品質
        const oracle = Object.entries(stepScores).sort((a, b) => b[1] - a[1])[0][0];

        // コスト正規化
        const maxParams = Math.max(...expertNodes.map(n => PARAMS_M[n.family] ?? 500));
        const costScore: Record<string, number> = {};
        const costAbs: Record<string, number> = {};
        for (const n of expertNodes) {
          const params = PARAMS_M[n.family] ?? 500;
          costScore[n.nodeId] = 1 - params / maxParams;
          costAbs[n.nodeId] = params * COST_PER_PARAM;
        }

        const maxLat = Math.max(...expertNodes.map(n => stepLat[n.nodeId]), 1);
        const latScore: Record<string, number> = {};
        for (const n of expertNodes) latScore[n.nodeId] = 1 - stepLat[n.nodeId] / maxLat;

        // 各ポリシーの composite 計算と選択
        const choices: Record<string, string> = {};
        for (const pol of POLICIES) {
          let best: string | null = null, bestScore = -Infinity;
          for (const n of expertNodes) {
            const quality = beliefMap[n.nodeId][task].effective;
            const composite = pol.w_q * quality + pol.w_l * latScore[n.nodeId] + pol.w_c * costScore[n.nodeId];
            if (composite > bestScore) { bestScore = composite; best = n.nodeId; }
          }
          choices[pol.name] = best!;
        }

        // 集計
        for (const pol of POLICIES) {
          const chosen = choices[pol.name];
          const s = stats[pol.name];
          s.total++;
          if (chosen === oracle) s.correct++;
          s.qSum += stepScores[chosen];
          s.latSum += stepLat[chosen];
          s.costSum += costAbs[chosen];
        }

        console.log(`  [${rid}] task=${task} | scores: ${expertNodes.map(n => `${n.nodeId}=${stepScores[n.nodeId].toFixed(2)}`).join(' ')}`);
        console.log(`         oracle=${oracle} | Q-only=${choices['quality-only']}${choices['quality-only'] === oracle ? '✓' : '✗'} Q-prio=${choices['quality-priority']}${choices['quality-priority'] === oracle ? '✓' : '✗'} CostAware=${choices['cost-aware']}${choices['cost-aware'] === oracle ? '✓' : '✗'}`);

        records.push({
          step, phase: 'verify', capability: task, prompt: p.prompt,
          scores: stepScores, latencies: stepLat, choices, oracle,
        });
      }
    }

    // ── Results ────────────────────────────────────────────────────────────
    console.log('\n═'.repeat(60));
    console.log('RESULTS — Cost-Aware Routing');
    console.log('═'.repeat(60));

    console.log(`\n  Routing Accuracy + Cost (${stats['quality-only'].total} held-out prompts):`);
    console.log(`  ┌──────────────────┬────────────┬────────────┬─────────────┬────────────┐`);
    console.log(`  │ Policy           │ Routing Acc│ Avg Quality│ Avg Cost    │ QPC (Q/cost)│`);
    console.log(`  ├──────────────────┼────────────┼────────────┼─────────────┼────────────┤`);
    for (const pol of POLICIES) {
      const s = stats[pol.name];
      const acc = (s.correct / s.total * 100).toFixed(0);
      const avgQ = (s.qSum / s.total).toFixed(3);
      const avgCost = (s.costSum / s.total).toFixed(4);
      const qpc = ((s.qSum / s.total) / (s.costSum / s.total)).toFixed(0);
      console.log(`  │ ${pol.name.padEnd(16)} │ ${acc.padStart(5)}% (${s.correct}/${s.total}) │ ${avgQ.padStart(10)} │ ${avgCost.padStart(11)} │ ${qpc.padStart(10)} │`);
    }
    console.log(`  └──────────────────┴────────────┴────────────┴─────────────┴────────────┘`);

    // タスク別
    console.log('\n  Per-task:');
    for (const task of ['coding', 'math'] as const) {
      const recs = records.filter(r => r.capability === task);
      console.log(`    ${task.padEnd(8)}: ${POLICIES.map(p => {
        const c = recs.filter(r => r.choices[p.name] === r.oracle).length;
        return `${p.name}=${c}/${recs.length}`;
      }).join(' | ')}`);
    }

    // 選択傾向 (どのモデルが選ばれたか)
    console.log('\n  Model selection distribution:');
    for (const pol of POLICIES) {
      const counts: Record<string, number> = {};
      for (const r of records) counts[r.choices[pol.name]] = (counts[r.choices[pol.name]] ?? 0) + 1;
      console.log(`    ${pol.name.padEnd(16)}: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }

    // 仮説検証: Cost-aware の QPC が quality-only より高いか
    const qo = stats['quality-only'], ca = stats['cost-aware'];
    const qoQPC = (qo.qSum / qo.total) / (qo.costSum / qo.total);
    const caQPC = (ca.qSum / ca.total) / (ca.costSum / ca.total);
    const qoAcc = qo.correct / qo.total, caAcc = ca.correct / ca.total;
    console.log('\n  Hypothesis: Cost-aware achieves higher Quality-per-Cost with small accuracy cost');
    console.log(`    QPC: quality-only=${qoQPC.toFixed(0)} | cost-aware=${caQPC.toFixed(0)} (ratio ${(caQPC / qoQPC).toFixed(2)}x)`);
    console.log(`    Acc: quality-only=${(qoAcc * 100).toFixed(0)}% | cost-aware=${(caAcc * 100).toFixed(0)}%`);
    const verdict = caQPC > qoQPC * 1.05
      ? 'SUPPORTED ✅ (cost-aware QPC > quality-only QPC by >5%)'
      : caQPC > qoQPC ? 'WEAKLY SUPPORTED ⚠️ (cost-aware QPC higher but <5%)' : 'NOT SUPPORTED ❌';
    console.log(`    Verdict: ${verdict}`);

    // Save
    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0003B/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0003B',
      description: 'Cost-Aware Routing (Quality + Latency + Cost)',
      timestamp: new Date().toISOString(),
      config: {
        policies: POLICIES,
        cost_per_param: COST_PER_PARAM,
        params_m: PARAMS_M,
        observe_per_task: OBSERVE_PER_TASK,
      },
      experts: expertNodes.map(n => ({ node_id: n.nodeId, model_id: n.modelId, family: n.family, params_m: PARAMS_M[n.family] ?? 500 })),
      metrics: Object.fromEntries(POLICIES.map(p => {
        const s = stats[p.name];
        return [p.name, {
          routing_accuracy: s.correct / s.total,
          avg_quality: Math.round(s.qSum / s.total * 1000) / 1000,
          avg_cost: Math.round(s.costSum / s.total * 100000) / 100000,
          qpc: Math.round((s.qSum / s.total) / (s.costSum / s.total) * 100) / 100,
        }];
      })),
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
  console.log('  Nodes needed: node-qwen, node-smollm, node-gemma');
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16`);
  console.log();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

