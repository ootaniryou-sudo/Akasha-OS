#!/usr/bin/env npx tsx
/**
 * EXP-0003C.2 — Sample Complexity Estimation
 *
 * 0003C.1 の結果 (UCB/Thompson は Q-Learning より2-3倍サンプル効率だが
 * 60サンプルでは Fixed 未達) を受けて、収束に必要なサンプル数 N* を
 * 実測 + 曲線フィットで推定する。
 *
 * Empirical Observation 1 (論文用フレーミング — "Hypothesis" でなく観測事実):
 *   The required number of observations increased consistently as the
 *   learning target moved from weights → state → policy.
 *
 *   Depth ↑          Sample to beat Fixed
 *   ─────────────────────────────────────
 *   Layer 1: weight  ~0    (0002E.3: 即時有効)
 *   Layer 2: state   ~6    (0003A: baseline 後)
 *   Layer 3: policy  >60   (0003C / 0003C.1: 未達)
 *
 * 手法: 4手法 (Fixed / Q-Learning / UCB1 / Thompson) を 120 ステップ実測し、
 * Cumulative Regret を 5 ステップ刻みで記録する。
 * その後 analyze_complexity.py が曲線フィットを行い N* を推定:
 *   (M1) Regret(N) = a·exp(-b·N) + c      (飽和指数)
 *   (M2) Regret(N) = a·N^b                (冪則)
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0003C.2/run_master.ts --port 8080
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

interface CheckpointRecord { samples: number; cumRegret: Record<string, number>; }

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const TOTAL_STEPS = 120;          // サンプルスケーリングの上限 (2 環境サイクル)
const CHECKPOINTS = [24, 60, 100, 120];
const SERIES_EVERY = 5;           // フィット用の密な記録間隔
const STEPS_PER_PHASE = 20;       // フェーズ切り替え (3 フェーズ × 20 = 60 / サイクル)

const ETA = 0.3;
const EPSILON = 0.15;
const UCB_C = 2.0;                // UCB 探索係数

// フェーズ定義: 注入を交互に (baseline / latency / capjump) — 2 サイクル繰り返す
const PHASES: { name: string; inject: { type: 'latency' | 'capability'; node: string; factor: number } | null }[] = [
  { name: 'baseline', inject: null },
  { name: 'latency', inject: { type: 'latency', node: 'node-smollm', factor: 3.0 } },
  { name: 'capjump', inject: { type: 'capability', node: 'node-gemma', factor: 0.5 } },
];

const PARAMS_M: Record<string, number> = { qwen: 596, smollm: 362, gemma: 1000 };

const REWARD = { q: 1.0, lat: 0.10, cost: 0.10, stab: 0.10 };
const FIXED_W = { q: 0.60, lat: 0.20, cost: 0.05, stab: 0.15 };

// ═══════════════════════════════════════════════════════════════════════════════
// Task Evaluators
// ═══════════════════════════════════════════════════════════════════════════════

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

function createBelief(): Belief { return { mu: 0.5, n: 0, confidence: 0, effective: 0.5 }; }
function updateBelief(b: Belief, score: number): Belief {
  const mu = (b.n * b.mu + score) / (b.n + 1);
  const n = b.n + 1;
  const confidence = 1 - Math.exp(-n / 8);
  return { mu: Math.round(mu * 1000) / 1000, n, confidence: Math.round(confidence * 1000) / 1000, effective: Math.round(mu * confidence * 1000) / 1000 };
}
function updateEMA(prev: { ema: number; n: number }, measured: number): { ema: number; n: number } {
  const alpha = 0.3;
  const ema = prev.n === 0 ? measured : alpha * measured + (1 - alpha) * prev.ema;
  return { ema: Math.round(ema), n: prev.n + 1 };
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
  console.log('EXP-0003C.2 — Sample Complexity Estimation');
  console.log('═'.repeat(60));
  console.log('  Context (state) → Arm (node) → Reward');
  console.log('  Methods: Fixed | Q-Learning | UCB1 | Thompson');
  console.log(`  Samples: ${TOTAL_STEPS} steps, series every ${SERIES_EVERY}`);
  console.log('  Goal: 実測 Regret 曲線 → フィット → Fixed 超えの N* を推定\n');

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
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0003C.2' }));
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
    console.log('EXPERIMENT — Sample Complexity: 120 steps, series every 5');
    console.log('═'.repeat(60));

    const expertNodes = [...nodes.values()];
    console.log(`\n  Experts (${expertNodes.length}):`);
    for (const n of expertNodes) console.log(`    ${n.nodeId} — ${n.modelId} (${PARAMS_M[n.family] ?? 500}M)`);
    const nodeIds = expertNodes.map(n => n.nodeId);

    // 状態推定
    const state: Record<string, { cap: Record<string, Belief>; lat: { ema: number; n: number }; stab: number }> = {};
    for (const n of expertNodes) {
      state[n.nodeId] = { cap: { coding: createBelief(), math: createBelief() }, lat: { ema: 0, n: 0 }, stab: 1.0 };
    }

    // 各手法の統計
    const NUM_STATES = 4;
    // Q-Learning: Q[s][a], counts
    let qTable: number[][] = Array.from({ length: NUM_STATES }, () => nodeIds.map(() => 0.0));
    let qCounts: number[][] = Array.from({ length: NUM_STATES }, () => nodeIds.map(() => 0));
    // UCB1: Qbar[a], n[a]
    let ucbQ: number[] = nodeIds.map(() => 0.0);
    let ucbN: number[] = nodeIds.map(() => 0);
    // Thompson: Beta success/failure
    let thAlpha: number[] = nodeIds.map(() => 1.0);
    let thBeta: number[] = nodeIds.map(() => 1.0);

    const cumRegret: Record<string, number> = { fixed: 0, qlearn: 0, ucb: 0, thompson: 0 };
    const checkpoints: CheckpointRecord[] = [];
    const series: CheckpointRecord[] = [];

    let step = 0;

    for (let s = 0; s < TOTAL_STEPS; s++) {
      const ph = PHASES[Math.floor(s / STEPS_PER_PHASE) % PHASES.length];
      const task = s % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(s / 2) % 8];
      step++;
      const rid = `${ph.name[0].toUpperCase()}-${String(step).padStart(3, '0')}`;

      // 推論 + 注入
      const trueScores: Record<string, number> = {};
      const injectedLat: Record<string, number> = {};
      for (const n of expertNodes) {
        const chat = n.family !== 'qwen';
        const res = await sendCompute(n.ws, `${rid}-${n.nodeId}`, p.prompt, chat);
        n.latencyMs = res.timing.total_ms;
        let score = evaluateTask(task, res.text);
        if (ph.inject?.type === 'capability' && ph.inject.node === n.nodeId) {
          score = Math.round(score * ph.inject.factor * 1000) / 1000;
        }
        trueScores[n.nodeId] = score;
        let lat = res.timing.total_ms;
        if (ph.inject?.type === 'latency' && ph.inject.node === n.nodeId) {
          lat = Math.round(lat * ph.inject.factor);
        }
        injectedLat[n.nodeId] = lat;
      }

      const oracle = Object.entries(trueScores).sort((a, b) => b[1] - a[1])[0][0];

      // 状態推定
      for (const n of expertNodes) {
        state[n.nodeId].cap[task] = updateBelief(state[n.nodeId].cap[task], trueScores[n.nodeId]);
        state[n.nodeId].lat = updateEMA(state[n.nodeId].lat, injectedLat[n.nodeId]);
      }

      // 離散状態
      const lats = nodeIds.map(id => injectedLat[id] || 1);
      const sorted = [...lats].sort((a, b) => a - b);
      const medianLat = sorted[Math.floor(sorted.length / 2)] || 1;
      const latAnomaly = (Math.max(...lats) / Math.max(1, medianLat)) > 1.5 ? 1 : 0;
      const capAnomaly = nodeIds.some(id => state[id].cap[task].mu < 0.5) ? 1 : 0;
      const sIdx = latAnomaly * 2 + capAnomaly;

      const maxLat = Math.max(...nodeIds.map(id => injectedLat[id]), 1);
      const maxParams = Math.max(...expertNodes.map(n => PARAMS_M[n.family] ?? 500));

      const rewardFor = (id: string) => {
        const n = expertNodes.find(x => x.nodeId === id)!;
        return REWARD.q * trueScores[id]
          + REWARD.lat * (1 - injectedLat[id] / maxLat)
          + REWARD.cost * (1 - PARAMS_M[n.family] / maxParams)
          + REWARD.stab * state[id].stab;
      };

      // ── ① Fixed (手設計) ──
      let fixedBest: string | null = null, fixedScore = -Infinity;
      for (const n of expertNodes) {
        const st = state[n.nodeId];
        const comp = FIXED_W.q * (st.cap[task].effective || 0.5)
          + FIXED_W.lat * (1 - injectedLat[n.nodeId] / maxLat)
          + FIXED_W.cost * (1 - PARAMS_M[n.family] / maxParams)
          + FIXED_W.stab * st.stab;
        if (comp > fixedScore) { fixedScore = comp; fixedBest = n.nodeId; }
      }

      // ── ② Q-Learning (ε-greedy, state-contextual) ──
      let qBest: string;
      if (Math.random() < EPSILON) {
        qBest = nodeIds[Math.floor(Math.random() * nodeIds.length)];
      } else {
        let bi = 0;
        for (let i = 1; i < nodeIds.length; i++) if (qTable[sIdx][i] > qTable[sIdx][bi]) bi = i;
        qBest = nodeIds[bi];
      }
      const rQ = rewardFor(qBest);
      const qIdx = nodeIds.indexOf(qBest);
      qTable[sIdx][qIdx] += ETA * (rQ - qTable[sIdx][qIdx]);
      qCounts[sIdx][qIdx]++;

      // ── ③ UCB1 ──
      const t = step;
      let ucbBest: string | null = null, ucbScore = -Infinity;
      for (const n of expertNodes) {
        const a = nodeIds.indexOf(n.nodeId);
        const score = ucbN[a] === 0 ? Infinity : ucbQ[a] + Math.sqrt(UCB_C * Math.log(t + 1) / ucbN[a]);
        if (score > ucbScore) { ucbScore = score; ucbBest = n.nodeId; }
      }
      const rU = rewardFor(ucbBest!);
      const uIdx = nodeIds.indexOf(ucbBest!);
      ucbQ[uIdx] = (ucbQ[uIdx] * ucbN[uIdx] + rU) / (ucbN[uIdx] + 1);
      ucbN[uIdx]++;

      // ── ④ Thompson Sampling ──
      let thBest: string | null = null, thScore = -Infinity;
      for (const n of expertNodes) {
        const a = nodeIds.indexOf(n.nodeId);
        // Normal 近似の Beta サンプリング
        const mu = thAlpha[a] / (thAlpha[a] + thBeta[a]);
        const varr = (thAlpha[a] * thBeta[a]) / ((thAlpha[a] + thBeta[a]) ** 2 * (thAlpha[a] + thBeta[a] + 1));
        const sample = mu + Math.sqrt(Math.max(0, varr)) * gaussian();
        if (sample > thScore) { thScore = sample; thBest = n.nodeId; }
      }
      const rT = rewardFor(thBest!);
      const tIdx = nodeIds.indexOf(thBest!);
      thAlpha[tIdx] += rT;
      thBeta[tIdx] += (1 - rT);

      // Regret 更新 (Quality 基準)
      cumRegret.fixed += Math.max(0, trueScores[oracle] - trueScores[fixedBest!]);
      cumRegret.qlearn += Math.max(0, trueScores[oracle] - trueScores[qBest]);
      cumRegret.ucb += Math.max(0, trueScores[oracle] - trueScores[ucbBest!]);
      cumRegret.thompson += Math.max(0, trueScores[oracle] - trueScores[thBest!]);

      // フィット用 series (SERIES_EVERY 刻み) + チェックポイント記録
      if (step % SERIES_EVERY === 0 || CHECKPOINTS.includes(step)) {
        series.push({ samples: step, cumRegret: { ...cumRegret } });
      }
      if (CHECKPOINTS.includes(step)) {
        checkpoints.push({ samples: step, cumRegret: { ...cumRegret } });
      }

      if (step % 10 === 0 || step <= 3) {
        console.log(`  [${rid}] ${ph.name.padEnd(8)} ${task} | F=${fixedBest!} Q=${qBest} U=${ucbBest!} T=${thBest!} | cumRegret F=${cumRegret.fixed.toFixed(2)} Q=${cumRegret.qlearn.toFixed(2)} U=${cumRegret.ucb.toFixed(2)} T=${cumRegret.thompson.toFixed(2)}`);
      }
    }

    // ── Results ────────────────────────────────────────────────────────────
    console.log('\n═'.repeat(60));
    console.log('RESULTS — Sample Complexity: raw measured series');
    console.log('═'.repeat(60));

    console.log('\n  Cumulative Regret at checkpoints:');
    console.log('  ┌─────────┬─────────┬──────────┬──────────┬──────────┐');
    console.log('  │ Samples │ Fixed   │ Q-Learn  │ UCB      │ Thompson │');
    console.log('  ├─────────┼─────────┼──────────┼──────────┼──────────┤');
    for (const cp of checkpoints) {
      console.log(`  │ ${String(cp.samples).padStart(7)} │ ${cp.cumRegret.fixed.toFixed(2).padStart(7)} │ ${cp.cumRegret.qlearn.toFixed(2).padStart(8)} │ ${cp.cumRegret.ucb.toFixed(2).padStart(8)} │ ${cp.cumRegret.thompson.toFixed(2).padStart(8)} │`);
    }
    console.log('  └─────────┴─────────┴──────────┴──────────┴──────────┘');

    // 収束判定: 各手法が何サンプルで Fixed を下回ったか
    console.log('\n  Sample where method crosses below Fixed (cumRegret < Fixed):');
    for (const method of ['qlearn', 'ucb', 'thompson'] as const) {
      let crossed = -1;
      for (const cp of checkpoints) {
        if (cp.cumRegret[method] < cp.cumRegret.fixed) { crossed = cp.samples; break; }
      }
      console.log(`    ${method.padEnd(10)}: ${crossed > 0 ? `crossed at ${crossed} samples ✅` : `not crossed within ${TOTAL_STEPS} samples ❌ (→ analyze_complexity.py で推定)`}`);
    }

    // Empirical Observation 1 の累積
    console.log('\n  Empirical Observation 1 (sample to beat Fixed):');
    console.log('    Weight (0002E.3)  : ~0 (adaptive weight 即時有効)');
    console.log('    State (0003A)     : ~6 (baseline 後)');
    console.log('    Policy (0003C)    : >24 (not crossed)');
    console.log('    Bandit (0003C.1)  : >60 (not crossed)');
    console.log('    Bandit (0003C.2)  : 120 steps 実測済み → フィットで N* 推定');

    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0003C.2/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0003C.2',
      description: 'Sample Complexity Estimation — raw regret series for curve fitting',
      timestamp: new Date().toISOString(),
      config: {
        total_steps: TOTAL_STEPS, checkpoints: CHECKPOINTS, series_every: SERIES_EVERY,
        phases: PHASES.map(p => p.name), eta: ETA, epsilon: EPSILON, ucb_c: UCB_C,
        reward: REWARD, fixed_w: FIXED_W,
      },
      experts: expertNodes.map(n => ({ node_id: n.nodeId, model_id: n.modelId, family: n.family })),
      checkpoints,
      series,
      final_ucb: { q: ucbQ.map(v => Math.round(v * 1000) / 1000), n: ucbN },
      final_thompson: { alpha: thAlpha.map(v => Math.round(v * 1000) / 1000), beta: thBeta.map(v => Math.round(v * 1000) / 1000) },
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

function gaussian(): number {
  // Box-Muller
  const u1 = Math.random(), u2 = Math.random();
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, u1))) * Math.cos(2 * Math.PI * u2);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
