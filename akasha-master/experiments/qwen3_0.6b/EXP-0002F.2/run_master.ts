#!/usr/bin/env npx tsx
/**
 * EXP-0002F.2 — Recovery Dynamics & Hysteresis
 *
 * Two-phase experiment:
 *   Phase A (drift):     Main=ONNX, Shadow=PyTorch MPS → mismatch → stability down
 *   Phase B (recovery):  Main=ONNX, Shadow=ONNX (same runtime) → match → stability up
 *
 * Asymmetric update: α_degrade (fast) < α_recover (slow/conservative)
 *
 * Metrics:
 *   Degradation rate, Recovery rate, Recovery Half-life, Recovery Time(95%),
 *   Hysteresis Ratio, False Recovery Rate
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002F.2/run_master.ts --port 8080
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
  requestCount: number; errors: number;
}

interface StepRecord {
  phase: string; request_id: string; overlap: number; verdict: string;
  stability: number; alpha: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const PHASE_A_PROMPTS = 8;  // drift
const PHASE_B_PROMPTS = 8;  // recovery
const THRESHOLD = 0.5;

// Asymmetric update
const ALPHA_DEGRADE = 0.30;  // fast reaction to anomalies
const ALPHA_RECOVER = 0.90;  // slow, conservative recovery
const ALPHA_SYMMETRIC = 0.60; // for comparison

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

// Async compute helper
function sendCompute(ws: WebSocket, requestId: string, p: PromptEntry): Promise<RemoteResult> {
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
      temperature: p.temperature ?? 0, top_p: p.top_p ?? 1 }));
  });
}

async function main() {
  console.log('═'.repeat(60));
  console.log('EXP-0002F.2 — Recovery Dynamics & Hysteresis');
  console.log('═'.repeat(60));
  console.log(`  α_degrade=${ALPHA_DEGRADE} (fast) | α_recover=${ALPHA_RECOVER} (conservative)`);
  console.log(`  Phase A: ${PHASE_A_PROMPTS} prompts drift | Phase B: ${PHASE_B_PROMPTS} prompts recovery\n`);

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
          requestCount: 0, errors: 0,
        };
        nodes.set(nodeId, node);
        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0002F.2' }));
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
    console.log('EXPERIMENT — Recovery Dynamics & Hysteresis');
    console.log('═'.repeat(60));

    const mainNode = nodes.get('node-onnx');
    const driftShadow = nodes.get('node-torch');
    const recoverShadow = nodes.get('node-onnx2');

    if (!mainNode || !driftShadow || !recoverShadow) {
      console.error('Need 3 nodes: node-onnx, node-torch, node-onnx2');
      process.exit(1);
    }

    console.log(`\n  Main:       ${mainNode.nodeId} (${mainNode.backend})`);
    console.log(`  DriftShad:  ${driftShadow.nodeId} (${driftShadow.backend}) → Phase A`);
    console.log(`  RecovShad:  ${recoverShadow.nodeId} (${recoverShadow.backend}) → Phase B`);
    console.log(`  Threshold:  ${THRESHOLD}\n`);

    // ── Track both update rules for comparison ────────────────────────────
    let asymStability = 1.0;   // asymmetric (α_degrade, α_recover)
    let symStability = 1.0;    // symmetric (α_sym)

    const phaseAOverlaps: number[] = [];
    const phaseBOverlaps: number[] = [];
    let reqIndex = 0;

    // Phase A: drift
    console.log('── Phase A (Drift: cross-backend shadow) ──\n');
    for (let i = 0; i < PHASE_A_PROMPTS; i++) {
      const p = prompts[i % prompts.length];
      const rid = `A-${String(i).padStart(3, '0')}`;
      const mainRes = await sendCompute(mainNode.ws, `${rid}-m`, p);
      const shadowRes = await sendCompute(driftShadow.ws, `${rid}-s`, p);
      const overlap = computeOverlap(mainRes.tokens, shadowRes.tokens);
      phaseAOverlaps.push(overlap);
      const verdict = overlap >= THRESHOLD ? 'ACCEPT' : 'FLAG';

      // Asymmetric: fast degradation
      asymStability = ALPHA_DEGRADE * asymStability + (1 - ALPHA_DEGRADE) * overlap;
      // Symmetric
      symStability = ALPHA_SYMMETRIC * symStability + (1 - ALPHA_SYMMETRIC) * overlap;

      asymStability = Math.round(asymStability * 1000) / 1000;
      symStability = Math.round(symStability * 1000) / 1000;

      records.push({ phase: 'A', request_id: rid, overlap, verdict, stability: asymStability, alpha: ALPHA_DEGRADE });
      console.log(`  [${rid}] overlap=${(overlap * 100).toFixed(1)}% ${verdict} | asym=${asymStability} sym=${symStability}`);
      reqIndex++;
    }

    // Phase B: recovery
    console.log('\n── Phase B (Recovery: same-runtime shadow) ──\n');
    for (let i = 0; i < PHASE_B_PROMPTS; i++) {
      const p = prompts[i % prompts.length];
      const rid = `B-${String(i).padStart(3, '0')}`;
      const mainRes = await sendCompute(mainNode.ws, `${rid}-m`, p);
      const shadowRes = await sendCompute(recoverShadow.ws, `${rid}-s`, p);
      const overlap = computeOverlap(mainRes.tokens, shadowRes.tokens);
      phaseBOverlaps.push(overlap);
      const verdict = overlap >= THRESHOLD ? 'ACCEPT' : 'FLAG';

      // Asymmetric: slow conservative recovery
      asymStability = ALPHA_RECOVER * asymStability + (1 - ALPHA_RECOVER) * overlap;
      symStability = ALPHA_SYMMETRIC * symStability + (1 - ALPHA_SYMMETRIC) * overlap;
      asymStability = Math.round(asymStability * 1000) / 1000;
      symStability = Math.round(symStability * 1000) / 1000;

      records.push({ phase: 'B', request_id: rid, overlap, verdict, stability: asymStability, alpha: ALPHA_RECOVER });
      console.log(`  [${rid}] overlap=${(overlap * 100).toFixed(1)}% ${verdict} | asym=${asymStability} sym=${symStability}`);
      reqIndex++;
    }

    // ── Metrics ───────────────────────────────────────────────────────────
    const phaseAStart = 1.0;
    const phaseAEnd = asymStabilityAfter(records, 'A');
    const phaseBStart = phaseAEnd;
    const phaseBEnd = records[records.length - 1].stability;

    const degRate = (phaseAStart - phaseAEnd) / PHASE_A_PROMPTS;
    const recRate = (phaseBEnd - phaseBStart) / PHASE_B_PROMPTS;
    const hysteresisRatio = recRate !== 0 ? Math.round((recRate / degRate) * 1000) / 1000 : Infinity;
    const recovStart = phaseAEnd;
    const recovTargetHalf = recovStart + (1 - recovStart) / 2;
    const recovTarget95 = recovStart + (1 - recovStart) * 0.95;

    let halfLife = -1, timeTo95 = -1;
    records.forEach((r, idx) => {
      if (r.phase === 'B') {
        if (halfLife < 0 && r.stability >= recovTargetHalf) halfLife = idx - PHASE_A_PROMPTS + 1;
        if (timeTo95 < 0 && r.stability >= recovTarget95) timeTo95 = idx - PHASE_A_PROMPTS + 1;
      }
    });

    // False Recovery = Phase B steps where the shadow evidence did NOT support
    // recovery (overlap < threshold → FLAG). All-ACCEPT Phase B ⇒ 0% false recovery.
    const falseRecovery = records.filter(r => r.phase === 'B' && r.verdict === 'FLAG').length;
    const falseRecoveryRate = falseRecovery / PHASE_B_PROMPTS;

    const avgPhaseAOverlap = phaseAOverlaps.reduce((s, x) => s + x, 0) / phaseAOverlaps.length;
    const avgPhaseBOverlap = phaseBOverlaps.reduce((s, x) => s + x, 0) / phaseBOverlaps.length;

    // ── Output ────────────────────────────────────────────────────────────
    console.log('\n═'.repeat(60));
    console.log('RESULTS — Recovery Dynamics & Hysteresis');
    console.log('═'.repeat(60));

    console.log(`\n  Phase A (drift): avg overlap=${(avgPhaseAOverlap * 100).toFixed(1)}%`);
    console.log(`  Phase B (recovery): avg overlap=${(avgPhaseBOverlap * 100).toFixed(1)}%`);

    console.log(`\n  Stability trajectory (asymmetric):`);
    console.log(`    Start: ${phaseAStart}`);
    console.log(`    After Phase A: ${phaseAEnd}`);
    console.log(`    After Phase B: ${phaseBEnd}`);

    console.log(`\n  Metrics:`);
    console.log(`  ┌──────────────────────────────┬─────────────┐`);
    console.log(`  │ Metric                       │ Value       │`);
    console.log(`  ├──────────────────────────────┼─────────────┤`);
    console.log(`  │ Degradation rate (Δ/req)     │ ${degRate.toFixed(4).padStart(11)} │`);
    console.log(`  │ Recovery rate (Δ/req)        │ ${recRate.toFixed(4).padStart(11)} │`);
    console.log(`  │ Hysteresis Ratio (rec/deg)   │ ${String(hysteresisRatio).padStart(11)} │`);
    console.log(`  │ Recovery Half-life (reqs)    │ ${String(halfLife).padStart(11)} │`);
    console.log(`  │ Recovery Time to 95% (reqs)  │ ${String(timeTo95).padStart(11)} │`);
    console.log(`  │ False Recovery Rate          │ ${(falseRecoveryRate * 100).toFixed(0).padStart(9)}%  │`);
    console.log(`  └──────────────────────────────┴─────────────┘`);

    // Symmetric comparison: recompute the full symmetric trajectory (α_sym both phases)
    let symRecomputed = 1.0;
    for (const r of records) {
      symRecomputed = ALPHA_SYMMETRIC * symRecomputed + (1 - ALPHA_SYMMETRIC) * r.overlap;
    }
    symRecomputed = Math.round(symRecomputed * 1000) / 1000;

    console.log(`\n  Asymmetric vs Symmetric (final stability):`);
    console.log(`    Asymmetric (α_degrade=${ALPHA_DEGRADE}, α_recover=${ALPHA_RECOVER}): ${phaseBEnd}`);
    console.log(`    Symmetric  (α=${ALPHA_SYMMETRIC}): ${symRecomputed}`);

    // Stability curve
    console.log('\n  Stability Curve:');
    const max = 1.0, min = Math.min(...records.map(r => r.stability)) - 0.02;
    const W = 50;
    for (let row = 0; row < 12; row++) {
      const y = max - (max - min) * (row / 11);
      let line = '  ';
      for (let col = 0; col < W; col++) {
        const idx = Math.floor(col / W * records.length);
        const s = records[idx]?.stability ?? 1.0;
        line += Math.abs(s - y) < (max - min) / 22 ? '●' : ' ';
      }
      console.log(line + ` ${y.toFixed(2)}`);
    }
    console.log('  ' + 'A'.repeat(Math.floor(W * PHASE_A_PROMPTS / records.length)) + 'B'.repeat(W - Math.floor(W * PHASE_A_PROMPTS / records.length)));
    console.log('  0'.padStart(0) + `${' '.repeat(W - 5)}${records.length}reqs`);

    // Save
    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0002F.2/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0002F.2',
      description: 'Recovery Dynamics & Hysteresis (asymmetric α)',
      timestamp: new Date().toISOString(),
      config: { alpha_degrade: ALPHA_DEGRADE, alpha_recover: ALPHA_RECOVER, alpha_symmetric: ALPHA_SYMMETRIC, threshold: THRESHOLD },
      phase_a: { prompts: PHASE_A_PROMPTS, avg_overlap: Math.round(avgPhaseAOverlap * 1000) / 1000 },
      phase_b: { prompts: PHASE_B_PROMPTS, avg_overlap: Math.round(avgPhaseBOverlap * 1000) / 1000 },
      metrics: {
        degradation_rate: Math.round(degRate * 10000) / 10000,
        recovery_rate: Math.round(recRate * 10000) / 10000,
        hysteresis_ratio: hysteresisRatio,
        recovery_half_life_reqs: halfLife,
        recovery_time_95_reqs: timeTo95,
        false_recovery_rate: Math.round(falseRecoveryRate * 1000) / 1000,
      },
      stability_trajectory: records.map(r => ({ phase: r.phase, request: r.request_id, overlap: r.overlap, stability: r.stability })),
    }, null, 2));
    console.log(`\n  📁 ${outDir}/summary.json\n`);

    for (const [id, node] of nodes) node.ws.close();
    wss.close();
    process.exit(0);
  }

  function asymStabilityAfter(recs: StepRecord[], phase: string): number {
    let s = 1.0;
    for (const r of recs) {
      if (r.phase !== phase) continue;
      s = ALPHA_DEGRADE * s + (1 - ALPHA_DEGRADE) * r.overlap;
    }
    return Math.round(s * 1000) / 1000;
  }

  console.log(`\n  🟢 Master on ws://localhost:${port}\n`);
  console.log('  Nodes needed: node-onnx (main), node-torch (drift shadow), node-onnx2 (recovery shadow)');
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts --master ws://localhost:${port} --node-id node-onnx  --backend onnx  --precision fp16`);
  console.log(`    python experiments/qwen3_0.6b/EXP-0002F.1/run_node_pytorch.py --master ws://localhost:${port} --node-id node-torch  --precision fp16`);
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts --master ws://localhost:${port} --node-id node-onnx2 --backend onnx  --precision fp16`);
  console.log();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
