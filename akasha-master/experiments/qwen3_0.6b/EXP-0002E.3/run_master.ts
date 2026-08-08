#!/usr/bin/env npx tsx
/**
 * EXP-0002E.3 — Adaptive Weight Learning
 *
 * Belief の変化に応じて Weight も適応させる。固定ポリシーよりも高い総合性能を
 * 達成できるかを 3 ポリシー比較で検証する:
 *
 *   ① Fixed    : 静的 (capability 偏重 0.60/0.10/0.30) → ドリフトを見逃す
 *   ② Manual   : 運用者が事前調整 (0.40/0.10/0.50)     → 安定性を重視
 *   ③ Adaptive : Belief(stability) から毎ステップ学習 (base 0.50/0.20/0.30)
 *                 w_stab は不安定性 (1−stab) に比例して増加、cap/lat から比例配分で減算
 *
 * シナリオ (3 フェーズ):
 *   Phase 1 baseline : Main=node-onnx, Shadow=node-onnx2 (同一 runtime) → stab≈1.0
 *   Phase 2 drift    : Main=node-onnx, Shadow=node-torch (cross-backend, T=0.8)
 *                       → 温度サンプリングでドリフトを意図的に増幅 → stab 低下
 *   Phase 3 recovery : Main=node-onnx, Shadow=node-onnx2 → stab 回復
 *
 * オラクル (ground truth): argmax(cap × stability) — 実効能力が高いノード
 *   - stab=1.0 時: node-onnx (0.95) > node-onnx2 (0.80) → node-onnx
 *   - stab<0.842 時: 0.95×stab < 0.80 → node-onnx2 が正解
 *
 * 仮説: Adaptive はドリフト中に w_stab を上げて node-onnx2 へ切替え、
 *       固定ポリシーは capability 支配で node-onnx を選び続ける (誤り)。
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002E.3/run_master.ts --port 8080
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
  metadata: { node_id: string; backend: string; precision: string; platform: string; role: string };
}

interface PromptEntry { prompt: string; capability?: string; max_new_tokens?: number; temperature?: number; top_p?: number; }

interface ConnectedNode {
  ws: WebSocket; nodeId: string; backend: string; precision: string;
  requestCount: number; errors: number; latencyMs: number;
}

type Weights = { cap: number; lat: number; stab: number };

interface PolicyState {
  name: string;
  w: Weights;
  chosen: string;
  score: number;
  correct: boolean;
}

interface StepRecord {
  step: number; phase: string; overlap: number; stabMain: number;
  oracle: string;
  chosenLatency: Record<string, number>;
  policies: Record<string, { chosen: string; correct: boolean; w: Weights; score: number }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const PHASE1_BASELINE = 6;   // shadow = same-runtime (node-onnx2)
const PHASE2_DRIFT = 8;      // shadow = cross-backend + temperature (node-torch, T=0.8)
const PHASE3_RECOVERY = 8;   // shadow = same-runtime (node-onnx2)

// Stability update (F.2 と同じ非対称 α)
const ALPHA_DEGRADE = 0.30;  // fast reaction to anomalies
const ALPHA_RECOVER = 0.90;  // slow, conservative recovery

// Drift injection
const DRIFT_TEMPERATURE = 0.8;

// Adaptive weight learning
const STAB_GAIN = 0.5;       // w_stab が不安定性 (1−stab) に比例して増加する係数
const W_BASE: Weights = { cap: 0.50, lat: 0.20, stab: 0.30 };

// Policies
const FIXED_W: Weights = { cap: 0.60, lat: 0.10, stab: 0.30 };  // capability偏重 (ドリフト見逃し型)
const MANUAL_W: Weights = { cap: 0.40, lat: 0.10, stab: 0.50 }; // 運用者事前調整 (安定性重視)

// Node capabilities (coding prompts を使用)
const CAP_MAIN = 0.95;   // node-onnx
const CAP_CAND = 0.80;   // node-onnx2

// ═══════════════════════════════════════════════════════════════════════════════
// Overlap
// ═══════════════════════════════════════════════════════════════════════════════

function computeOverlap(mainTokens: number[], shadowTokens: number[]): number {
  if (mainTokens.length === 0 || shadowTokens.length === 0) return 0;
  const shorter = Math.min(mainTokens.length, shadowTokens.length);
  let match = 0;
  for (let i = 0; i < shorter; i++) if (mainTokens[i] === shadowTokens[i]) match++;
  const positional = match / shorter;
  const mainSet = new Set(mainTokens); const shadowSet = new Set(shadowTokens);
  let setMatch = 0;
  for (const t of mainSet) if (shadowSet.has(t)) setMatch++;
  const setOverlap = setMatch / Math.max(1, mainSet.size);
  return Math.round(Math.max(positional, setOverlap) * 1000) / 1000;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Adaptive weight update
// ═══════════════════════════════════════════════════════════════════════════════

function adaptiveWeights(prev: Weights, base: Weights, stab: number): Weights {
  const risk = 1 - stab; // 不安定性 ∈ [0,1]
  const delta = STAB_GAIN * risk;
  // w_stab は不安定性に比例して増加 (上限 0.70)
  const wStab = Math.min(0.70, base.stab + delta);
  // delta 分を cap/lat から base 比で減算 (合計 1.0 を維持)
  const shareCap = base.cap / (base.cap + base.lat);
  const wCap = Math.max(0.05, base.cap - delta * shareCap);
  const wLat = Math.max(0.05, base.lat - delta * (1 - shareCap));
  // 正規化
  const sum = wCap + wLat + wStab;
  const w: Weights = {
    cap: Math.round((wCap / sum) * 1000) / 1000,
    lat: Math.round((wLat / sum) * 1000) / 1000,
    stab: Math.round((wStab / sum) * 1000) / 1000,
  };
  return w;
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
const promptFile = getArg('--prompts', path.resolve('experiments/qwen3_0.6b/EXP-0002C/prompts.jsonl'));

const nodes = new Map<string, ConnectedNode>();
const records: StepRecord[] = [];
let experimentStarted = false;

function sendCompute(ws: WebSocket, requestId: string, p: PromptEntry, temperature: number): Promise<RemoteResult> {
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
      prompt: p.prompt, max_new_tokens: p.max_new_tokens || 32,
      temperature, top_p: p.top_p ?? 1 }));
  });
}

async function main() {
  console.log('═'.repeat(60));
  console.log('EXP-0002E.3 — Adaptive Weight Learning');
  console.log('═'.repeat(60));
  console.log(`  Policies: Fixed ${JSON.stringify(FIXED_W)} | Manual ${JSON.stringify(MANUAL_W)} | Adaptive base ${JSON.stringify(W_BASE)} (gain=${STAB_GAIN})`);
  console.log(`  Drift injection: cross-backend shadow @ T=${DRIFT_TEMPERATURE}`);
  console.log(`  Phases: baseline ${PHASE1_BASELINE} | drift ${PHASE2_DRIFT} | recovery ${PHASE3_RECOVERY}\n`);

  const prompts: PromptEntry[] = [];
  for (const line of fs.readFileSync(promptFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line);
    prompts.push({ prompt: raw.prompt, capability: raw.capability, max_new_tokens: 32, temperature: 0, top_p: 1 });
  }
  console.log(`  Loaded ${prompts.length} prompts\n`);

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
          requestCount: 0, errors: 0, latencyMs: 0,
        };
        nodes.set(nodeId, node);
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0002E.3' }));
        console.log(`  ✅ ${nodeId} (${node.backend}/${node.precision})`);

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
    console.log('EXPERIMENT — Adaptive Weight Learning (3 policies)');
    console.log('═'.repeat(60));

    const mainNode = nodes.get('node-onnx');
    const candNode = nodes.get('node-onnx2');
    const driftShadow = nodes.get('node-torch');

    if (!mainNode || !candNode || !driftShadow) {
      console.error('Need 3 nodes: node-onnx (main), node-onnx2 (candidate), node-torch (drift shadow)');
      process.exit(1);
    }

    console.log(`\n  Main:       ${mainNode.nodeId} (cap=${CAP_MAIN})`);
    console.log(`  Candidate:  ${candNode.nodeId} (cap=${CAP_CAND})`);
    console.log(`  DriftShadow:${driftShadow.nodeId} (cross-backend, T=${DRIFT_TEMPERATURE})\n`);

    // Belief: main の stability のみ動的、candidate は安定 (1.0)
    let stabMain = 1.0;
    const stabCand = 1.0;

    // Adaptive policy の重み (初期 = base)
    let adaptW: Weights = { ...W_BASE };

    // ポリシー毎の集計
    const stats: Record<string, { correct: number; total: number; scoreSum: number; stabSum: number; latSum: number }> = {
      fixed: { correct: 0, total: 0, scoreSum: 0, stabSum: 0, latSum: 0 },
      manual: { correct: 0, total: 0, scoreSum: 0, stabSum: 0, latSum: 0 },
      adaptive: { correct: 0, total: 0, scoreSum: 0, stabSum: 0, latSum: 0 },
    };

    let step = 0;
    let candLatencyMs = 0;

    // ── Phase 1: baseline ──────────────────────────────────────────────────
    console.log('── Phase 1 (baseline: same-runtime shadow) ──\n');
    for (let i = 0; i < PHASE1_BASELINE; i++) {
      const p = prompts[i % prompts.length];
      step++;
      const rid = `P1-${String(i).padStart(3, '0')}`;

      const mainRes = await sendCompute(mainNode.ws, `${rid}-m`, p, 0);
      const candRes = await sendCompute(candNode.ws, `${rid}-c`, p, 0);
      mainNode.latencyMs = mainRes.timing.total_ms;
      candNode.latencyMs = candRes.timing.total_ms;
      candLatencyMs = candRes.timing.total_ms;

      // shadow = same-runtime (candidate の出力を再利用: ONNX fp16 同一 runtime)
      const overlap = computeOverlap(mainRes.tokens, candRes.tokens);
      stabMain = ALPHA_RECOVER * stabMain + (1 - ALPHA_RECOVER) * overlap;
      stabMain = Math.round(stabMain * 1000) / 1000;

      stepResult(stabMain, overlap, mainNode.latencyMs, candNode.latencyMs, 'baseline', rid, stats, records, step, adaptW);
      adaptW = adaptiveWeights(adaptW, W_BASE, stabMain);
    }

    // ── Phase 2: drift ─────────────────────────────────────────────────────
    console.log('\n── Phase 2 (drift: cross-backend shadow @ T=0.8) ──\n');
    for (let i = 0; i < PHASE2_DRIFT; i++) {
      const p = prompts[i % prompts.length];
      step++;
      const rid = `P2-${String(i).padStart(3, '0')}`;

      const mainRes = await sendCompute(mainNode.ws, `${rid}-m`, p, 0);
      const candRes = await sendCompute(candNode.ws, `${rid}-c`, p, 0);
      const shadowRes = await sendCompute(driftShadow.ws, `${rid}-s`, p, DRIFT_TEMPERATURE);
      mainNode.latencyMs = mainRes.timing.total_ms;
      candNode.latencyMs = candRes.timing.total_ms;
      candLatencyMs = candRes.timing.total_ms;

      const overlap = computeOverlap(mainRes.tokens, shadowRes.tokens);
      stabMain = ALPHA_DEGRADE * stabMain + (1 - ALPHA_DEGRADE) * overlap;
      stabMain = Math.round(stabMain * 1000) / 1000;

      stepResult(stabMain, overlap, mainNode.latencyMs, candNode.latencyMs, 'drift', rid, stats, records, step, adaptW);
      adaptW = adaptiveWeights(adaptW, W_BASE, stabMain);
    }

    // ── Phase 3: recovery ──────────────────────────────────────────────────
    console.log('\n── Phase 3 (recovery: same-runtime shadow) ──\n');
    for (let i = 0; i < PHASE3_RECOVERY; i++) {
      const p = prompts[i % prompts.length];
      step++;
      const rid = `P3-${String(i).padStart(3, '0')}`;

      const mainRes = await sendCompute(mainNode.ws, `${rid}-m`, p, 0);
      const candRes = await sendCompute(candNode.ws, `${rid}-c`, p, 0);
      mainNode.latencyMs = mainRes.timing.total_ms;
      candNode.latencyMs = candRes.timing.total_ms;
      candLatencyMs = candRes.timing.total_ms;

      const overlap = computeOverlap(mainRes.tokens, candRes.tokens);
      stabMain = ALPHA_RECOVER * stabMain + (1 - ALPHA_RECOVER) * overlap;
      stabMain = Math.round(stabMain * 1000) / 1000;

      stepResult(stabMain, overlap, mainNode.latencyMs, candNode.latencyMs, 'recovery', rid, stats, records, step, adaptW);
      adaptW = adaptiveWeights(adaptW, W_BASE, stabMain);
    }

    // ── Results ────────────────────────────────────────────────────────────
    printResults(stats, records);

    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0002E.3/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0002E.3',
      description: 'Adaptive Weight Learning (Fixed vs Manual vs Adaptive)',
      timestamp: new Date().toISOString(),
      config: {
        fixed_w: FIXED_W, manual_w: MANUAL_W, adaptive_base: W_BASE, stab_gain: STAB_GAIN,
        drift_temperature: DRIFT_TEMPERATURE,
        alpha_degrade: ALPHA_DEGRADE, alpha_recover: ALPHA_RECOVER,
        cap_main: CAP_MAIN, cap_candidate: CAP_CAND,
      },
      metrics: {
        fixed: finalStats(stats.fixed),
        manual: finalStats(stats.manual),
        adaptive: finalStats(stats.adaptive),
      },
      trajectory: records.map(r => ({
        step: r.step, phase: r.phase, overlap: r.overlap, stab_main: r.stabMain, oracle: r.oracle,
        fixed: r.policies.fixed, manual: r.policies.manual, adaptive: r.policies.adaptive,
      })),
    }, null, 2));
    console.log(`\n  📁 ${outDir}/summary.json\n`);

    for (const [id, node] of nodes) node.ws.close();
    wss.close();
    process.exit(0);
  }

  console.log(`\n  🟢 Master on ws://localhost:${port}\n`);
  console.log('  Nodes needed: node-onnx (main), node-onnx2 (candidate), node-torch (drift shadow)');
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts --master ws://localhost:${port} --node-id node-onnx  --backend onnx  --precision fp16 --capability '{"coding":0.95,"math":0.65,"general":0.80}'`);
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts --master ws://localhost:${port} --node-id node-onnx2 --backend onnx  --precision fp16 --capability '{"coding":0.80,"math":0.60,"general":0.75}'`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0002F.1/run_node_pytorch.py --master ws://localhost:${port} --node-id node-torch --precision fp16`);
  console.log();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Per-step routing decision
// ═══════════════════════════════════════════════════════════════════════════════

function stepResult(
  stabMain: number, overlap: number, mainLat: number, candLat: number, phase: string, rid: string,
  stats: Record<string, { correct: number; total: number; scoreSum: number; stabSum: number; latSum: number }>,
  records: StepRecord[], step: number, adaptW: Weights,
) {
  const stabCand = 1.0;

  // Oracle: argmax(cap × stability)
  const oracle = (CAP_MAIN * stabMain) > (CAP_CAND * stabCand) ? 'node-onnx' : 'node-onnx2';

  // Latency score (1.0 = fastest)
  const maxLat = Math.max(mainLat, candLat, 1);
  const latMain = mainLat > 0 ? 1 - mainLat / maxLat : 0.5;
  const latCand = candLat > 0 ? 1 - candLat / maxLat : 0.5;

  const policies: PolicyState[] = [
    { name: 'fixed', w: { ...FIXED_W }, chosen: '', score: 0, correct: false },
    { name: 'manual', w: { ...MANUAL_W }, chosen: '', score: 0, correct: false },
    { name: 'adaptive', w: { ...adaptW }, chosen: '', score: 0, correct: false },
  ];

  const recordPolicies: StepRecord['policies'] = {} as any;

  for (const pol of policies) {
    const { w } = pol;
    const scoreMain = w.cap * CAP_MAIN + w.lat * latMain + w.stab * stabMain;
    const scoreCand = w.cap * CAP_CAND + w.lat * latCand + w.stab * stabCand;
    const chosen = scoreMain >= scoreCand ? 'node-onnx' : 'node-onnx2';
    const chosenScore = chosen === 'node-onnx' ? scoreMain : scoreCand;
    const correct = chosen === oracle;

    pol.chosen = chosen; pol.score = chosenScore; pol.correct = correct;
    recordPolicies[pol.name] = { chosen, correct, w: { ...w }, score: Math.round(chosenScore * 1000) / 1000 };

    const s = stats[pol.name];
    s.total++; if (correct) s.correct++;
    s.scoreSum += chosenScore;
    s.stabSum += chosen === 'node-onnx' ? stabMain : stabCand;
    s.latSum += chosen === 'node-onnx' ? mainLat : candLat;
  }

  records.push({
    step, phase, overlap, stabMain, oracle,
    chosenLatency: {
      fixed: policies[0].chosen === 'node-onnx' ? mainLat : candLat,
      manual: policies[1].chosen === 'node-onnx' ? mainLat : candLat,
      adaptive: policies[2].chosen === 'node-onnx' ? mainLat : candLat,
    },
    policies: recordPolicies,
  });

  const f = recordPolicies.fixed, m = recordPolicies.manual, a = recordPolicies.adaptive;
  console.log(
    `  [${rid}] stab=${stabMain.toFixed(3)} overlap=${(overlap * 100).toFixed(0)}% oracle=${oracle === 'node-onnx' ? 'main' : 'cand'}` +
    ` | F=${f.chosen === 'node-onnx' ? 'main' : 'cand'}${f.correct ? '✓' : '✗'} M=${m.chosen === 'node-onnx' ? 'main' : 'cand'}${m.correct ? '✓' : '✗'}` +
    ` A=${a.chosen === 'node-onnx' ? 'main' : 'cand'}${a.correct ? '✓' : '✗'}` +
    ` | wA(cap=${a.w.cap},lat=${a.w.lat},stab=${a.w.stab})`
  );
}

function finalStats(s: { correct: number; total: number; scoreSum: number; stabSum: number; latSum: number }) {
  return {
    routing_accuracy: Math.round((s.correct / s.total) * 1000) / 1000,
    total: s.total,
    correct: s.correct,
    avg_composite: Math.round((s.scoreSum / s.total) * 1000) / 1000,
    avg_chosen_stability: Math.round((s.stabSum / s.total) * 1000) / 1000,
    avg_chosen_latency_ms: Math.round(s.latSum / s.total),
  };
}

function printResults(
  stats: Record<string, { correct: number; total: number; scoreSum: number; stabSum: number; latSum: number }>,
  records: StepRecord[],
) {
  console.log('\n═'.repeat(60));
  console.log('RESULTS — 3-Policy Comparison');
  console.log('═'.repeat(60));

  console.log('\n  Routing Accuracy (vs oracle argmax(cap×stab)):');
  console.log(`  ┌──────────┬──────────────┬────────────┬─────────────────┬───────────────┐`);
  console.log(`  │ Policy   │ Routing Acc  │ Avg Comp   │ Avg Stab (sel)  │ Avg Lat (ms)  │`);
  console.log(`  ├──────────┼──────────────┼────────────┼─────────────────┼───────────────┤`);
  for (const name of ['fixed', 'manual', 'adaptive']) {
    const f = finalStats(stats[name]);
    console.log(`  │ ${name.padEnd(8)} │ ${(f.routing_accuracy * 100).toFixed(0).padStart(5)}% (${f.correct}/${f.total}) │ ${String(f.avg_composite).padStart(10)} │ ${f.avg_chosen_stability.toFixed(3).padStart(15)} │ ${String(f.avg_chosen_latency_ms).padStart(13)} │`);
  }
  console.log(`  └──────────┴──────────────┴────────────┴─────────────────┴───────────────┘`);

  // Weight trajectory (adaptive) — ユーザー要望のログ形式
  console.log('\n  Adaptive Weight Trajectory (Step | Cap | Stab | Lat | w_cap | w_stab | w_lat):');
  console.log('  ┌──────┬─────────┬─────────┬──────────┬─────────┬─────────┬─────────┐');
  console.log('  │ Step │ Cap(sel)│ Stab    │ Lat(ms)  │ w_cap   │ w_stab  │ w_lat   │');
  console.log('  ├──────┼─────────┼─────────┼──────────┼─────────┼─────────┼─────────┤');
  for (const r of records) {
    const a = r.policies.adaptive;
    const cap = a.chosen === 'node-onnx' ? CAP_MAIN : CAP_CAND;
    const lat = r.chosenLatency.adaptive;
    console.log(`  │ ${String(r.step).padStart(4)} │ ${cap.toFixed(2).padStart(7)} │ ${r.stabMain.toFixed(3).padStart(7)} │ ${String(lat).padStart(8)} │ ${a.w.cap.toFixed(3).padStart(7)} │ ${a.w.stab.toFixed(3).padStart(7)} │ ${a.w.lat.toFixed(3).padStart(7)} │`);
  }
  console.log('  └──────┴─────────┴─────────┴──────────┴─────────┴─────────┴─────────┘');

  // Phase-wise accuracy
  console.log('\n  Phase-wise Routing Accuracy:');
  for (const phase of ['baseline', 'drift', 'recovery']) {
    const ph = records.filter(r => r.phase === phase);
    const acc = (name: string) => {
      const c = ph.filter(r => r.policies[name].correct).length;
      return `${c}/${ph.length}`;
    };
    console.log(`    ${phase.padEnd(8)}: Fixed ${acc('fixed')} | Manual ${acc('manual')} | Adaptive ${acc('adaptive')}`);
  }

  // Hypothesis verdict
  const fAcc = finalStats(stats.fixed).routing_accuracy;
  const mAcc = finalStats(stats.manual).routing_accuracy;
  const aAcc = finalStats(stats.adaptive).routing_accuracy;
  console.log('\n  Hypothesis: Adaptive ≥ Fixed on Routing Accuracy');
  console.log(`    Fixed=${(fAcc * 100).toFixed(0)}% | Manual=${(mAcc * 100).toFixed(0)}% | Adaptive=${(aAcc * 100).toFixed(0)}%`);
  console.log(`    Verdict: ${aAcc >= fAcc ? 'SUPPORTED ✅' : 'NOT SUPPORTED ❌'} (adaptive >= fixed)`);
  console.log(`             ${aAcc >= mAcc ? 'Adaptive >= Manual ✅' : 'Adaptive < Manual'}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
