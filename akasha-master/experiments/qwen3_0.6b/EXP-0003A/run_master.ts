#!/usr/bin/env npx tsx
/**
 * EXP-0003A — Dynamic Node State Estimation
 *
 * 「Capability(t) の追跡」から一般化して、**ノードの状態全体** を観測から推定する。
 *
 *   State(t) = { Capability(node, task), Latency, Cost, Stability, ... }
 *
 * パイプライン:
 *   Observation → State Estimation → Belief → Weight → Routing
 *
 * Router は「状態推定器」を持つ。
 *
 * 制御された状態注入 (論文では controlled state perturbation と明記):
 *   Phase 1 baseline       : 注入なし
 *   Phase 2 latency spike  : node-smollm の latency ×3  (CPU負荷を模擬)
 *   Phase 3 capability jump: node-gemma の capability ×0.5 (モデル更新 v1→v2 を模擬)
 *   Phase 4 recovery       : 注入解除 (全次元が元に戻る)
 *
 * 比較:
 *   Static   : Phase 1 で学習した状態で凍結 (更新しない = 従来の固定ルーター)
 *   Adaptive : 毎ステップ状態を再推定 (ベイズ capability + EMA latency)
 *
 * 新指標:
 *   Regret(t) = Oracle Quality(t) − Router Quality(t)
 *   Cumulative Regret, Phase 別 Regret, 収束リクエスト数
 *
 * 仮説:
 *   Adaptive (状態推定) は Static より低い Cumulative Regret を達成し、
 *   状態変化 (latency spike / capability jump) 後も数リクエストで追従する。
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0003A/run_master.ts --port 8080
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

interface NodeState {
  capability: Record<string, Belief>;  // task → belief
  latency: { ema: number; n: number }; // EMA of estimated latency
  cost: number;                        // params-proportional (static)
  stability: number;                   // 1.0 (この実験では固定)
}

interface StepRecord {
  step: number; phase: string; capability: string;
  trueScores: Record<string, number>;   // injected ground truth
  latencies: Record<string, number>;    // injected latency
  oracle: string;
  staticChoice: string; adaptiveChoice: string;
  staticQuality: number; adaptiveQuality: number;
  regretStatic: number; regretAdaptive: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const STEPS_BASELINE = 6;
const STEPS_LATENCY = 6;
const STEPS_CAPJUMP = 6;
const STEPS_RECOVERY = 6;

// 状態注入 (制御された摂動 — 論文では controlled perturbation と明記)
const LATENCY_SPIKE_FACTOR = 3.0;   // node-smollm latency ×3 (CPU負荷模擬)
const CAP_JUMP_FACTOR = 0.5;        // node-gemma capability ×0.5 (v1→v2退化模擬)
const LATENCY_SPIKE_NODE = 'node-smollm';
const CAP_JUMP_NODE = 'node-gemma';

// Cost (Estimated Cost: params 比例 — 論文では Estimated と明記)
const PARAMS_M: Record<string, number> = {
  qwen: 596, smollm: 362, gemma: 1000,
};

// Adaptive 状態推定の重み (Composite)
const WEIGHTS = { cap: 0.60, lat: 0.20, stab: 0.20 };

// ═══════════════════════════════════════════════════════════════════════════════
// Task Evaluators (EXP-0002D.1 から流用)
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
// State estimators
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

function updateLatencyEMA(prev: { ema: number; n: number }, measured: number): { ema: number; n: number } {
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
  console.log('EXP-0003A — Dynamic Node State Estimation');
  console.log('═'.repeat(60));
  console.log('  State(t) = { Capability(node,task), Latency, Cost, Stability }');
  console.log('  Pipeline: Observation → State Estimation → Belief → Weight → Routing');
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
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0003A' }));
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
    console.log('EXPERIMENT — Dynamic Node State Estimation');
    console.log('═'.repeat(60));

    const expertNodes = [...nodes.values()];
    console.log(`\n  Experts (${expertNodes.length}):`);
    for (const n of expertNodes) console.log(`    ${n.nodeId} — ${n.modelId} (${PARAMS_M[n.family] ?? 500}M)`);

    // 2つの状態推定器: Static (凍結) と Adaptive (更新)
    const staticState: Record<string, NodeState> = {};
    const adaptiveState: Record<string, NodeState> = {};
    for (const n of expertNodes) {
      staticState[n.nodeId] = { capability: { coding: createBelief(), math: createBelief() }, latency: { ema: 0, n: 0 }, cost: PARAMS_M[n.family] ?? 500, stability: 1.0 };
      adaptiveState[n.nodeId] = { capability: { coding: createBelief(), math: createBelief() }, latency: { ema: 0, n: 0 }, cost: PARAMS_M[n.family] ?? 500, stability: 1.0 };
    }

    // 累積 Regret
    let cumRegretStatic = 0, cumRegretAdaptive = 0;
    let step = 0;

    // ── Phase 1: baseline ─────────────────────────────────────────────────
    console.log('\n── Phase 1 (baseline: no injection) ──\n');
    for (let i = 0; i < STEPS_BASELINE; i++) {
      const task = i % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(i / 2) % 8];
      step++;
      await doStep(task, p.prompt, step, 'baseline', expertNodes, staticState, adaptiveState,
        null, null, (s) => { cumRegretStatic += s; }, (a) => { cumRegretAdaptive += a; });
    }

    // Static を凍結 (Adaptive は継続更新)
    // (staticState の参照を渡しているので、以後 static は更新しない)

    // ── Phase 2: latency spike ───────────────────────────────────────────
    console.log('\n── Phase 2 (latency spike: node-smollm ×3) ──\n');
    for (let i = 0; i < STEPS_LATENCY; i++) {
      const task = i % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(i / 2) % 8];
      step++;
      await doStep(task, p.prompt, step, 'latency', expertNodes, staticState, adaptiveState,
        LATENCY_SPIKE_NODE, { type: 'latency', factor: LATENCY_SPIKE_FACTOR },
        (s) => { cumRegretStatic += s; }, (a) => { cumRegretAdaptive += a; });
    }

    // ── Phase 3: capability jump ─────────────────────────────────────────
    console.log('\n── Phase 3 (capability jump: node-gemma ×0.5) ──\n');
    for (let i = 0; i < STEPS_CAPJUMP; i++) {
      const task = i % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(i / 2) % 8];
      step++;
      await doStep(task, p.prompt, step, 'capjump', expertNodes, staticState, adaptiveState,
        CAP_JUMP_NODE, { type: 'capability', factor: CAP_JUMP_FACTOR },
        (s) => { cumRegretStatic += s; }, (a) => { cumRegretAdaptive += a; });
    }

    // ── Phase 4: recovery ────────────────────────────────────────────────
    console.log('\n── Phase 4 (recovery: no injection) ──\n');
    for (let i = 0; i < STEPS_RECOVERY; i++) {
      const task = i % 2 === 0 ? 'coding' : 'math';
      const p = (task === 'coding' ? codingPrompts : mathPrompts)[Math.floor(i / 2) % 8];
      step++;
      await doStep(task, p.prompt, step, 'recovery', expertNodes, staticState, adaptiveState,
        null, null, (s) => { cumRegretStatic += s; }, (a) => { cumRegretAdaptive += a; });
    }

    // ── Results ────────────────────────────────────────────────────────────
    printResults(records, cumRegretStatic, cumRegretAdaptive);

    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0003A/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0003A',
      description: 'Dynamic Node State Estimation (controlled state perturbation)',
      timestamp: new Date().toISOString(),
      config: {
        latency_spike: { node: LATENCY_SPIKE_NODE, factor: LATENCY_SPIKE_FACTOR },
        capability_jump: { node: CAP_JUMP_NODE, factor: CAP_JUMP_FACTOR },
        weights: WEIGHTS,
        cost_model: 'estimated: params-proportional',
      },
      experts: expertNodes.map(n => ({ node_id: n.nodeId, model_id: n.modelId, family: n.family })),
      metrics: {
        cumulative_regret: { static: Math.round(cumRegretStatic * 1000) / 1000, adaptive: Math.round(cumRegretAdaptive * 1000) / 1000 },
      },
      final_adaptive_state: Object.fromEntries(expertNodes.map(n => [n.nodeId, {
        coding: adaptiveState[n.nodeId].capability.coding,
        math: adaptiveState[n.nodeId].capability.math,
        latency_ema: adaptiveState[n.nodeId].latency.ema,
      }])),
      trajectory: records,
    }, null, 2));
    console.log(`\n  📁 ${outDir}/summary.json\n`);

    for (const [id, node] of nodes) node.ws.close();
    wss.close();
    process.exit(0);
  }

  // 1ステップ実行: 全ノードに推論 → 注入 → 状態推定 → 2ポリシーで選択 → Regret 記録
  async function doStep(
    task: string, prompt: string, step: number, phase: string,
    expertNodes: ConnectedNode[],
    staticState: Record<string, NodeState>, adaptiveState: Record<string, NodeState>,
    injectNode: string | null, injection: { type: 'latency' | 'capability'; factor: number } | null,
    onStaticRegret: (r: number) => void, onAdaptiveRegret: (r: number) => void,
  ) {
    const rid = `${phase[0].toUpperCase()}-${String(step).padStart(3, '0')}`;

    // 各ノードに推論
    const trueScores: Record<string, number> = {};
    const rawLat: Record<string, number> = {};
    const injectedLat: Record<string, number> = {};
    for (const n of expertNodes) {
      const chat = n.family !== 'qwen';
      const res = await sendCompute(n.ws, `${rid}-${n.nodeId}`, prompt, chat);
      n.latencyMs = res.timing.total_ms;
      rawLat[n.nodeId] = res.timing.total_ms;

      let score = evaluateTask(task, res.text);
      // capability 注入 (モデル更新 v1→v2 を模擬)
      if (injection?.type === 'capability' && injectNode === n.nodeId) {
        score = Math.round(score * injection.factor * 1000) / 1000;
      }
      trueScores[n.nodeId] = score;

      // latency 注入 (CPU負荷を模擬)
      let lat = rawLat[n.nodeId];
      if (injection?.type === 'latency' && injectNode === n.nodeId) {
        lat = Math.round(lat * injection.factor);
      }
      injectedLat[n.nodeId] = lat;
    }

    // Oracle = 注入後の真の品質が最高のノード
    const oracle = Object.entries(trueScores).sort((a, b) => b[1] - a[1])[0][0];

    // 状態推定
    for (const n of expertNodes) {
      // Adaptive: 毎ステップ更新
      adaptiveState[n.nodeId].capability[task] = updateBelief(adaptiveState[n.nodeId].capability[task], trueScores[n.nodeId]);
      adaptiveState[n.nodeId].latency = updateLatencyEMA(adaptiveState[n.nodeId].latency, injectedLat[n.nodeId]);
    }

    // Static 選択: 凍結状態 (Phase 1 後) で Composite
    const maxLatStatic = Math.max(...expertNodes.map(n => staticState[n.nodeId].latency.ema || 1), 1);
    let staticBest: string | null = null, staticBestScore = -Infinity;
    for (const n of expertNodes) {
      const st = staticState[n.nodeId];
      const capEff = st.capability[task].effective || 0.5;
      const latScore = st.latency.ema > 0 ? 1 - st.latency.ema / maxLatStatic : 0.5;
      const composite = WEIGHTS.cap * capEff + WEIGHTS.lat * latScore + WEIGHTS.stab * st.stability;
      if (composite > staticBestScore) { staticBestScore = composite; staticBest = n.nodeId; }
    }

    // Adaptive 選択: 更新状態で Composite
    const maxLatAdaptive = Math.max(...expertNodes.map(n => adaptiveState[n.nodeId].latency.ema || 1), 1);
    let adaptBest: string | null = null, adaptBestScore = -Infinity;
    for (const n of expertNodes) {
      const st = adaptiveState[n.nodeId];
      const capEff = st.capability[task].effective || 0.5;
      const latScore = 1 - st.latency.ema / maxLatAdaptive;
      const composite = WEIGHTS.cap * capEff + WEIGHTS.lat * latScore + WEIGHTS.stab * st.stability;
      if (composite > adaptBestScore) { adaptBestScore = composite; adaptBest = n.nodeId; }
    }

    // Regret
    const regretStatic = Math.max(0, trueScores[oracle] - trueScores[staticBest!]);
    const regretAdaptive = Math.max(0, trueScores[oracle] - trueScores[adaptBest!]);
    onStaticRegret(regretStatic);
    onAdaptiveRegret(regretAdaptive);

    records.push({
      step, phase, capability: task,
      trueScores, latencies: injectedLat, oracle,
      staticChoice: staticBest!, adaptiveChoice: adaptBest!,
      staticQuality: trueScores[staticBest!], adaptiveQuality: trueScores[adaptBest!],
      regretStatic: Math.round(regretStatic * 1000) / 1000,
      regretAdaptive: Math.round(regretAdaptive * 1000) / 1000,
    });

    const flag = injection ? ` [${injection.type}×${injection.factor} on ${injectNode}]` : '';
    console.log(`  [${rid}]${flag} ${task} | oracle=${oracle} | static=${staticBest}${staticBest === oracle ? '✓' : '✗'} regret=${regretStatic.toFixed(3)} | adaptive=${adaptBest}${adaptBest === oracle ? '✓' : '✗'} regret=${regretAdaptive.toFixed(3)}`);
  }

  console.log(`\n  🟢 Master on ws://localhost:${port}\n`);
  console.log('  Nodes needed: node-qwen, node-smollm, node-gemma');
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-qwen --model Qwen/Qwen3-0.6B --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-smollm --model HuggingFaceTB/SmolLM2-360M-Instruct --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0003/run_node_hetero.py --master ws://localhost:${port} --node-id node-gemma --model unsloth/gemma-3-1b-it --precision fp16`);
  console.log();
}

function printResults(records: StepRecord[], cumStatic: number, cumAdaptive: number) {
  console.log('\n═'.repeat(60));
  console.log('RESULTS — Dynamic Node State Estimation');
  console.log('═'.repeat(60));

  console.log('\n  Cumulative Regret (Σ Oracle Quality − Router Quality):');
  console.log(`  ┌──────────┬─────────────┬─────────────┐`);
  console.log(`  │ Policy   │ Cum Regret  │ Avg Regret  │`);
  console.log(`  ├──────────┼─────────────┼─────────────┤`);
  console.log(`  │ Static   │ ${cumStatic.toFixed(3).padStart(11)} │ ${(cumStatic / records.length).toFixed(4).padStart(11)} │`);
  console.log(`  │ Adaptive │ ${cumAdaptive.toFixed(3).padStart(11)} │ ${(cumAdaptive / records.length).toFixed(4).padStart(11)} │`);
  console.log(`  └──────────┴─────────────┴─────────────┘`);

  console.log('\n  Phase-wise Cumulative Regret:');
  for (const phase of ['baseline', 'latency', 'capjump', 'recovery']) {
    const recs = records.filter(r => r.phase === phase);
    if (recs.length === 0) continue;
    const s = recs.reduce((sum, r) => sum + r.regretStatic, 0);
    const a = recs.reduce((sum, r) => sum + r.regretAdaptive, 0);
    const sAcc = recs.filter(r => r.staticChoice === r.oracle).length;
    const aAcc = recs.filter(r => r.adaptiveChoice === r.oracle).length;
    console.log(`    ${phase.padEnd(10)}: Static regret=${s.toFixed(3)} acc=${sAcc}/${recs.length} | Adaptive regret=${a.toFixed(3)} acc=${aAcc}/${recs.length}`);
  }

  const reduction = cumStatic > 0 ? (1 - cumAdaptive / cumStatic) * 100 : 0;
  console.log(`\n  Regret Reduction (Adaptive vs Static): ${reduction.toFixed(1)}%`);
  const verdict = cumAdaptive < cumStatic
    ? 'SUPPORTED ✅ (Adaptive state estimation < Static cumulative regret)'
    : 'NOT SUPPORTED ❌';
  console.log(`  Hypothesis: Adaptive (state estimation) achieves lower cumulative regret than Static`);
  console.log(`    Verdict: ${verdict}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
