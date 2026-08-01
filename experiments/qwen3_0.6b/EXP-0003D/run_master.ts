#!/usr/bin/env npx tsx
/**
 * EXP-0003D — Statistical Validation (multi-seed)
 *
 * 0003C.2→C.3→C.4 の結論 (LinUCB-Shadow が Fixed を上回る, gap=-0.40) が
 * 「偶然ではない」ことを統計的に検証する。
 *
 * 実験の決定論性について:
 *   - LLM 生成は温度 0 で決定論的 (同一プロンプト → 同一出力)
 *   - UCB / LinUCB の選択も決定論的 (乱数なし)
 *   - したがって「シード」はワークロードの乱数化として導入する:
 *     (a) タスク順序 (coding/math を 0.5/0.5 でランダム)
 *     (b) プロンプト選択 (プールからランダム)
 *     (c) 初期アーム順 (タイブレークの決定論を乱数化)
 *   - これにより各シードで異なるワークロード系列になり、regret がばらつく。
 *
 * LLM 出力キャッシュ:
 *   - 生成が決定論的なため、 (node, prompt) の評価結果 (score, latency) を
 *     キャッシュできる。48 ペア (3ノード×16プロンプト) を一度だけ推論し、
 *     残りのシードはキャッシュから参照する → 10 シードが数分で実行可能。
 *
 * 統計 (analyze_statistics.py で実施):
 *   - 各手法: mean, std, 95% CI (t 分布)
 *   - 対応あり Wilcoxon signed-rank (各学習器 vs Fixed)
 *   - 効果量: Cohen's d (paired), Cliff's delta
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0003D/run_master.ts --port 8080 --seeds 10
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

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const port = parseInt(getArg('--port', '8080'), 10);
const SEEDS = parseInt(getArg('--seeds', '10'), 10);
const SEED_BASE = parseInt(getArg('--seed-base', '42'), 10);
const TOTAL_STEPS = 120;
const CHECKPOINTS = [24, 60, 100, 120];
const STEPS_PER_PHASE = 20;

const UCB_C = 2.0;
const FEAT_DIM = 8;
const LAMBDA = 1.0;
const LINUCB_ALPHA = 0.3;

const PHASES: { name: string; inject: { type: 'latency' | 'capability'; node: string; factor: number } | null }[] = [
  { name: 'baseline', inject: null },
  { name: 'latency', inject: { type: 'latency', node: 'node-smollm', factor: 3.0 } },
  { name: 'capjump', inject: { type: 'capability', node: 'node-gemma', factor: 0.5 } },
];

const PARAMS_M: Record<string, number> = { qwen: 596, smollm: 362, gemma: 1000 };
const NODE_ATTRS: Record<string, { memory: number; temperature: number }> = {
  qwen: { memory: 1.2, temperature: 0.5 },
  smollm: { memory: 0.7, temperature: 0.7 },
  gemma: { memory: 2.0, temperature: 0.6 },
};

const REWARD = { q: 1.0, lat: 0.10, cost: 0.10, stab: 0.10 };
const FIXED_W = { q: 0.60, lat: 0.20, cost: 0.05, stab: 0.15 };

const METHODS = ['fixed', 'ucb_partial', 'ucb_shadow', 'linucb_partial', 'linucb_shadow'];

// ═══════════════════════════════════════════════════════════════════════════════
// Seeded RNG
// ═══════════════════════════════════════════════════════════════════════════════

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Linear Algebra + LinUCB
// ═══════════════════════════════════════════════════════════════════════════════

function matVec(A: number[][], v: number[]): number[] {
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
}

function matInv(A: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
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
// Main
// ═══════════════════════════════════════════════════════════════════════════════

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
  console.log('EXP-0003D — Statistical Validation (multi-seed)');
  console.log('═'.repeat(60));
  console.log(`  Seeds: ${SEEDS} (base ${SEED_BASE}), Steps: ${TOTAL_STEPS}`);
  console.log('  Methods: Fixed | UCB-P | UCB-S | LinUCB-P | LinUCB-S');
  console.log('  Seed = workload randomization (task order / prompt / initial order)');
  console.log('  LLM outputs cached (deterministic T=0) → fast multi-seed\n');

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
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0003D' }));
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
    console.log(`EXPERIMENT — ${SEEDS} seeds × ${TOTAL_STEPS} steps`);
    console.log('═'.repeat(60));

    const expertNodes = [...nodes.values()];
    const nodeIds = expertNodes.map(n => n.nodeId);
    console.log(`  Experts (${expertNodes.length}):`);
    for (const n of expertNodes) console.log(`    ${n.nodeId} — ${n.modelId} (${PARAMS_M[n.family] ?? 500}M)`);

    // 決定論的 LLM 出力キャッシュ: (node, prompt) → {score, latency}
    const cache = new Map<string, { score: number; latency: number }>();
    let cacheMiss = 0, cacheHit = 0;

    const evalNode = async (n: ConnectedNode, task: string, prompt: string): Promise<{ score: number; latency: number }> => {
      const key = `${n.nodeId}|${prompt}`;
      const hit = cache.get(key);
      if (hit) { cacheHit++; return hit; }
      const chat = n.family !== 'qwen';
      const res = await sendCompute(n.ws, `eval-${cacheMiss}-${n.nodeId}`, prompt, chat);
      const val = { score: evaluateTask(task, res.text), latency: res.timing.total_ms };
      cache.set(key, val);
      cacheMiss++;
      return val;
    };

    const seedsResult: { seed: number; regrets: Record<string, number>; checkpoints: CheckpointRecord[] }[] = [];

    for (let seed = 0; seed < SEEDS; seed++) {
      const rng = mulberry32(SEED_BASE + seed * 7919);
      const order = shuffle(nodeIds, rng); // タイブレーク用の初期アーム順
      console.log(`\n  ── seed ${seed} (order: ${order.join(', ')}) ──`);

      // 状態
      const state: Record<string, { cap: Record<string, Belief>; lat: { ema: number; n: number }; stab: number }> = {};
      for (const id of nodeIds) {
        state[id] = { cap: { coding: createBelief(), math: createBelief() }, lat: { ema: 0, n: 0 }, stab: 1.0 };
      }

      const ucbP_Q: number[] = nodeIds.map(() => 0.0); const ucbP_N: number[] = nodeIds.map(() => 0);
      const ucbS_Q: number[] = nodeIds.map(() => 0.0); const ucbS_N: number[] = nodeIds.map(() => 0);
      const linP: Map<string, LinUCB> = new Map(nodeIds.map(id => [id, new LinUCB(FEAT_DIM, LINUCB_ALPHA, LAMBDA)]));
      const linS: Map<string, LinUCB> = new Map(nodeIds.map(id => [id, new LinUCB(FEAT_DIM, LINUCB_ALPHA, LAMBDA)]));

      const cumRegret: Record<string, number> = { fixed: 0, ucb_partial: 0, ucb_shadow: 0, linucb_partial: 0, linucb_shadow: 0 };
      const checkpoints: CheckpointRecord[] = [];

      let injectedLat: Record<string, number> = {};

      const buildFeatures = (nodeId: string, task: string): number[] => {
        const st = state[nodeId];
        const n = expertNodes.find(x => x.nodeId === nodeId)!;
        const maxLat = Math.max(...nodeIds.map(id => injectedLat[id]), 1);
        const maxParams = Math.max(...expertNodes.map(x => PARAMS_M[x.family] ?? 500));
        const attrs = NODE_ATTRS[n.family] ?? { memory: 1.0, temperature: 0.6 };
        return [
          1,
          st.cap[task].mu,
          1 - injectedLat[nodeId] / maxLat,
          1 - (PARAMS_M[n.family] ?? 500) / maxParams,
          st.stab,
          st.cap[task].confidence,
          1 - attrs.memory / 2.0,
          1 - attrs.temperature / 1.0,
        ];
      };

      for (let s = 0; s < TOTAL_STEPS; s++) {
        const ph = PHASES[Math.floor(s / STEPS_PER_PHASE) % PHASES.length];
        const task = rng() < 0.5 ? 'coding' : 'math';
        const pool = task === 'coding' ? codingPrompts : mathPrompts;
        const p = pool[Math.floor(rng() * pool.length)];
        const step = s + 1;

        // 全ノード評価 (キャッシュ)
        const trueScores: Record<string, number> = {};
        injectedLat = {};
        for (const n of expertNodes) {
          const raw = await evalNode(n, task, p.prompt);
          let score = raw.score;
          if (ph.inject?.type === 'capability' && ph.inject.node === n.nodeId) {
            score = Math.round(score * ph.inject.factor * 1000) / 1000;
          }
          trueScores[n.nodeId] = score;
          let lat = raw.latency;
          if (ph.inject?.type === 'latency' && ph.inject.node === n.nodeId) {
            lat = Math.round(lat * ph.inject.factor);
          }
          injectedLat[n.nodeId] = lat;
        }

        const oracle = Object.entries(trueScores).sort((a, b) => b[1] - a[1])[0][0];

        for (const n of expertNodes) {
          state[n.nodeId].cap[task] = updateBelief(state[n.nodeId].cap[task], trueScores[n.nodeId]);
          state[n.nodeId].lat = updateEMA(state[n.nodeId].lat, injectedLat[n.nodeId]);
        }

        const maxLat = Math.max(...nodeIds.map(id => injectedLat[id]), 1);
        const maxParams = Math.max(...expertNodes.map(n => PARAMS_M[n.family] ?? 500));

        const rewardAll: Record<string, number> = {};
        for (const n of expertNodes) {
          rewardAll[n.nodeId] = REWARD.q * trueScores[n.nodeId]
            + REWARD.lat * (1 - injectedLat[n.nodeId] / maxLat)
            + REWARD.cost * (1 - PARAMS_M[n.family] / maxParams)
            + REWARD.stab * state[n.nodeId].stab;
        }

        // ① Fixed
        let fixedBest: string | null = null, fixedScore = -Infinity;
        for (const id of order) {
          const st = state[id];
          const comp = FIXED_W.q * (st.cap[task].effective || 0.5)
            + FIXED_W.lat * (1 - injectedLat[id] / maxLat)
            + FIXED_W.cost * (1 - PARAMS_M[expertNodes.find(x => x.nodeId === id)!.family] / maxParams)
            + FIXED_W.stab * st.stab;
          if (comp > fixedScore) { fixedScore = comp; fixedBest = id; }
        }

        // ② UCB Partial
        let ucbPBest: string | null = null, ucbPScore = -Infinity;
        for (const id of order) {
          const a = nodeIds.indexOf(id);
          const score = ucbP_N[a] === 0 ? Infinity : ucbP_Q[a] + Math.sqrt(UCB_C * Math.log(step + 1) / ucbP_N[a]);
          if (score > ucbPScore) { ucbPScore = score; ucbPBest = id; }
        }
        { const a = nodeIds.indexOf(ucbPBest!); const r = rewardAll[ucbPBest!];
          ucbP_Q[a] = (ucbP_Q[a] * ucbP_N[a] + r) / (ucbP_N[a] + 1); ucbP_N[a]++; }

        // ③ UCB Shadow
        let ucbSBest: string | null = null, ucbSScore = -Infinity;
        for (const id of order) {
          const a = nodeIds.indexOf(id);
          const score = ucbS_N[a] === 0 ? Infinity : ucbS_Q[a] + Math.sqrt(UCB_C * Math.log(step + 1) / ucbS_N[a]);
          if (score > ucbSScore) { ucbSScore = score; ucbSBest = id; }
        }
        for (const id of nodeIds) {
          const a = nodeIds.indexOf(id); const r = rewardAll[id];
          ucbS_Q[a] = (ucbS_Q[a] * ucbS_N[a] + r) / (ucbS_N[a] + 1); ucbS_N[a]++;
        }

        // ④ LinUCB Partial
        let linPBest: string | null = null, linPScore = -Infinity;
        for (const id of order) {
          const score = linP.get(id)!.score(buildFeatures(id, task));
          if (score > linPScore) { linPScore = score; linPBest = id; }
        }
        linP.get(linPBest!)!.update(buildFeatures(linPBest!, task), rewardAll[linPBest!]);

        // ⑤ LinUCB Shadow
        let linSBest: string | null = null, linSScore = -Infinity;
        for (const id of order) {
          const score = linS.get(id)!.score(buildFeatures(id, task));
          if (score > linSScore) { linSScore = score; linSBest = id; }
        }
        for (const id of nodeIds) {
          linS.get(id)!.update(buildFeatures(id, task), rewardAll[id]);
        }

        cumRegret.fixed += Math.max(0, trueScores[oracle] - trueScores[fixedBest!]);
        cumRegret.ucb_partial += Math.max(0, trueScores[oracle] - trueScores[ucbPBest!]);
        cumRegret.ucb_shadow += Math.max(0, trueScores[oracle] - trueScores[ucbSBest!]);
        cumRegret.linucb_partial += Math.max(0, trueScores[oracle] - trueScores[linPBest!]);
        cumRegret.linucb_shadow += Math.max(0, trueScores[oracle] - trueScores[linSBest!]);

        if (CHECKPOINTS.includes(step)) {
          checkpoints.push({ samples: step, cumRegret: { ...cumRegret } });
        }
      }

      const round = (v: number) => Math.round(v * 100) / 100;
      console.log(`  seed ${seed} final regret: F=${round(cumRegret.fixed)} UCB-P=${round(cumRegret.ucb_partial)} UCB-S=${round(cumRegret.ucb_shadow)} LinUCB-P=${round(cumRegret.linucb_partial)} LinUCB-S=${round(cumRegret.linucb_shadow)}`);
      seedsResult.push({ seed, regrets: { ...cumRegret }, checkpoints });
    }

    console.log(`\n  cache: ${cacheMiss} inferences, ${cacheHit} hits (${cacheMiss} unique)`);

    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0003D/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0003D',
      description: 'Statistical Validation — multi-seed workload randomization, LLM output cached (T=0 deterministic)',
      timestamp: new Date().toISOString(),
      config: {
        seeds: SEEDS, seed_base: SEED_BASE, total_steps: TOTAL_STEPS, checkpoints: CHECKPOINTS,
        phases: PHASES.map(p => p.name), ucb_c: UCB_C, feat_dim: FEAT_DIM, lambda: LAMBDA, linucb_alpha: LINUCB_ALPHA,
        reward: REWARD, fixed_w: FIXED_W, methods: METHODS, node_attrs: NODE_ATTRS,
        seed_definition: 'workload randomization: task order (0.5/0.5), prompt selection, initial arm order',
      },
      experts: expertNodes.map(n => ({ node_id: n.nodeId, model_id: n.modelId, family: n.family })),
      seeds: seedsResult,
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
