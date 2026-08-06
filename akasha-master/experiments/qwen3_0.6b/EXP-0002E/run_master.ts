#!/usr/bin/env npx tsx
/**
 * EXP-0002E — Composite Score Routing
 *
 * Integrates EXP-0001 (Stability) + EXP-0002D.1 (Confidence) + EXP-0002A (Latency)
 * into a single composite routing score.
 *
 * Score = w_cap × Capability(effective) + w_lat × Latency(1−norm) + w_stab × Stability(backend)
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002E/run_master.ts --port 8080
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

interface PromptEntry {
  prompt: string; capability?: string;
  max_new_tokens?: number; temperature?: number; top_p?: number;
}

interface CapabilityEstimate {
  initial: number; n: number; mu: number; confidence: number; effective: number;
}

interface ConnectedNode {
  ws: WebSocket; nodeId: string; role: string; platform: string;
  backend: string; precision: string;
  initialCapabilities: Record<string, number>;
  estimates: Record<string, CapabilityEstimate>;
  stability: number;
  latencyMs: number;
  requestCount: number; totalTokens: number; totalMs: number; errors: number;
  routedCounts: Record<string, number>;
}

interface PerRequestLog {
  request_id: string; node_id: string; prompt: string;
  expected_capability: string; routing_method: string;
  cap_eff: number; lat_score: number; stab: number; composite: number;
  tokens: number; roundtrip_ms: number; error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXP-0001 Stability Profiles
// ═══════════════════════════════════════════════════════════════════════════════

const STABILITY_DB: Record<string, number> = {
  'mps-fp16': 0.992,
  'mps-fp32': 1.000,
  'mps-bf16': 0.791,
  'cpu-fp32': 1.000,
  'cpu-fp16': 0.992,
  'onnx-fp16': 0.992,
  'onnx-fp32': 1.000,
  'webgpu-fp16': 0.985,
  'unknown': 0.95,
};

function getStability(backend: string, precision: string): number {
  const key = `${backend.toLowerCase()}-${precision.toLowerCase()}`;
  return STABILITY_DB[key] ?? STABILITY_DB['unknown'];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Composite Score Weights (configurable)
// ═══════════════════════════════════════════════════════════════════════════════

const WEIGHTS = {
  capability: 0.40,
  confidence: 0.15,
  latency: 0.15,
  stability: 0.30,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Confidence (from 0002D.1)
// ═══════════════════════════════════════════════════════════════════════════════

const MIN_SAMPLES = 8;

function confidenceFromN(n: number): number {
  return Math.round((1 - Math.exp(-n / MIN_SAMPLES)) * 1000) / 1000;
}

function bayesianUpdate(est: CapabilityEstimate, taskScore: number): void {
  est.mu = Math.round(((est.n * est.mu + taskScore) / (est.n + 1)) * 1000) / 1000;
  est.n += 1;
  est.confidence = confidenceFromN(est.n);
  est.effective = Math.round(est.mu * est.confidence * 1000) / 1000;
}

function createEstimate(initial: number): CapabilityEstimate {
  return { initial, n: 0, mu: initial, confidence: 0, effective: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt Classifier
// ═══════════════════════════════════════════════════════════════════════════════

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  coding: ['def', 'function', 'code', 'python', 'write', 'implement', 'class', 'algorithm'],
  math: ['calculate', 'solve', 'integral', 'sum', 'equation', 'math', 'derivative'],
};

function classifyPrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  const scores: Record<string, number> = {};
  for (const [cap, kws] of Object.entries(CAPABILITY_KEYWORDS))
    scores[cap] = kws.filter(k => lower.includes(k.toLowerCase())).length;
  let best = 'general', bestScore = 0;
  for (const [cap, s] of Object.entries(scores))
    if (s > bestScore) { best = cap; bestScore = s; }
  return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Task Evaluators
// ═══════════════════════════════════════════════════════════════════════════════

function evaluateCoding(text: string): number {
  const structural = ['def ', 'return ', 'import ', 'class ', 'print(', 'for ', 'if '];
  const hits = structural.filter(k => text.toLowerCase().includes(k)).length;
  const refusal = ['sorry', 'cannot', 'unable', 'as an ai'];
  const refHits = refusal.filter(k => text.toLowerCase().includes(k)).length;
  return Math.max(0, Math.min(1, hits / 5 - refHits * 0.35));
}

function evaluateMath(text: string): number {
  const signals = ['=', '+', '*', '/', '^', 'result', 'answer', 'solution'];
  const hits = signals.filter(k => text.toLowerCase().includes(k)).length;
  const hasNums = /\d+/.test(text) ? 0.2 : 0;
  const refusal = ['sorry', 'cannot', 'unable', 'as an ai'];
  const refHits = refusal.filter(k => text.toLowerCase().includes(k)).length;
  return Math.max(0, Math.min(1, hits / 4 + hasNums - refHits * 0.35));
}

function evaluateGeneral(text: string): number {
  return Math.max(0, Math.min(1, text.length / 150));
}

function evaluateTask(capability: string, text: string): number {
  switch (capability) {
    case 'coding': return Math.round(evaluateCoding(text) * 1000) / 1000;
    case 'math':   return Math.round(evaluateMath(text) * 1000) / 1000;
    default:       return Math.round(evaluateGeneral(text) * 1000) / 1000;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Composite Score Scheduler
// ═══════════════════════════════════════════════════════════════════════════════

function compositeScore(node: ConnectedNode, capability: string): {
  capEff: number; latScore: number; stab: number; composite: number; breakdown: string;
} {
  const est = node.estimates[capability];
  const capEff = est?.effective ?? 0;
  const confidence = est?.confidence ?? 0;

  // Latency: normalize across nodes (1.0 = fastest, 0.0 = slowest)
  const maxLat = Math.max(1, ...[...nodes.values()].map(n => n.latencyMs));
  const latScore = node.latencyMs > 0 ? Math.round((1 - node.latencyMs / maxLat) * 1000) / 1000 : 0.5;

  const stab = node.stability;

  const composite = Math.round((
    WEIGHTS.capability * capEff +
    WEIGHTS.confidence * confidence +
    WEIGHTS.latency * latScore +
    WEIGHTS.stability * stab
  ) * 1000) / 1000;

  const breakdown = `C=${capEff}×${WEIGHTS.capability} + conf=${confidence}×${WEIGHTS.confidence} + L=${latScore}×${WEIGHTS.latency} + S=${stab}×${WEIGHTS.stability}`;

  return { capEff, latScore, stab, composite, breakdown };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const port = parseInt(getArg('--port', '8080'), 10);
const promptFile = getArg('--prompts', path.resolve('experiments/qwen3_0.6b/EXP-0002C/prompts.jsonl'));

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

const nodes = new Map<string, ConnectedNode>();

async function main() {
  console.log('═'.repeat(60));
  console.log('EXP-0002E — Composite Score Routing');
  console.log('═'.repeat(60));
  console.log(`  Weights: C=${WEIGHTS.capability} Conf=${WEIGHTS.confidence} L=${WEIGHTS.latency} S=${WEIGHTS.stability}`);
  console.log(`  Stability DB: ${Object.keys(STABILITY_DB).length} profiles (from EXP-0001)\n`);

  const prompts: PromptEntry[] = [];
  for (const line of fs.readFileSync(promptFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line);
    prompts.push({
      prompt: raw.prompt, capability: raw.capability,
      max_new_tokens: raw.max_new_tokens || 32,
      temperature: raw.temperature ?? 0, top_p: raw.top_p ?? 1,
    });
  }
  console.log(`  Loaded ${prompts.length} prompts\n`);

  const wss = new WebSocketServer({ port });
  const allResults: PerRequestLog[] = [];
  let experimentStarted = false;

  wss.on('connection', (ws: WebSocket, req) => {
    const clientIp = req.socket?.remoteAddress || 'unknown';
    let nodeId = `unknown-${clientIp}`;

    ws.on('message', (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'register') {
        nodeId = msg.node.id;
        const caps: Record<string, number> = msg.node.capabilities || { general: 0.8 };
        const backend = msg.node.backend || 'cpu';
        const precision = msg.node.precision || 'fp16';
        const stability = getStability(backend, precision);
        const estimates: Record<string, CapabilityEstimate> = {};

        for (const [cap, score] of Object.entries(caps))
          estimates[cap] = createEstimate(score);
        if (!estimates['general']) estimates['general'] = createEstimate(0.8);

        const node: ConnectedNode = {
          ws, nodeId, role: msg.node.role || 'expert',
          platform: msg.node.platform || 'unknown', backend, precision,
          initialCapabilities: caps, estimates, stability, latencyMs: 0,
          requestCount: 0, totalTokens: 0, totalMs: 0, errors: 0, routedCounts: {},
        };
        nodes.set(nodeId, node);

        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0002E',
          backend, precision, stability, weights: WEIGHTS }));

        console.log(`  ✅ ${nodeId}: ${backend}/${precision} (stability=${stability}), caps=${JSON.stringify(caps)}`);

        if (nodes.size >= 2 && !experimentStarted) {
          experimentStarted = true;
          setTimeout(() => runExperiment(), 1500);
        }
        return;
      }

      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); return; }
      if (msg.type === 'pong') {
        const node = nodes.get(nodeId);
        if (node && msg.t) node.latencyMs = Math.round((performance.now() - msg.t) * 10) / 10;
        return;
      }
    });

    ws.on('close', () => nodes.delete(nodeId));
    ws.on('error', () => {});
  });

  // ═══════════════════════════════════════════════════════════════════════════
  async function runExperiment() {
    console.log('\n═'.repeat(60));
    console.log('EXPERIMENT START — Composite Score Routing');
    console.log('═'.repeat(60));

    // Latency baseline
    for (const [id, node] of nodes) {
      const t0 = performance.now(); node.ws.send(JSON.stringify({ type: 'ping', t: t0 }));
      await new Promise(r => setTimeout(r, 300));
    }

    console.log('\n  Node Profiles:');
    console.log('  ┌──────────────┬──────────┬────────┬──────────┬──────────┐');
    console.log('  │ Node         │ Backend  │ Prec   │ Stability│ Latency  │');
    console.log('  ├──────────────┼──────────┼────────┼──────────┼──────────┤');
    for (const [id, node] of nodes) {
      console.log(`  │ ${id.padEnd(12)} │ ${node.backend.padEnd(8)} │ ${node.precision.padEnd(6)} │ ${String(node.stability).padEnd(8)} │ ${String(node.latencyMs+'ms').padEnd(8)} │`);
    }
    console.log('  └──────────────┴──────────┴────────┴──────────┴──────────┘\n');

    console.log('── Composite Score Inference ──\n');
    const tStart = performance.now();
    let completedCount = 0;

    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const requestId = `req-${String(i).padStart(4, '0')}`;
      const promptPreview = p.prompt.slice(0, 50);
      const expectedCap = p.capability || classifyPrompt(p.prompt);

      // Score all nodes
      const active = [...nodes.values()].filter(n => n.ws.readyState === WebSocket.OPEN);
      const scored = active.map(n => ({ node: n, ...compositeScore(n, expectedCap) }));
      scored.sort((a, b) => b.composite - a.composite);
      const best = scored[0];

      console.log(`  [${i + 1}/${prompts.length}] ${requestId} → ${best.node.nodeId} (${expectedCap})`);
      console.log(`       ${best.breakdown} = ${best.composite}`);

      // Show comparison if stability makes the difference
      if (scored.length > 1) {
        const second = scored[1];
        const capDiff = (best.capEff - second.capEff).toFixed(3);
        const stabDiff = (best.stab - second.stab).toFixed(3);
        if (best.composite > second.composite && best.capEff <= second.capEff) {
          console.log(`       ⚡ Stability wins: ${best.node.nodeId}(S=${best.stab}) > ${second.node.nodeId}(S=${second.stab}) despite lower capability (Δcap=${capDiff}, Δstab=${stabDiff})`);
        }
      }

      const t0 = performance.now();

      try {
        const result = await new Promise<RemoteResult>((resolve, reject) => {
          const timeout = setTimeout(() => { best.node.errors++; reject(new Error('timeout')); }, 120000);
          const handler = (raw: Buffer) => {
            try {
              const m = JSON.parse(raw.toString());
              if (m.type === 'result' && m.request_id === requestId) {
                clearTimeout(timeout); best.node.ws.removeListener('message', handler);
                resolve(m as RemoteResult);
              }
            } catch (_) {}
          };
          best.node.ws.on('message', handler);
          best.node.ws.send(JSON.stringify({ type: 'compute', request_id: requestId,
            prompt: p.prompt, max_new_tokens: p.max_new_tokens,
            temperature: p.temperature, top_p: p.top_p }));
        });

        const roundtripMs = Math.round((performance.now() - t0) * 10) / 10;
        const taskScore = evaluateTask(expectedCap, result.text);

        // Bayesian update
        const est = best.node.estimates[expectedCap];
        if (est) bayesianUpdate(est, taskScore);

        best.node.requestCount++;
        best.node.routedCounts[expectedCap] = (best.node.routedCounts[expectedCap] || 0) + 1;
        best.node.totalTokens += result.tokens.length;
        best.node.totalMs += roundtripMs;
        completedCount++;

        allResults.push({
          request_id: requestId, node_id: best.node.nodeId, prompt: promptPreview,
          expected_capability: expectedCap, routing_method: `composite=${best.composite}`,
          cap_eff: best.capEff, lat_score: best.latScore, stab: best.stab, composite: best.composite,
          tokens: result.tokens.length, roundtrip_ms: roundtripMs,
        });

        console.log(`       ${result.tokens.length} tokens, RTT=${roundtripMs}ms`);

      } catch (e: any) {
        best.node.errors++;
        console.log(`       ❌ ${e.message}`);
      }
    }

    const totalMs = Math.round(performance.now() - tStart);

    // ═══════════════════════════════════════════════════════════════════════
    // Results
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═'.repeat(60));
    console.log('RESULTS — Composite Score Routing');
    console.log('═'.repeat(60));
    console.log(`\n  Completed:  ${completedCount}/${prompts.length}`);
    console.log(`  Total time:  ${totalMs}ms\n`);

    console.log('  Node Composite Profiles:');
    console.log('  ┌──────────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('  │ Node         │ Cap(eff) │ Stability│ Latency  │ Reqs     │ Tokens   │');
    console.log('  ├──────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

    for (const [id, node] of nodes) {
      const caps = Object.values(node.estimates);
      const avgEff = caps.length > 0 ? Math.round(caps.reduce((s, e) => s + e.effective, 0) / caps.length * 1000) / 1000 : 0;
      const n = id.padEnd(12);
      const ce = String(avgEff).padEnd(8);
      const st = String(node.stability).padEnd(8);
      const lt = String(node.latencyMs + 'ms').padEnd(8);
      const rq = String(node.requestCount).padEnd(8);
      const tk = String(node.totalTokens).padEnd(8);
      console.log(`  │ ${n} │ ${ce} │ ${st} │ ${lt} │ ${rq} │ ${tk} │`);
    }
    console.log('  └──────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

    // Stability impact analysis
    const stabilityWins = allResults.filter(r => {
      const chosen = nodes.get(r.node_id);
      const others = [...nodes.values()].filter(n => n.nodeId !== r.node_id);
      return chosen && others.some(o => o.stability < chosen!.stability);
    }).length;

    console.log(`\n  Stability impact: ${stabilityWins}/${allResults.length} requests where stability influenced routing`);
    console.log(`  Weight distribution: C=${WEIGHTS.capability} Conf=${WEIGHTS.confidence} L=${WEIGHTS.latency} S=${WEIGHTS.stability}`);

    // Save
    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0002E/output');
    fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0002E',
      description: 'Composite Score Routing (Capability + Confidence + Latency + Stability)',
      timestamp: new Date().toISOString(),
      config: { weights: WEIGHTS, stability_db: STABILITY_DB },
      completed: completedCount, total_ms: totalMs,
      nodes: [...nodes.entries()].map(([id, n]) => ({
        node_id: id, backend: n.backend, precision: n.precision,
        stability: n.stability, latency_ms: n.latencyMs,
        requests: n.requestCount, total_tokens: n.totalTokens,
      })),
      requests: allResults,
    }, null, 2));

    console.log(`\n  📁 ${outDir}/summary.json\n`);
    for (const [id, node] of nodes) node.ws.close();
    wss.close();
    console.log('  Complete.\n');
    process.exit(0);
  }

  console.log(`\n  🟢 Master on ws://localhost:${port} (composite score)\n`);
  console.log('  Node examples (add --backend and --precision):');
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts \\`);
  console.log(`      --master ws://localhost:${port} --node-id node-fp16 \\`);
  console.log(`      --backend mps --precision fp16 \\`);
  console.log(`      --capability '{"coding":0.95,"math":0.65}'`);
  console.log();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
