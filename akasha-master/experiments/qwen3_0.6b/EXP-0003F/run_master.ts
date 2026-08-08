#!/usr/bin/env npx tsx
/**
 * EXP-0003F — Feature Ablation for LinUCB
 *
 * 「なぜ LinUCB-Shadow が Fixed を超えるのか」のメカニズムを、
 * フィーチャを 1 つずつ除去して定量化する。
 *
 * バリアント (全て LinUCB-Shadow, 特徴を除いた次元で学習):
 *   linucb_full   : [1, capability, latency, cost, stability, confidence, memory, temperature]
 *   linucb_nocap  : capability を除去
 *   linucb_nolat  : latency   を除去
 *   linucb_nocost : cost      を除去
 *   linucb_nostab : stability を除去
 *   linucb_noconf : confidence を除去
 *   linucb_nomem  : memory    を除去
 *   linucb_notemp : temperature を除去
 *
 * 効率: 全バリアントは同一の毎ステップ評価 (オラクル/シャドウ) と同一の
 * ワークロード系列 (シード) を共有する。LLM 出力は決定論的 (T=0) でキャッシュされ、
 * 8 バリアント × 30 シードが一度の実行で完了する。
 *
 * 期待 (Set A の学習済み θ から):
 *   - capability 除去が最も Regret を増やす (θ_cap 最大)
 *   - latency 除去が次 (gemma の θ_lat=0.379)
 *   - memory/temperature (静的属性) の除去は効果が小さい (バイアスで補償可能)
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0003F/run_master.ts --port 8080 --seeds 30
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
const SEEDS = parseInt(getArg('--seeds', '30'), 10);
const SEED_BASE = parseInt(getArg('--seed-base', '42'), 10);
const TOTAL_STEPS = 120;
const CHECKPOINTS = [24, 60, 100, 120];
const STEPS_PER_PHASE = 20;

const UCB_C = 2.0;
const FEAT_DIM = 8;              // [bias, cap, lat, cost, stab, conf, mem, temp]
const LAMBDA = 1.0;
const LINUCB_ALPHA = 0.3;

// アブレーション: remove は除去する特徴インデックス (-1 = 除去なし)
const FEATURE_NAMES = ['bias', 'capability', 'latency', 'cost', 'stability', 'confidence', 'memory', 'temperature'];
const VARIANTS: { key: string; remove: number; dim: number }[] = [
  { key: 'linucb_full', remove: -1, dim: FEAT_DIM },
  { key: 'linucb_nocap', remove: 1, dim: FEAT_DIM - 1 },
  { key: 'linucb_nolat', remove: 2, dim: FEAT_DIM - 1 },
  { key: 'linucb_nocost', remove: 3, dim: FEAT_DIM - 1 },
  { key: 'linucb_nostab', remove: 4, dim: FEAT_DIM - 1 },
  { key: 'linucb_noconf', remove: 5, dim: FEAT_DIM - 1 },
  { key: 'linucb_nomem', remove: 6, dim: FEAT_DIM - 1 },
  { key: 'linucb_notemp', remove: 7, dim: FEAT_DIM - 1 },
];
const METHODS = ['fixed', ...VARIANTS.map(v => v.key)];

const PHASES_TEMPLATE: { name: string; inject: { type: 'latency' | 'capability'; node: string; factor: number } | null }[] = [
  { name: 'baseline', inject: null },
  { name: 'latency', inject: { type: 'latency', node: '', factor: 3.0 } },
  { name: 'capjump', inject: { type: 'capability', node: '', factor: 0.5 } },
];

const KNOWN_PARAMS: Record<string, number> = {
  'Qwen/Qwen3-0.6B': 596,
  'HuggingFaceTB/SmolLM2-360M-Instruct': 362,
  'unsloth/gemma-3-1b-it': 1000,
  'Qwen/Qwen2.5-Coder-0.5B': 494,
  'HuggingFaceTB/SmolLM2-135M-Instruct': 135,
  'unsloth/Llama-3.2-1B-Instruct': 1235,
};
function paramsOf(modelId: string): number {
  const known = KNOWN_PARAMS[modelId];
  if (known) return known;
  const m = modelId.match(/(\d+\.?\d*)[bB]/);
  return m ? Math.round(parseFloat(m[1]) * 1000) : 500;
}
const attrOf = (modelId: string) => {
  const p = paramsOf(modelId);
  return { memory: Math.round((p / 500) * 100) / 100, temperature: 0.6 };
};

const REWARD = { q: 1.0, lat: 0.10, cost: 0.10, stab: 0.10 }; // cost = EstimatedCost
const FIXED_W = { q: 0.60, lat: 0.20, cost: 0.05, stab: 0.15 };

const TASKS = ['coding', 'math', 'reasoning'];

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

function evaluateReasoning(text: string): number {
  const lower = text.toLowerCase();
  const signals = ['because', 'therefore', 'if ', 'then', 'since', 'first', 'second', 'step', 'thus', 'answer', 'reason', 'so '];
  const signalHits = signals.filter(k => lower.includes(k)).length;
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
    case 'reasoning': return Math.round(evaluateReasoning(text) * 1000) / 1000;
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
  console.log('EXP-0003F — Feature Ablation for LinUCB');
  console.log('═'.repeat(60));
  console.log(`  Seeds: ${SEEDS} (base ${SEED_BASE}), Steps: ${TOTAL_STEPS}, Tasks: ${TASKS.join('/')}`);
  console.log('  Variants: full + 7 single-feature removals (all LinUCB-Shadow)');
  console.log('  Set A: Qwen3-0.6B / SmolLM2-360M / Gemma-3-1B');
  console.log('  ⚠️ cost = EstimatedCost (params 比例の proxy, 実測ではない)\n');

  const rawPrompts: PromptEntry[] = [];
  for (const line of fs.readFileSync(path.resolve('experiments/qwen3_0.6b/EXP-0003/prompts.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line);
    if (TASKS.includes(raw.capability)) {
      rawPrompts.push({ prompt: raw.prompt, capability: raw.capability });
    }
  }
  const promptPools: Record<string, PromptEntry[]> = {};
  for (const t of TASKS) promptPools[t] = rawPrompts.filter(p => p.capability === t);
  console.log(`  Prompts: ${TASKS.map(t => `${t}=${promptPools[t].length}`).join(', ')}`);

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
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0003F' }));
        console.log(`  ✅ ${nodeId} (${node.backend}/${node.precision}) model=${node.modelId} (${paramsOf(node.modelId)}M)`);

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
    console.log(`EXPERIMENT — ${SEEDS} seeds × ${TOTAL_STEPS} steps (Set A, ablation)`);
    console.log('═'.repeat(60));

    const expertNodes = [...nodes.values()];
    const nodeIds = expertNodes.map(n => n.nodeId);
    console.log(`  Experts (${expertNodes.length}):`);
    for (const n of expertNodes) console.log(`    ${n.nodeId} — ${n.modelId} (${paramsOf(n.modelId)}M)`);

    const byParams = [...nodeIds].sort(
      (a, b) => paramsOf(expertNodes.find(x => x.nodeId === a)!.modelId) - paramsOf(expertNodes.find(x => x.nodeId === b)!.modelId));
    const phases = PHASES_TEMPLATE.map(ph =>
      ph.inject ? { ...ph, inject: { ...ph.inject, node: ph.inject.type === 'latency' ? byParams[0] : byParams[byParams.length - 1] } } : ph);
    console.log(`  Injection targets: latency→${byParams[0]}, capability→${byParams[byParams.length - 1]}`);

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
      const order = shuffle(nodeIds, rng);
      if (seed % 5 === 0) console.log(`\n  ── seed ${seed} (order: ${order.join(', ')}) ──`);

      const state: Record<string, { cap: Record<string, Belief>; lat: { ema: number; n: number }; stab: number }> = {};
      for (const id of nodeIds) {
        const cap: Record<string, Belief> = {};
        for (const t of TASKS) cap[t] = createBelief();
        state[id] = { cap, lat: { ema: 0, n: 0 }, stab: 1.0 };
      }

      // 各バリアントの LinUCB (disjoint, アーム毎)
      const linUCBs: Record<string, Map<string, LinUCB>> = {};
      for (const v of VARIANTS) {
        linUCBs[v.key] = new Map(nodeIds.map(id => [id, new LinUCB(v.dim, LINUCB_ALPHA, LAMBDA)]));
      }

      const cumRegret: Record<string, number> = {};
      for (const m of METHODS) cumRegret[m] = 0;
      const checkpoints: CheckpointRecord[] = [];

      let injectedLat: Record<string, number> = {};

      const buildFeatures = (nodeId: string, task: string, removeIdx: number): number[] => {
        const st = state[nodeId];
        const n = expertNodes.find(x => x.nodeId === nodeId)!;
        const maxLat = Math.max(...nodeIds.map(id => injectedLat[id]), 1);
        const params = paramsOf(n.modelId);
        const maxParams = Math.max(...expertNodes.map(x => paramsOf(x.modelId)));
        const attrs = attrOf(n.modelId);
        const full = [
          1,
          st.cap[task].mu,
          1 - injectedLat[nodeId] / maxLat,
          1 - params / maxParams,
          st.stab,
          st.cap[task].confidence,
          1 - attrs.memory / 2.0,
          1 - attrs.temperature / 1.0,
        ];
        if (removeIdx < 0) return full;
        return full.filter((_, i) => i !== removeIdx);
      };

      for (let s = 0; s < TOTAL_STEPS; s++) {
        const ph = phases[Math.floor(s / STEPS_PER_PHASE) % phases.length];
        const r = rng();
        const task = r < 1 / 3 ? 'coding' : r < 2 / 3 ? 'math' : 'reasoning';
        const pool = promptPools[task];
        const p = pool[Math.floor(rng() * pool.length)];
        const step = s + 1;

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
        const maxParams = Math.max(...expertNodes.map(x => paramsOf(x.modelId)));

        const rewardAll: Record<string, number> = {};
        for (const n of expertNodes) {
          rewardAll[n.nodeId] = REWARD.q * trueScores[n.nodeId]
            + REWARD.lat * (1 - injectedLat[n.nodeId] / maxLat)
            + REWARD.cost * (1 - paramsOf(n.modelId) / maxParams)
            + REWARD.stab * state[n.nodeId].stab;
        }

        // ① Fixed
        let fixedBest: string | null = null, fixedScore = -Infinity;
        for (const id of order) {
          const st = state[id];
          const comp = FIXED_W.q * (st.cap[task].effective || 0.5)
            + FIXED_W.lat * (1 - injectedLat[id] / maxLat)
            + FIXED_W.cost * (1 - paramsOf(expertNodes.find(x => x.nodeId === id)!.modelId) / maxParams)
            + FIXED_W.stab * st.stab;
          if (comp > fixedScore) { fixedScore = comp; fixedBest = id; }
        }

        // ②〜⑨ 各バリアント (LinUCB-Shadow)
        const picks: Record<string, string> = {};
        for (const v of VARIANTS) {
          const lin = linUCBs[v.key];
          let best: string | null = null, bestScore = -Infinity;
          for (const id of order) {
            const score = lin.get(id)!.score(buildFeatures(id, task, v.remove));
            if (score > bestScore) { bestScore = score; best = id; }
          }
          picks[v.key] = best!;
          for (const id of nodeIds) {
            lin.get(id)!.update(buildFeatures(id, task, v.remove), rewardAll[id]);
          }
        }

        cumRegret.fixed += Math.max(0, trueScores[oracle] - trueScores[fixedBest!]);
        for (const v of VARIANTS) {
          cumRegret[v.key] += Math.max(0, trueScores[oracle] - trueScores[picks[v.key]]);
        }

        if (CHECKPOINTS.includes(step)) {
          checkpoints.push({ samples: step, cumRegret: { ...cumRegret } });
        }
      }

      const round = (v: number) => Math.round(v * 100) / 100;
      const line = METHODS.map(m => `${m}=${round(cumRegret[m])}`).join(' ');
      console.log(`  seed ${seed} final: ${line}`);
      seedsResult.push({ seed, regrets: { ...cumRegret }, checkpoints });
    }

    console.log(`\n  cache: ${cacheMiss} inferences, ${cacheHit} hits (${cacheMiss} unique)`);

    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0003F/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0003F',
      description: 'Feature Ablation for LinUCB — full + 7 single-feature removals (Set A, 3 tasks)',
      timestamp: new Date().toISOString(),
      config: {
        tasks: TASKS, seeds: SEEDS, seed_base: SEED_BASE,
        total_steps: TOTAL_STEPS, checkpoints: CHECKPOINTS,
        phases: phases.map(p => p.name), ucb_c: UCB_C, feat_dim: FEAT_DIM, lambda: LAMBDA, linucb_alpha: LINUCB_ALPHA,
        reward: REWARD, fixed_w: FIXED_W, methods: METHODS, feature_names: FEATURE_NAMES,
        variants: VARIANTS,
        seed_definition: 'workload randomization: task order (1/3 each), prompt selection, initial arm order',
        cost_note: 'cost is EstimatedCost (params-proportional proxy), NOT measured.',
      },
      experts: expertNodes.map(n => ({ node_id: n.nodeId, model_id: n.modelId, params_m: paramsOf(n.modelId) })),
      seeds: seedsResult,
    }, null, 2));
    console.log(`\n  📁 ${outDir}/summary.json\n`);

    for (const [id, node] of nodes) node.ws.close();
    wss.close();
    process.exit(0);
  }

  console.log(`\n  🟢 Master on ws://localhost:${port}\n`);
  console.log('  Nodes needed (Set A): node-qwen, node-smollm, node-gemma');
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16`);
  console.log();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

