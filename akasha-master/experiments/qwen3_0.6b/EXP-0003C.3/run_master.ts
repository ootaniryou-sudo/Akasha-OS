#!/usr/bin/env npx tsx
/**
 * EXP-0003C.3 — Shadow Feedback (Full-Information Bandit)
 *
 * 0003C.2 で発見した「フィードバック非対称性」の仮説を直接検証する:
 *
 *   Fixed   : フル情報 (オラクル計算で全ノードの結果を毎ステップ観測)
 *   バンディット: 部分フィードバック (選択アームのみ)
 *
 * この実験では、Shadow (EXP-0002F のシャドウ実行) によって
 * バンディット学習器にも「全アームの報酬」を与える (Full Information 化)。
 * 同じアルゴリズムでフィードバック構造だけを変え、Fixed へのギャップが
 * 閉じるかを測る。
 *
 * 2×2 デザイン: Algorithm {UCB, Thompson} × Feedback {Partial, Shadow}
 *
 *   ① Fixed             : ベースライン (フル情報 Belief)
 *   ② UCB Partial       : 選択アームのみ更新 (0003C.2 の再現)
 *   ③ UCB Shadow        : 全アームを更新 (フル情報化) ← 処置
 *   ④ Thompson Partial  : 選択アームのみ更新
 *   ⑤ Thompson Shadow   : 全アームを更新 (フル情報化) ← 処置
 *
 * 仮説 (Empirical Observation 2 の検証):
 *   Shadow Feedback は部分フィードバックより少ないサンプルで Fixed に近づく。
 *   つまり 0003C.2 の「Fixed の勝因」の一部は報酬情報量であり、
 *   シャドウ実行で学習器にも同量の情報を与えればギャップが縮小する。
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0003C.3/run_master.ts --port 8080
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

const METHODS = ['fixed', 'ucb_partial', 'ucb_shadow', 'thompson_partial', 'thompson_shadow'];

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
  console.log('EXP-0003C.3 — Shadow Feedback (Full-Information Bandit)');
  console.log('═'.repeat(60));
  console.log('  2×2 design: Algorithm {UCB, Thompson} × Feedback {Partial, Shadow}');
  console.log('  Methods: Fixed | UCB-P | UCB-S | Thm-P | Thm-S');
  console.log(`  Samples: ${TOTAL_STEPS} steps, series every ${SERIES_EVERY}`);
  console.log('  Goal: シャドウ実行 (フル情報化) が Fixed へのギャップを閉じるか検証\n');

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
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0003C.3' }));
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
    console.log('EXPERIMENT — Shadow Feedback: 2×2 (Partial vs Shadow)');
    console.log('═'.repeat(60));

    const expertNodes = [...nodes.values()];
    console.log(`\n  Experts (${expertNodes.length}):`);
    for (const n of expertNodes) console.log(`    ${n.nodeId} — ${n.modelId} (${PARAMS_M[n.family] ?? 500}M)`);
    const nodeIds = expertNodes.map(n => n.nodeId);

    // 状態推定 (Fixed の Belief 用)
    const state: Record<string, { cap: Record<string, Belief>; lat: { ema: number; n: number }; stab: number }> = {};
    for (const n of expertNodes) {
      state[n.nodeId] = { cap: { coding: createBelief(), math: createBelief() }, lat: { ema: 0, n: 0 }, stab: 1.0 };
    }

    // UCB: Q̄[a], n[a] — partial / shadow
    const ucbP_Q: number[] = nodeIds.map(() => 0.0); const ucbP_N: number[] = nodeIds.map(() => 0);
    const ucbS_Q: number[] = nodeIds.map(() => 0.0); const ucbS_N: number[] = nodeIds.map(() => 0);
    // Thompson: Beta(α,β) — partial / shadow
    const thP_A: number[] = nodeIds.map(() => 1.0); const thP_B: number[] = nodeIds.map(() => 1.0);
    const thS_A: number[] = nodeIds.map(() => 1.0); const thS_B: number[] = nodeIds.map(() => 1.0);

    const cumRegret: Record<string, number> = { fixed: 0, ucb_partial: 0, ucb_shadow: 0, thompson_partial: 0, thompson_shadow: 0 };
    const checkpoints: CheckpointRecord[] = [];
    const series: CheckpointRecord[] = [];

    let step = 0;

    for (let s = 0; s < TOTAL_STEPS; s++) {
      const ph = PHASES[Math.floor(s / STEPS_PER_PHASE) % PHASES.length];
      const task = s % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(s / 2) % 8];
      step++;
      const rid = `${ph.name[0].toUpperCase()}-${String(step).padStart(3, '0')}`;

      // 推論 + 注入 (オラクル = 全ノード実行 = シャドウ評価に相当)
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

      // 離散状態 (Fixed の composite と報酬の安定度用)
      const lats = nodeIds.map(id => injectedLat[id] || 1);
      const sorted = [...lats].sort((a, b) => a - b);
      const medianLat = sorted[Math.floor(sorted.length / 2)] || 1;
      const latAnomaly = (Math.max(...lats) / Math.max(1, medianLat)) > 1.5 ? 1 : 0;
      const capAnomaly = nodeIds.some(id => state[id].cap[task].mu < 0.5) ? 1 : 0;
      void latAnomaly; void capAnomaly;

      const maxLat = Math.max(...nodeIds.map(id => injectedLat[id]), 1);
      const maxParams = Math.max(...expertNodes.map(n => PARAMS_M[n.family] ?? 500));

      // 全ノードの報酬 (シャドウ評価で毎ステップ利用可能)
      const rewardAll: Record<string, number> = {};
      for (const n of expertNodes) {
        rewardAll[n.nodeId] = REWARD.q * trueScores[n.nodeId]
          + REWARD.lat * (1 - injectedLat[n.nodeId] / maxLat)
          + REWARD.cost * (1 - PARAMS_M[n.family] / maxParams)
          + REWARD.stab * state[n.nodeId].stab;
      }

      // ── ① Fixed (手設計, フル情報 Belief) ──
      let fixedBest: string | null = null, fixedScore = -Infinity;
      for (const n of expertNodes) {
        const st = state[n.nodeId];
        const comp = FIXED_W.q * (st.cap[task].effective || 0.5)
          + FIXED_W.lat * (1 - injectedLat[n.nodeId] / maxLat)
          + FIXED_W.cost * (1 - PARAMS_M[n.family] / maxParams)
          + FIXED_W.stab * st.stab;
        if (comp > fixedScore) { fixedScore = comp; fixedBest = n.nodeId; }
      }

      // ── ② UCB Partial (選択アームのみ更新) ──
      const t = step;
      let ucbPBest: string | null = null, ucbPScore = -Infinity;
      for (const n of expertNodes) {
        const a = nodeIds.indexOf(n.nodeId);
        const score = ucbP_N[a] === 0 ? Infinity : ucbP_Q[a] + Math.sqrt(UCB_C * Math.log(t + 1) / ucbP_N[a]);
        if (score > ucbPScore) { ucbPScore = score; ucbPBest = n.nodeId; }
      }
      {
        const a = nodeIds.indexOf(ucbPBest!);
        const r = rewardAll[ucbPBest!];
        ucbP_Q[a] = (ucbP_Q[a] * ucbP_N[a] + r) / (ucbP_N[a] + 1);
        ucbP_N[a]++;
      }

      // ── ③ UCB Shadow (全アーム更新 = フル情報化) ──
      let ucbSBest: string | null = null, ucbSScore = -Infinity;
      for (const n of expertNodes) {
        const a = nodeIds.indexOf(n.nodeId);
        const score = ucbS_N[a] === 0 ? Infinity : ucbS_Q[a] + Math.sqrt(UCB_C * Math.log(t + 1) / ucbS_N[a]);
        if (score > ucbSScore) { ucbSScore = score; ucbSBest = n.nodeId; }
      }
      for (const n of expertNodes) {
        const a = nodeIds.indexOf(n.nodeId);
        const r = rewardAll[n.nodeId];
        ucbS_Q[a] = (ucbS_Q[a] * ucbS_N[a] + r) / (ucbS_N[a] + 1);
        ucbS_N[a]++;
      }

      // ── ④ Thompson Partial ──
      let thPBest: string | null = null, thPScore = -Infinity;
      for (const n of expertNodes) {
        const a = nodeIds.indexOf(n.nodeId);
        const mu = thP_A[a] / (thP_A[a] + thP_B[a]);
        const varr = (thP_A[a] * thP_B[a]) / ((thP_A[a] + thP_B[a]) ** 2 * (thP_A[a] + thP_B[a] + 1));
        const sample = mu + Math.sqrt(Math.max(0, varr)) * gaussian();
        if (sample > thPScore) { thPScore = sample; thPBest = n.nodeId; }
      }
      {
        const a = nodeIds.indexOf(thPBest!);
        const r = rewardAll[thPBest!];
        thP_A[a] += r; thP_B[a] += (1 - r);
      }

      // ── ⑤ Thompson Shadow (全アーム更新) ──
      let thSBest: string | null = null, thSScore = -Infinity;
      for (const n of expertNodes) {
        const a = nodeIds.indexOf(n.nodeId);
        const mu = thS_A[a] / (thS_A[a] + thS_B[a]);
        const varr = (thS_A[a] * thS_B[a]) / ((thS_A[a] + thS_B[a]) ** 2 * (thS_A[a] + thS_B[a] + 1));
        const sample = mu + Math.sqrt(Math.max(0, varr)) * gaussian();
        if (sample > thSScore) { thSScore = sample; thSBest = n.nodeId; }
      }
      for (const n of expertNodes) {
        const a = nodeIds.indexOf(n.nodeId);
        const r = rewardAll[n.nodeId];
        thS_A[a] += r; thS_B[a] += (1 - r);
      }

      // Regret 更新 (Quality 基準)
      cumRegret.fixed += Math.max(0, trueScores[oracle] - trueScores[fixedBest!]);
      cumRegret.ucb_partial += Math.max(0, trueScores[oracle] - trueScores[ucbPBest!]);
      cumRegret.ucb_shadow += Math.max(0, trueScores[oracle] - trueScores[ucbSBest!]);
      cumRegret.thompson_partial += Math.max(0, trueScores[oracle] - trueScores[thPBest!]);
      cumRegret.thompson_shadow += Math.max(0, trueScores[oracle] - trueScores[thSBest!]);

      // フィット用 series + チェックポイント
      if (step % SERIES_EVERY === 0 || CHECKPOINTS.includes(step)) {
        series.push({ samples: step, cumRegret: { ...cumRegret } });
      }
      if (CHECKPOINTS.includes(step)) {
        checkpoints.push({ samples: step, cumRegret: { ...cumRegret } });
      }

      if (step % 10 === 0 || step <= 3) {
        console.log(`  [${rid}] ${ph.name.padEnd(8)} ${task} | F=${fixedBest!} Up=${ucbPBest!} Us=${ucbSBest!} Tp=${thPBest!} Ts=${thSBest!} | cumRegret F=${cumRegret.fixed.toFixed(2)} Up=${cumRegret.ucb_partial.toFixed(2)} Us=${cumRegret.ucb_shadow.toFixed(2)} Tp=${cumRegret.thompson_partial.toFixed(2)} Ts=${cumRegret.thompson_shadow.toFixed(2)}`);
      }
    }

    // ── Results ────────────────────────────────────────────────────────────
    console.log('\n═'.repeat(60));
    console.log('RESULTS — Shadow Feedback: 2×2 (Partial vs Shadow)');
    console.log('═'.repeat(60));

    console.log('\n  Cumulative Regret at checkpoints:');
    console.log('  ┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐');
    console.log('  │ Samples │ Fixed   │ UCB-P   │ UCB-S   │ Thm-P   │ Thm-S   │');
    console.log('  ├─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤');
    for (const cp of checkpoints) {
      const cr = cp.cumRegret;
      console.log(`  │ ${String(cp.samples).padStart(7)} │ ${cr.fixed.toFixed(2).padStart(7)} │ ${cr.ucb_partial.toFixed(2).padStart(7)} │ ${cr.ucb_shadow.toFixed(2).padStart(7)} │ ${cr.thompson_partial.toFixed(2).padStart(7)} │ ${cr.thompson_shadow.toFixed(2).padStart(7)} │`);
    }
    console.log('  └─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘');

    // 収束判定
    console.log('\n  Sample where method crosses below Fixed (cumRegret < Fixed):');
    for (const method of ['ucb_partial', 'ucb_shadow', 'thompson_partial', 'thompson_shadow']) {
      let crossed = -1;
      for (const cp of checkpoints) {
        if (cp.cumRegret[method] < cp.cumRegret.fixed) { crossed = cp.samples; break; }
      }
      console.log(`    ${method.padEnd(18)}: ${crossed > 0 ? `crossed at ${crossed} samples ✅` : `not crossed within ${TOTAL_STEPS} samples ❌ (→ analyze で推定)`}`);
    }

    // Shadow 効果の要約
    console.log('\n  Shadow effect @120 (Fixed との差):');
    for (const [p, s] of [['ucb_partial', 'ucb_shadow'], ['thompson_partial', 'thompson_shadow']] as const) {
      const gapP = cumRegret[p] - cumRegret.fixed;
      const gapS = cumRegret[s] - cumRegret.fixed;
      const closing = (1 - gapS / Math.max(1e-9, gapP)) * 100;
      console.log(`    ${p.replace('_', '/').padEnd(20)}: gap=${gapP.toFixed(2)} → ${s.replace('_', '/')}: gap=${gapS.toFixed(2)}  (closing ${closing.toFixed(0)}%)`);
    }

    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0003C.3/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0003C.3',
      description: 'Shadow Feedback — Full-Information Bandit (2×2: algorithm × feedback)',
      timestamp: new Date().toISOString(),
      config: {
        total_steps: TOTAL_STEPS, checkpoints: CHECKPOINTS, series_every: SERIES_EVERY,
        phases: PHASES.map(p => p.name), ucb_c: UCB_C,
        reward: REWARD, fixed_w: FIXED_W, methods: METHODS,
        design: '2×2: Algorithm {UCB, Thompson} × Feedback {Partial, Shadow}',
      },
      experts: expertNodes.map(n => ({ node_id: n.nodeId, model_id: n.modelId, family: n.family })),
      checkpoints,
      series,
      final_ucb_shadow: { q: ucbS_Q.map(v => Math.round(v * 1000) / 1000), n: ucbS_N },
      final_thompson_shadow: { alpha: thS_A.map(v => Math.round(v * 1000) / 1000), beta: thS_B.map(v => Math.round(v * 1000) / 1000) },
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
