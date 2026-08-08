#!/usr/bin/env npx tsx
/**
 * EXP-0003C.4 — LinUCB (Contextual Bandit with Continuous Features)
 *
 * 0003C.3 の結果 (シャドウ実行で UCB gap 94% 解消、残差 0.60) を受けて、
 * 「残差 = 重みキャリブレーション (Fixed lat weight 0.20 vs reward 0.10)」を
 * LinUCB の特徴量学習でどこまで縮められるかを検証する。
 *
 * Observation → State → Belief → Confidence → Feature Vector → LinUCB → Routing
 * の統一パイプライン (論文 Figure 2 相当)。
 *
 * フィーチャベクトル (7次元 + バイアス = 8次元):
 *   x = [ 1, capability, latency, cost, stability, confidence, memory, temperature ]
 *     - capability  : 信念平均 μ (タスク別)
 *     - latency     : 1 - lat/maxLat (正規化, 大きいほど良い)
 *     - cost        : 1 - params/maxParams
 *     - stability   : 状態安定度 (観測プラットフォーム)
 *     - confidence  : 信念信頼度 1-exp(-n/8) (EXP-0002D.1 由来)
 *     - memory      : 静的属性 (設定値, fp16 メモリ見積り)
 *     - temperature : 静的属性 (設定値, 実運用で測定対象)
 *
 * 手法 (4):
 *   ① Fixed            : 手設計 composite + Belief (フル情報, ベースライン)
 *   ② UCB Shadow       : 0003C.3 の参照点 (gap=0.60)
 *   ③ LinUCB Partial   : 選択アームのみ更新 (特徴量学習, 部分フィードバック)
 *   ④ LinUCB Shadow    : 全アーム更新 (特徴量学習 + フル情報) ← 処置
 *
 * LinUCB (Li et al. 2010, disjoint):
 *   θ_a = A_a^{-1} b_a,  A_a = λI + Σ x x^T,  b_a = Σ r x
 *   選択: argmax_a θ_a^T x_{t,a} + α sqrt(x^T A_a^{-1} x)
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0003C.4/run_master.ts --port 8080
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

const TOTAL_STEPS = 120;
const CHECKPOINTS = [24, 60, 100, 120];
const SERIES_EVERY = 5;
const STEPS_PER_PHASE = 20;

const UCB_C = 2.0;
const FEAT_DIM = 8;            // [1, cap, lat, cost, stab, conf, mem, temp]
const LAMBDA = 1.0;            // LinUCB 正則化
const LINUCB_ALPHA = 0.3;      // LinUCB 探索係数

const PHASES: { name: string; inject: { type: 'latency' | 'capability'; node: string; factor: number } | null }[] = [
  { name: 'baseline', inject: null },
  { name: 'latency', inject: { type: 'latency', node: 'node-smollm', factor: 3.0 } },
  { name: 'capjump', inject: { type: 'capability', node: 'node-gemma', factor: 0.5 } },
];

const PARAMS_M: Record<string, number> = { qwen: 596, smollm: 362, gemma: 1000 };

// 静的ノード属性 (設定値; memory は fp16 メモリ見積り[GB], temperature は実運用で測定対象)
const NODE_ATTRS: Record<string, { memory: number; temperature: number }> = {
  qwen: { memory: 1.2, temperature: 0.5 },
  smollm: { memory: 0.7, temperature: 0.7 },
  gemma: { memory: 2.0, temperature: 0.6 },
};

const REWARD = { q: 1.0, lat: 0.10, cost: 0.10, stab: 0.10 };
const FIXED_W = { q: 0.60, lat: 0.20, cost: 0.05, stab: 0.15 };

const METHODS = ['fixed', 'ucb_shadow', 'linucb_partial', 'linucb_shadow'];

// ═══════════════════════════════════════════════════════════════════════════════
// Linear Algebra (8x8)
// ═══════════════════════════════════════════════════════════════════════════════

function matVec(A: number[][], v: number[]): number[] {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
}

function matInv(A: number[][]): number[][] {
  const n = A.length;
  // Gauss-Jordan with partial pivoting
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    // pivot
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) continue;
    if (piv !== col) { const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp; }
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (Math.abs(f) < 1e-15) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row.slice(n));
}

// ═══════════════════════════════════════════════════════════════════════════════
// LinUCB (disjoint)
// ═══════════════════════════════════════════════════════════════════════════════

class LinUCB {
  d: number; alpha: number;
  A: number[][]; b: number[]; theta: number[];

  constructor(d: number, alpha: number, lambda = 1.0) {
    this.d = d; this.alpha = alpha;
    this.A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? lambda : 0)));
    this.b = Array(d).fill(0);
    this.theta = Array(d).fill(0);
  }

  score(x: number[]): number {
    const mu = this.theta.reduce((s, t, i) => s + t * x[i], 0);
    const Ainv = matInv(this.A);
    const xTAx = x.reduce((s, xi, i) => s + xi * Ainv[i].reduce((ss, aij, j) => ss + aij * x[j], 0), 0);
    return mu + this.alpha * Math.sqrt(Math.max(0, xTAx));
  }

  update(x: number[], r: number): void {
    for (let i = 0; i < this.d; i++) {
      for (let j = 0; j < this.d; j++) this.A[i][j] += x[i] * x[j];
      this.b[i] += r * x[i];
    }
    this.theta = matVec(matInv(this.A), this.b);
  }
}

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
  console.log('EXP-0003C.4 — LinUCB (Contextual Bandit, 7-dim features)');
  console.log('═'.repeat(60));
  console.log('  x = [1, capability, latency, cost, stability, confidence, memory, temperature]');
  console.log('  Methods: Fixed | UCB-S | LinUCB-P | LinUCB-S');
  console.log(`  Samples: ${TOTAL_STEPS} steps, series every ${SERIES_EVERY}`);
  console.log('  Goal: 残差 0.60 (重みキャリブレーション) を LinUCB が縮められるか検証\n');

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
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0003C.4' }));
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
    console.log('EXPERIMENT — LinUCB: 7-dim features × {Partial, Shadow}');
    console.log('═'.repeat(60));

    const expertNodes = [...nodes.values()];
    console.log(`\n  Experts (${expertNodes.length}):`);
    for (const n of expertNodes) console.log(`    ${n.nodeId} — ${n.modelId} (${PARAMS_M[n.family] ?? 500}M)`);
    const nodeIds = expertNodes.map(n => n.nodeId);

    // 状態推定 (Belief + Confidence)
    const state: Record<string, { cap: Record<string, Belief>; lat: { ema: number; n: number }; stab: number }> = {};
    for (const n of expertNodes) {
      state[n.nodeId] = { cap: { coding: createBelief(), math: createBelief() }, lat: { ema: 0, n: 0 }, stab: 1.0 };
    }

    // UCB Shadow (0003C.3 参照)
    const ucbS_Q: number[] = nodeIds.map(() => 0.0); const ucbS_N: number[] = nodeIds.map(() => 0);
    // LinUCB (partial / shadow) — アーム毎に disjoint
    const linP: Map<string, LinUCB> = new Map(nodeIds.map(id => [id, new LinUCB(FEAT_DIM, LINUCB_ALPHA, LAMBDA)]));
    const linS: Map<string, LinUCB> = new Map(nodeIds.map(id => [id, new LinUCB(FEAT_DIM, LINUCB_ALPHA, LAMBDA)]));

    const cumRegret: Record<string, number> = { fixed: 0, ucb_shadow: 0, linucb_partial: 0, linucb_shadow: 0 };
    const checkpoints: CheckpointRecord[] = [];
    const series: CheckpointRecord[] = [];

    // 特徴量構築
    const buildFeatures = (nodeId: string, task: string): number[] => {
      const st = state[nodeId];
      const n = expertNodes.find(x => x.nodeId === nodeId)!;
      const lat = injectedLat[nodeId];
      const maxLat = Math.max(...nodeIds.map(id => injectedLat[id]), 1);
      const maxParams = Math.max(...expertNodes.map(x => PARAMS_M[x.family] ?? 500));
      const attrs = NODE_ATTRS[n.family] ?? { memory: 1.0, temperature: 0.6 };
      const maxMem = 2.0, maxTemp = 1.0;
      return [
        1,                                  // bias
        st.cap[task].mu,                    // capability (belief mean)
        1 - lat / maxLat,                   // latency (正規化, 大=良い)
        1 - (PARAMS_M[n.family] ?? 500) / maxParams, // cost (大=安い)
        st.stab,                            // stability
        st.cap[task].confidence,            // confidence (0002D.1)
        1 - attrs.memory / maxMem,          // memory (静的属性)
        1 - attrs.temperature / maxTemp,    // temperature (静的属性)
      ];
    };

    let injectedLat: Record<string, number> = {};
    let step = 0;

    for (let s = 0; s < TOTAL_STEPS; s++) {
      const ph = PHASES[Math.floor(s / STEPS_PER_PHASE) % PHASES.length];
      const task = s % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(s / 2) % 8];
      step++;
      const rid = `${ph.name[0].toUpperCase()}-${String(step).padStart(3, '0')}`;

      // 推論 + 注入 (オラクル = シャドウ評価)
      const trueScores: Record<string, number> = {};
      injectedLat = {};
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

      const maxLat = Math.max(...nodeIds.map(id => injectedLat[id]), 1);
      const maxParams = Math.max(...expertNodes.map(n => PARAMS_M[n.family] ?? 500));

      // 全ノードの報酬 (シャドウ評価)
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

      // ── ② UCB Shadow (参照) ──
      const t = step;
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

      // ── ③ LinUCB Partial (選択アームのみ更新) ──
      let linPBest: string | null = null, linPScore = -Infinity;
      for (const n of expertNodes) {
        const score = linP.get(n.nodeId)!.score(buildFeatures(n.nodeId, task));
        if (score > linPScore) { linPScore = score; linPBest = n.nodeId; }
      }
      linP.get(linPBest!)!.update(buildFeatures(linPBest!, task), rewardAll[linPBest!]);

      // ── ④ LinUCB Shadow (全アーム更新) ──
      let linSBest: string | null = null, linSScore = -Infinity;
      for (const n of expertNodes) {
        const score = linS.get(n.nodeId)!.score(buildFeatures(n.nodeId, task));
        if (score > linSScore) { linSScore = score; linSBest = n.nodeId; }
      }
      for (const n of expertNodes) {
        linS.get(n.nodeId)!.update(buildFeatures(n.nodeId, task), rewardAll[n.nodeId]);
      }

      // Regret 更新 (Quality 基準)
      cumRegret.fixed += Math.max(0, trueScores[oracle] - trueScores[fixedBest!]);
      cumRegret.ucb_shadow += Math.max(0, trueScores[oracle] - trueScores[ucbSBest!]);
      cumRegret.linucb_partial += Math.max(0, trueScores[oracle] - trueScores[linPBest!]);
      cumRegret.linucb_shadow += Math.max(0, trueScores[oracle] - trueScores[linSBest!]);

      // series + checkpoints
      if (step % SERIES_EVERY === 0 || CHECKPOINTS.includes(step)) {
        series.push({ samples: step, cumRegret: { ...cumRegret } });
      }
      if (CHECKPOINTS.includes(step)) {
        checkpoints.push({ samples: step, cumRegret: { ...cumRegret } });
      }

      if (step % 10 === 0 || step <= 3) {
        console.log(`  [${rid}] ${ph.name.padEnd(8)} ${task} | F=${fixedBest!} U=${ucbSBest!} Lp=${linPBest!} Ls=${linSBest!} | cumRegret F=${cumRegret.fixed.toFixed(2)} U=${cumRegret.ucb_shadow.toFixed(2)} Lp=${cumRegret.linucb_partial.toFixed(2)} Ls=${cumRegret.linucb_shadow.toFixed(2)}`);
      }
    }

    // ── Results ────────────────────────────────────────────────────────────
    console.log('\n═'.repeat(60));
    console.log('RESULTS — LinUCB: 7-dim features × {Partial, Shadow}');
    console.log('═'.repeat(60));

    console.log('\n  Cumulative Regret at checkpoints:');
    console.log('  ┌─────────┬─────────┬─────────┬───────────┬───────────┐');
    console.log('  │ Samples │ Fixed   │ UCB-S   │ LinUCB-P  │ LinUCB-S  │');
    console.log('  ├─────────┼─────────┼─────────┼───────────┼───────────┤');
    for (const cp of checkpoints) {
      const cr = cp.cumRegret;
      console.log(`  │ ${String(cp.samples).padStart(7)} │ ${cr.fixed.toFixed(2).padStart(7)} │ ${cr.ucb_shadow.toFixed(2).padStart(7)} │ ${cr.linucb_partial.toFixed(2).padStart(9)} │ ${cr.linucb_shadow.toFixed(2).padStart(9)} │`);
    }
    console.log('  └─────────┴─────────┴─────────┴───────────┴───────────┘');

    // Shadow 効果 + LinUCB 効果
    console.log('\n  Gap to Fixed @120:');
    for (const m of ['ucb_shadow', 'linucb_partial', 'linucb_shadow']) {
      console.log(`    ${m.padEnd(18)}: gap=${(cumRegret[m] - cumRegret.fixed).toFixed(2)}`);
    }

    // 学習された重み (LinUCB Shadow)
    console.log('\n  Learned theta (LinUCB Shadow, final):');
    const FEAT_NAMES = ['bias', 'capability', 'latency', 'cost', 'stability', 'confidence', 'memory', 'temperature'];
    for (const n of expertNodes) {
      const th = linS.get(n.nodeId)!.theta;
      const round3 = th.map(v => Math.round(v * 1000) / 1000);
      console.log(`    ${n.nodeId.padEnd(12)}: [${FEAT_NAMES.map((f, i) => `${f}=${round3[i]}`).join(', ')}]`);
    }

    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0003C.4/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0003C.4',
      description: 'LinUCB — Contextual Bandit with 7-dim features (capability/latency/cost/stability/confidence/memory/temperature)',
      timestamp: new Date().toISOString(),
      config: {
        total_steps: TOTAL_STEPS, checkpoints: CHECKPOINTS, series_every: SERIES_EVERY,
        phases: PHASES.map(p => p.name), ucb_c: UCB_C,
        feat_dim: FEAT_DIM, lambda: LAMBDA, linucb_alpha: LINUCB_ALPHA,
        reward: REWARD, fixed_w: FIXED_W, methods: METHODS,
        node_attrs: NODE_ATTRS,
        feature_names: FEAT_NAMES,
      },
      experts: expertNodes.map(n => ({ node_id: n.nodeId, model_id: n.modelId, family: n.family })),
      checkpoints,
      series,
      learned_theta_shadow: Object.fromEntries(nodeIds.map(id => [id, linS.get(id)!.theta.map(v => Math.round(v * 1000) / 1000)])),
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

