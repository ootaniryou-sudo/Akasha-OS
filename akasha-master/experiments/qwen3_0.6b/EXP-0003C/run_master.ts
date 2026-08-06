#!/usr/bin/env npx tsx
/**
 * EXP-0003C — Policy Learning (State → Policy → Action)
 *
 * 「重みを学習する」(Adaptive Weight, E.3) の次は **Policy 自体を学習する**。
 *
 *   Observation → State Estimation → Policy Learning → Routing
 *
 * 従来:  Composite Score = w_cap·Cap + w_lat·Lat + w_stab·Stab → argmax
 * ここ:   Policy Table Q[state][node] → 状態に応じた行動価値を経験から学習
 *
 * Router には State / Action / Reward がある:
 *   State  : 離散化された観測状態 (lat_anomaly × cap_anomaly の 4 状態)
 *   Action : ルーティング先ノード (qwen / smollm / gemma)
 *   Reward : Quality + Latency + Cost + Stability (スカラー化)
 *
 * 更新則 (手設計の重みルールではなく、報酬追従):
 *   Q[s][a] += η · (r − Q[s][a])
 *
 * 「if capability > ...」は存在しない。policy[state] が経験から更新される。
 *
 * 3 ポリシー比較:
 *   Fixed          : 手設計の重みで Composite → argmax (静的)
 *   Adaptive Weight: Belief に応じて重みを更新 (E.3 方式)
 *   Policy Learning: Q[state][node] を報酬から学習 (本実験)
 *
 * 注入 (controlled perturbation — 論文では明記):
 *   Phase 1 baseline        : なし
 *   Phase 2 latency spike   : node-smollm latency ×3
 *   Phase 3 capability jump : node-gemma capability ×0.5
 *   Phase 4 recovery        : なし
 *
 * 評価: Cumulative Regret, Quality, Latency, Cost, Learning Curve
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0003C/run_master.ts --port 8080
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
  step: number; phase: string; capability: string;
  trueScores: Record<string, number>;
  latencies: Record<string, number>;
  state: number; stateLabel: string;
  oracle: string;
  fixedChoice: string; adaptiveChoice: string; policyChoice: string;
  fixedQuality: number; adaptiveQuality: number; policyQuality: number;
  regretFixed: number; regretAdaptive: number; regretPolicy: number;
  qTable: number[][];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const STEPS_BASELINE = 6;
const STEPS_LATENCY = 6;
const STEPS_CAPJUMP = 6;
const STEPS_RECOVERY = 6;

const LATENCY_SPIKE_FACTOR = 3.0;
const CAP_JUMP_FACTOR = 0.5;
const LATENCY_SPIKE_NODE = 'node-smollm';
const CAP_JUMP_NODE = 'node-gemma';

const PARAMS_M: Record<string, number> = { qwen: 596, smollm: 362, gemma: 1000 };

// Policy Learning ハイパーパラメータ
const ETA = 0.3;          // Q 学習率
const EPSILON = 0.15;     // ε-greedy 探索

// Reward スカラー化係数 (Quality + Latency + Cost + Stability)
const REWARD = { q: 1.0, lat: 0.10, cost: 0.10, stab: 0.10 };

// Fixed / Adaptive Weight の手設計重み (比較用)
const FIXED_W = { q: 0.60, lat: 0.20, cost: 0.05, stab: 0.15 };
const ADAPT_BASE_W = { q: 0.50, lat: 0.20, cost: 0.05, stab: 0.25 };
const ADAPT_GAIN = 0.5;   // 不安定時に w_stab へ移す係数 (E.3 方式)

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

// ═══════════════════════════════════════════════════════════════════════════════
// Estimators
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
  console.log('EXP-0003C — Policy Learning');
  console.log('═'.repeat(60));
  console.log('  State → Policy → Action');
  console.log('  Pipeline: Observation → State Estimation → Policy Learning → Routing');
  console.log('  Reward = Quality + Latency + Cost + Stability (スカラー化)');
  console.log(`  Injections: latency ×${LATENCY_SPIKE_FACTOR} on ${LATENCY_SPIKE_NODE} | capability ×${CAP_JUMP_FACTOR} on ${CAP_JUMP_NODE}\n`);

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
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0003C' }));
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
    console.log('EXPERIMENT — Policy Learning (3-policy comparison)');
    console.log('═'.repeat(60));

    const expertNodes = [...nodes.values()];
    console.log(`\n  Experts (${expertNodes.length}):`);
    for (const n of expertNodes) console.log(`    ${n.nodeId} — ${n.modelId} (${PARAMS_M[n.family] ?? 500}M)`);

    const nodeIds = expertNodes.map(n => n.nodeId);

    // 状態推定 (全ポリシー共通)
    const state: Record<string, { cap: Record<string, Belief>; lat: { ema: number; n: number }; stab: number }> = {};
    for (const n of expertNodes) {
      state[n.nodeId] = { cap: { coding: createBelief(), math: createBelief() }, lat: { ema: 0, n: 0 }, stab: 1.0 };
    }

    // Policy Learning の Q Table: 4 states × N nodes
    // 初期値: baseline の capability belief effective で初期化 (ゼロ初期化は探索が非効率)
    const NUM_STATES = 4;
    let Q: number[][] = Array.from({ length: NUM_STATES }, () => nodeIds.map(() => 0.0));
    let stateCount: number[] = Array(NUM_STATES).fill(0);

    // baseline 後に Q を初期化するためのフラグ
    let qInitialized = false;

    // 累積 Regret
    let cumFixed = 0, cumAdaptive = 0, cumPolicy = 0;
    let step = 0;

    // ── Phase 1: baseline ─────────────────────────────────────────────────
    console.log('\n── Phase 1 (baseline: no injection) ──\n');
    for (let i = 0; i < STEPS_BASELINE; i++) {
      const task = i % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(i / 2) % 8];
      step++;
      await doStep(task, p.prompt, step, 'baseline', expertNodes, state, Q, stateCount,
        null, null, (r) => { cumFixed += r; }, (r) => { cumAdaptive += r; }, (r) => { cumPolicy += r; }, records);
      Q = (records[records.length - 1] as any).qTableDeep ?? Q;
    }

    // Baseline 終了後: Q を学習した Belief から初期化 (ゼロ初期化は探索が非効率)
    if (!qInitialized) {
      for (let s = 0; s < NUM_STATES; s++) {
        Q[s] = nodeIds.map(id => {
          // タスク横断の平均 effective で初期化
          const c = state[id].cap.coding.effective || 0.5;
          const m = state[id].cap.math.effective || 0.5;
          return (c + m) / 2;
        });
      }
      qInitialized = true;
      console.log('  [init] Q table initialized from baseline beliefs:', JSON.stringify(Q.map(r => r.map(v => Math.round(v * 1000) / 1000))));
    }

    // ── Phase 2: latency spike ───────────────────────────────────────────
    console.log('\n── Phase 2 (latency spike: node-smollm ×3) ──\n');
    for (let i = 0; i < STEPS_LATENCY; i++) {
      const task = i % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(i / 2) % 8];
      step++;
      await doStep(task, p.prompt, step, 'latency', expertNodes, state, Q, stateCount,
        LATENCY_SPIKE_NODE, { type: 'latency', factor: LATENCY_SPIKE_FACTOR },
        (r) => { cumFixed += r; }, (r) => { cumAdaptive += r; }, (r) => { cumPolicy += r; }, records);
    }

    // ── Phase 3: capability jump ─────────────────────────────────────────
    console.log('\n── Phase 3 (capability jump: node-gemma ×0.5) ──\n');
    for (let i = 0; i < STEPS_CAPJUMP; i++) {
      const task = i % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(i / 2) % 8];
      step++;
      await doStep(task, p.prompt, step, 'capjump', expertNodes, state, Q, stateCount,
        CAP_JUMP_NODE, { type: 'capability', factor: CAP_JUMP_FACTOR },
        (r) => { cumFixed += r; }, (r) => { cumAdaptive += r; }, (r) => { cumPolicy += r; }, records);
    }

    // ── Phase 4: recovery ────────────────────────────────────────────────
    console.log('\n── Phase 4 (recovery: no injection) ──\n');
    for (let i = 0; i < STEPS_RECOVERY; i++) {
      const task = i % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(i / 2) % 8];
      step++;
      await doStep(task, p.prompt, step, 'recovery', expertNodes, state, Q, stateCount,
        null, null, (r) => { cumFixed += r; }, (r) => { cumAdaptive += r; }, (r) => { cumPolicy += r; }, records);
    }

    // ── Results ────────────────────────────────────────────────────────────
    printResults(records, cumFixed, cumAdaptive, cumPolicy, nodeIds);

    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0003C/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0003C',
      description: 'Policy Learning (State → Policy → Action)',
      timestamp: new Date().toISOString(),
      config: {
        eta: ETA, epsilon: EPSILON,
        reward: REWARD,
        fixed_w: FIXED_W, adaptive_base_w: ADAPT_BASE_W, adaptive_gain: ADAPT_GAIN,
        latency_spike: { node: LATENCY_SPIKE_NODE, factor: LATENCY_SPIKE_FACTOR },
        capability_jump: { node: CAP_JUMP_NODE, factor: CAP_JUMP_FACTOR },
        cost_model: 'estimated: params-proportional',
      },
      experts: expertNodes.map(n => ({ node_id: n.nodeId, model_id: n.modelId, family: n.family })),
      metrics: {
        cumulative_regret: {
          fixed: Math.round(cumFixed * 1000) / 1000,
          adaptive: Math.round(cumAdaptive * 1000) / 1000,
          policy: Math.round(cumPolicy * 1000) / 1000,
        },
        state_visits: stateCount,
        final_q_table: Q.map(row => Object.fromEntries(nodeIds.map((id, i) => [id, Math.round(row[i] * 1000) / 1000]))),
      },
      trajectory: records,
    }, null, 2));
    console.log(`\n  📁 ${outDir}/summary.json\n`);

    for (const [id, node] of nodes) node.ws.close();
    wss.close();
    process.exit(0);
  }

  async function doStep(
    task: string, prompt: string, step: number, phase: string,
    expertNodes: ConnectedNode[],
    state: Record<string, { cap: Record<string, Belief>; lat: { ema: number; n: number }; stab: number }>,
    Q: number[][], stateCount: number[],
    injectNode: string | null, injection: { type: 'latency' | 'capability'; factor: number } | null,
    onFixed: (r: number) => void, onAdaptive: (r: number) => void, onPolicy: (r: number) => void,
    records: StepRecord[],
  ) {
    const rid = `${phase[0].toUpperCase()}-${String(step).padStart(3, '0')}`;
    const nodeIds = expertNodes.map(n => n.nodeId);

    // 推論 + 注入
    const trueScores: Record<string, number> = {};
    const injectedLat: Record<string, number> = {};
    const rawLat: Record<string, number> = {};
    for (const n of expertNodes) {
      const chat = n.family !== 'qwen';
      const res = await sendCompute(n.ws, `${rid}-${n.nodeId}`, prompt, chat);
      n.latencyMs = res.timing.total_ms;
      rawLat[n.nodeId] = res.timing.total_ms;

      let score = evaluateTask(task, res.text);
      if (injection?.type === 'capability' && injectNode === n.nodeId) {
        score = Math.round(score * injection.factor * 1000) / 1000;
      }
      trueScores[n.nodeId] = score;

      let lat = rawLat[n.nodeId];
      if (injection?.type === 'latency' && injectNode === n.nodeId) {
        lat = Math.round(lat * injection.factor);
      }
      injectedLat[n.nodeId] = lat;
    }

    const oracle = Object.entries(trueScores).sort((a, b) => b[1] - a[1])[0][0];

    // 状態推定 (全ポリシー共通)
    for (const n of expertNodes) {
      state[n.nodeId].cap[task] = updateBelief(state[n.nodeId].cap[task], trueScores[n.nodeId]);
      state[n.nodeId].lat = updateEMA(state[n.nodeId].lat, injectedLat[n.nodeId]);
    }

    // 離散状態: lat_anomaly × cap_anomaly
    //   lat_anomaly: 直近実測 latency が他ノード中央値の 1.5 倍を超える (EMA でなく直近観測)
    const lats = nodeIds.map(id => injectedLat[id] || 1);
    const sorted = [...lats].sort((a, b) => a - b);
    const medianLat = sorted[Math.floor(sorted.length / 2)] || 1;
    const latAnomaly = (Math.max(...lats) / Math.max(1, medianLat)) > 1.5 ? 1 : 0;
    // cap_anomaly: いずれかのノードの能力 Belief が 0.5 を下回る (急落検知)
    const capAnomaly = nodeIds.some(id => state[id].cap[task].mu < 0.5) ? 1 : 0;
    const sIdx = latAnomaly * 2 + capAnomaly;
    stateCount[sIdx]++;

    const maxLat = Math.max(...nodeIds.map(id => injectedLat[id]), 1);
    const maxParams = Math.max(...expertNodes.map(n => PARAMS_M[n.family] ?? 500));

    // ── ① Fixed (手設計重み) ──
    let fixedBest: string | null = null, fixedScore = -Infinity;
    for (const n of expertNodes) {
      const st = state[n.nodeId];
      const q = st.cap[task].effective || 0.5;
      const latScore = 1 - injectedLat[n.nodeId] / maxLat;
      const costScore = 1 - PARAMS_M[n.family] / maxParams;
      const comp = FIXED_W.q * q + FIXED_W.lat * latScore + FIXED_W.cost * costScore + FIXED_W.stab * st.stab;
      if (comp > fixedScore) { fixedScore = comp; fixedBest = n.nodeId; }
    }

    // ── ② Adaptive Weight (E.3 方式: w_stab が不安定性に応じて増加) ──
    const minStab = Math.min(...expertNodes.map(n => state[n.nodeId].stab));
    const risk = 1 - minStab;
    const wStab = Math.min(0.70, ADAPT_BASE_W.stab + ADAPT_GAIN * risk);
    const shareCap = ADAPT_BASE_W.q / (ADAPT_BASE_W.q + ADAPT_BASE_W.lat + ADAPT_BASE_W.cost);
    const wQ = Math.max(0.05, ADAPT_BASE_W.q - (wStab - ADAPT_BASE_W.stab) * shareCap);
    const wLat = Math.max(0.05, ADAPT_BASE_W.lat - (wStab - ADAPT_BASE_W.stab) * (1 - shareCap) * 0.7);
    let adaptBest: string | null = null, adaptScore = -Infinity;
    for (const n of expertNodes) {
      const st = state[n.nodeId];
      const q = st.cap[task].effective || 0.5;
      const latScore = 1 - injectedLat[n.nodeId] / maxLat;
      const costScore = 1 - PARAMS_M[n.family] / maxParams;
      const comp = wQ * q + wLat * latScore + ADAPT_BASE_W.cost * costScore + wStab * st.stab;
      if (comp > adaptScore) { adaptScore = comp; adaptBest = n.nodeId; }
    }

    // ── ③ Policy Learning (Q[state][node] から ε-greedy で選択) ──
    let policyBest: string;
    if (Math.random() < EPSILON) {
      policyBest = nodeIds[Math.floor(Math.random() * nodeIds.length)];
    } else {
      let bestIdx = 0;
      for (let i = 1; i < nodeIds.length; i++) if (Q[sIdx][i] > Q[sIdx][bestIdx]) bestIdx = i;
      policyBest = nodeIds[bestIdx];
    }

    // 報酬 (選択した行動の実測から)
    const rewardFor = (id: string) => {
      const n = expertNodes.find(x => x.nodeId === id)!;
      const q = trueScores[id];
      const latScore = 1 - injectedLat[id] / maxLat;
      const costScore = 1 - PARAMS_M[n.family] / maxParams;
      return REWARD.q * q + REWARD.lat * latScore + REWARD.cost * costScore + REWARD.stab * state[id].stab;
    };
    const rPolicy = rewardFor(policyBest);
    const pIdx = nodeIds.indexOf(policyBest);
    Q[sIdx][pIdx] = Q[sIdx][pIdx] + ETA * (rPolicy - Q[sIdx][pIdx]);

    // Regret (Quality 基準)
    const regretFixed = Math.max(0, trueScores[oracle] - trueScores[fixedBest!]);
    const regretAdaptive = Math.max(0, trueScores[oracle] - trueScores[adaptBest!]);
    const regretPolicy = Math.max(0, trueScores[oracle] - trueScores[policyBest]);
    onFixed(regretFixed); onAdaptive(regretAdaptive); onPolicy(regretPolicy);

    records.push({
      step, phase, capability: task,
      trueScores, latencies: injectedLat,
      state: sIdx, stateLabel: `lat${latAnomaly}·cap${capAnomaly}`,
      oracle,
      fixedChoice: fixedBest!, adaptiveChoice: adaptBest!, policyChoice: policyBest,
      fixedQuality: trueScores[fixedBest!], adaptiveQuality: trueScores[adaptBest!], policyQuality: trueScores[policyBest],
      regretFixed: Math.round(regretFixed * 1000) / 1000,
      regretAdaptive: Math.round(regretAdaptive * 1000) / 1000,
      regretPolicy: Math.round(regretPolicy * 1000) / 1000,
      qTable: Q.map(row => row.map(v => Math.round(v * 1000) / 1000)),
    });

    const flag = injection ? ` [${injection.type}×${injection.factor} on ${injectNode}]` : '';
    console.log(`  [${rid}]${flag} ${task} state=${sIdx} | oracle=${oracle} | F=${fixedBest}${fixedBest === oracle ? '✓' : '✗'} A=${adaptBest}${adaptBest === oracle ? '✓' : '✗'} P=${policyBest}${policyBest === oracle ? '✓' : '✗'} | regret F=${regretFixed.toFixed(2)} A=${regretAdaptive.toFixed(2)} P=${regretPolicy.toFixed(2)}`);
  }

  console.log(`\n  🟢 Master on ws://localhost:${port}\n`);
  console.log('  Nodes needed: node-qwen, node-smollm, node-gemma');
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16`);
  console.log();
}

function printResults(records: StepRecord[], cumFixed: number, cumAdaptive: number, cumPolicy: number, nodeIds: string[]) {
  console.log('\n═'.repeat(60));
  console.log('RESULTS — Policy Learning (3-policy comparison)');
  console.log('═'.repeat(60));

  console.log('\n  Cumulative Regret (Σ Oracle Quality − Router Quality):');
  console.log(`  ┌──────────────┬─────────────┬─────────────┐`);
  console.log(`  │ Policy       │ Cum Regret  │ Avg Regret  │`);
  console.log(`  ├──────────────┼─────────────┼─────────────┤`);
  console.log(`  │ Fixed        │ ${cumFixed.toFixed(3).padStart(11)} │ ${(cumFixed / records.length).toFixed(4).padStart(11)} │`);
  console.log(`  │ Adaptive W   │ ${cumAdaptive.toFixed(3).padStart(11)} │ ${(cumAdaptive / records.length).toFixed(4).padStart(11)} │`);
  console.log(`  │ Policy Learn │ ${cumPolicy.toFixed(3).padStart(11)} │ ${(cumPolicy / records.length).toFixed(4).padStart(11)} │`);
  console.log(`  └──────────────┴─────────────┴─────────────┘`);

  console.log('\n  Phase-wise Cumulative Regret:');
  for (const phase of ['baseline', 'latency', 'capjump', 'recovery']) {
    const recs = records.filter(r => r.phase === phase);
    if (!recs.length) continue;
    const f = recs.reduce((s, r) => s + r.regretFixed, 0);
    const a = recs.reduce((s, r) => s + r.regretAdaptive, 0);
    const p = recs.reduce((s, r) => s + r.regretPolicy, 0);
    const fAcc = recs.filter(r => r.fixedChoice === r.oracle).length;
    const aAcc = recs.filter(r => r.adaptiveChoice === r.oracle).length;
    const pAcc = recs.filter(r => r.policyChoice === r.oracle).length;
    console.log(`    ${phase.padEnd(10)}: F regret=${f.toFixed(2)} acc=${fAcc}/${recs.length} | A regret=${a.toFixed(2)} acc=${aAcc}/${recs.length} | P regret=${p.toFixed(2)} acc=${pAcc}/${recs.length}`);
  }

  // 最終 Q Table
  const lastQ = records[records.length - 1].qTable;
  console.log('\n  Final Policy Table Q[state][node] (learned):');
  console.log(`  ┌────────┬─────────┬─────────┬─────────┐`);
  console.log(`  │ State  │ ${nodeIds[0].padEnd(7)} │ ${nodeIds[1].padEnd(7)} │ ${nodeIds[2].padEnd(7)} │`);
  console.log(`  ├────────┼─────────┼─────────┼─────────┤`);
  const labels = ['lat0·cap0', 'lat0·cap1', 'lat1·cap0', 'lat1·cap1'];
  for (let s = 0; s < 4; s++) {
    console.log(`  │ ${labels[s].padEnd(6)} │ ${lastQ[s][0].toFixed(3).padStart(7)} │ ${lastQ[s][1].toFixed(3).padStart(7)} │ ${lastQ[s][2].toFixed(3).padStart(7)} │`);
  }
  console.log(`  └────────┴─────────┴─────────┴─────────┘`);

  const verdict = cumPolicy <= cumAdaptive && cumPolicy <= cumFixed
    ? 'SUPPORTED ✅ (Policy Learning lowest cumulative regret)'
    : cumPolicy <= cumAdaptive
      ? 'PARTIAL ✅ (Policy Learning < Adaptive Weight)'
      : 'NOT SUPPORTED ❌';
  console.log(`\n  Hypothesis: Policy Learning achieves lower cumulative regret than hand-designed policies`);
  console.log(`    Verdict: ${verdict}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
