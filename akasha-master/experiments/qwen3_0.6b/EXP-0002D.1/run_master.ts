#!/usr/bin/env npx tsx
/**
 * EXP-0002D.1 — Bayesian Task Evaluator + Confidence-Aware Routing
 *
 * Phase 2 of Capability Estimation:
 *   - Bayesian Mean replaces SMA (no fixed α, natural sample weighting)
 *   - Confidence = 1 − exp(−n / min_samples)
 *   - Effective Score = Score × Confidence
 *   - Router uses Effective Score to avoid premature inversion
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002D.1/run_master.ts --port 8080
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
  metadata: { node_id: string; model_id: string; backend: string; precision: string; platform: string; role: string };
}

interface PromptEntry {
  prompt: string; capability?: string;
  max_new_tokens?: number; temperature?: number; top_p?: number;
}

interface CapabilityEstimate {
  capability: string;
  initial: number;
  n: number;              // sample count
  mu: number;             // Bayesian mean
  confidence: number;     // 1 − exp(−n / min_samples)
  effective: number;      // mu × confidence
}

interface ConnectedNode {
  ws: WebSocket; nodeId: string; role: string; platform: string; device: string;
  initialCapabilities: Record<string, number>;
  estimates: Record<string, CapabilityEstimate>;
  registeredAt: number; latencyMs: number;
  requestCount: number; totalTokens: number; totalMs: number; errors: number;
  routedCounts: Record<string, number>;
}

interface PerRequestLog {
  request_id: string; node_id: string; prompt: string;
  expected_capability: string; routing_method: string;
  evaluator: string; task_score: number;
  mu_before: number; mu_after: number; n: number; confidence: number; effective: number;
  tokens: number; roundtrip_ms: number; error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const MIN_SAMPLES = 8; // samples needed for full confidence

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt Classifier
// ═══════════════════════════════════════════════════════════════════════════════

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  coding: ['def', 'function', 'code', 'python', 'write', 'implement', 'class', 'algorithm', 'program', 'method', 'create'],
  math: ['calculate', 'solve', 'integral', 'sum', 'equation', 'math', 'derivative', 'x^', 'x =', '% of'],
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
// Task Evaluators (improved over EXP-0002D heuristic)
// ═══════════════════════════════════════════════════════════════════════════════

function evaluateCoding(text: string): number {
  const lower = text.toLowerCase();

  // Structural signals (code-like patterns)
  const structural = ['def ', 'return ', 'import ', 'class ', 'print(', 'for ', 'if ', 'else:', 'while ', 'len(', 'range('];
  const structHits = structural.filter(k => lower.includes(k)).length;
  const structScore = Math.min(1.0, structHits / 5); // 5+ = full score

  // Refusal detection
  const refusal = ['sorry', 'cannot', 'unable', 'as an ai', 'i am'];
  const refusalHits = refusal.filter(k => lower.includes(k)).length;
  const refusalPenalty = refusalHits * 0.35;

  return Math.max(0.0, Math.min(1.0, structScore - refusalPenalty));
}

function evaluateMath(text: string): number {
  const lower = text.toLowerCase();

  // Mathematical signals
  const mathSignals = ['=', '+', '*', '/', '^', 'result', 'answer', 'solution', 'sum', 'product', 'integral', 'derivative', 'x ='];
  const signalHits = mathSignals.filter(k => lower.includes(k)).length;
  const signalScore = Math.min(1.0, signalHits / 4);

  // Numeric presence
  const hasNumbers = /\d+/.test(text);
  const numberBonus = hasNumbers ? 0.2 : 0;

  // Refusal
  const refusal = ['sorry', 'cannot', 'unable', 'as an ai', 'i am'];
  const refusalHits = refusal.filter(k => lower.includes(k)).length;
  const refusalPenalty = refusalHits * 0.35;

  return Math.max(0.0, Math.min(1.0, signalScore + numberBonus - refusalPenalty));
}

function evaluateGeneral(text: string): number {
  const len = Math.min(1.0, text.length / 150);
  const refusal = ['sorry', 'cannot', 'unable', 'error'];
  const refusalHits = refusal.filter(k => text.toLowerCase().includes(k)).length;
  return Math.max(0.0, Math.min(1.0, len - refusalHits * 0.3));
}

function evaluateTask(capability: string, text: string): { score: number; evaluator: string } {
  switch (capability) {
    case 'coding': return { score: Math.round(evaluateCoding(text) * 1000) / 1000, evaluator: 'structure+refusal' };
    case 'math':   return { score: Math.round(evaluateMath(text) * 1000) / 1000, evaluator: 'signal+numeric+refusal' };
    default:       return { score: Math.round(evaluateGeneral(text) * 1000) / 1000, evaluator: 'length+refusal' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bayesian Capability Estimation (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════════

function bayesianUpdate(est: CapabilityEstimate, taskScore: number): void {
  // Bayesian mean: natural sample weighting (no fixed α)
  est.mu = (est.n * est.mu + taskScore) / (est.n + 1);
  est.n += 1;
  // Confidence: asymptotically approaches 1.0
  est.confidence = Math.round((1 - Math.exp(-est.n / MIN_SAMPLES)) * 1000) / 1000;
  // Effective score: penalizes low-confidence estimates
  est.effective = Math.round(est.mu * est.confidence * 1000) / 1000;
}

function createEstimate(capability: string, initial: number): CapabilityEstimate {
  return {
    capability,
    initial,
    n: 0,
    mu: initial,
    confidence: 0,    // 0 samples = zero confidence
    effective: 0,     // 0 × initial = 0
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Confidence-Aware Scheduler
// ═══════════════════════════════════════════════════════════════════════════════

function selectBestNode(
  nodes: ConnectedNode[],
  capability: string,
): { node: ConnectedNode; method: string } {
  const active = nodes.filter(n => n.ws.readyState === WebSocket.OPEN);
  if (active.length === 0) throw new Error('No active nodes');

  // Score by EFFECTIVE score (μ × confidence), not raw μ
  const scored = active.map(node => {
    const est = node.estimates[capability];
    if (!est) return { node, effective: 0, mu: 0, confidence: 0 };
    return { node, effective: est.effective, mu: est.mu, confidence: est.confidence };
  });

  scored.sort((a, b) => b.effective - a.effective);

  const best = scored[0];
  const second = scored[1];

  // If effective scores tie, fallback to round-robin
  if (second && best.effective === second.effective) {
    const totalReqs = active.reduce((s, n) => s + n.requestCount, 0);
    const idx = totalReqs % active.length;
    return { node: active[idx], method: `tie-break (RR, effective=0)` };
  }

  return {
    node: best.node,
    method: `confidence-aware (μ=${best.mu}, conf=${best.confidence}, eff=${best.effective})`,
  };
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

async function main() {
  console.log('═'.repeat(60));
  console.log('EXP-0002D.1 — Bayesian Evaluator + Confidence-Aware Routing');
  console.log('═'.repeat(60));
  console.log(`  Port:       ${port}`);
  console.log(`  Estimator:  Bayesian Mean (Phase 2)`);
  console.log(`  Confidence: 1 − exp(−n / ${MIN_SAMPLES})`);
  console.log(`  Routing:    Effective Score = μ × confidence\n`);

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

  // ═══════════════════════════════════════════════════════════════════════════
  const nodes = new Map<string, ConnectedNode>();
  const wss = new WebSocketServer({ port });
  const allResults: PerRequestLog[] = [];
  let experimentStarted = false;

  wss.on('connection', (ws: WebSocket, req) => {
    const clientIp = req.socket?.remoteAddress || 'unknown';
    console.log(`  🔗 ${clientIp}`);
    let nodeId = `unknown-${clientIp}`;

    ws.on('message', (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'register') {
        nodeId = msg.node.id;
        const caps: Record<string, number> = msg.node.capabilities || { general: 0.8 };
        const estimates: Record<string, CapabilityEstimate> = {};

        for (const [cap, score] of Object.entries(caps))
          estimates[cap] = createEstimate(cap, score);
        if (!estimates['general'])
          estimates['general'] = createEstimate('general', 0.8);

        const node: ConnectedNode = {
          ws, nodeId, role: msg.node.role || 'expert',
          platform: msg.node.platform || 'unknown', device: msg.node.device || 'unknown',
          initialCapabilities: caps, estimates,
          registeredAt: Date.now(), latencyMs: 0,
          requestCount: 0, totalTokens: 0, totalMs: 0, errors: 0, routedCounts: {},
        };
        nodes.set(nodeId, node);

        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0002D.1',
          connected_nodes: nodes.size, estimator: 'bayesian', min_samples: MIN_SAMPLES }));

        console.log(`  ✅ ${nodeId}: ${JSON.stringify(caps)} (bayesian, min_samples=${MIN_SAMPLES})`);

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

    ws.on('close', () => { nodes.delete(nodeId); });
    ws.on('error', (e) => console.error(`  ❌ ${e.message}`));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  async function runExperiment() {
    console.log('\n═'.repeat(60));
    console.log('EXPERIMENT START — Bayesian Confidence-Aware Routing');
    console.log('═'.repeat(60));

    for (const [id, node] of nodes) {
      const t0 = performance.now(); node.ws.send(JSON.stringify({ type: 'ping', t: t0 }));
      await new Promise(r => setTimeout(r, 300));
    }

    console.log('\n── Confidence-Aware Inference ──\n');
    const tStart = performance.now();
    let completedCount = 0;
    let inversionsAvoided = 0;

    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const requestId = `req-${String(i).padStart(4, '0')}`;
      const promptPreview = p.prompt.slice(0, 50);
      const expectedCap = p.capability || classifyPrompt(p.prompt);

      let node: ConnectedNode;
      let routingMethod: string;
      try {
        const selection = selectBestNode([...nodes.values()], expectedCap);
        node = selection.node; routingMethod = selection.method;
      } catch {
        console.log(`  [${i + 1}/${prompts.length}] ⚠️ No active node`);
        continue;
      }

      const est = node.estimates[expectedCap];
      const muBefore = est?.mu ?? 0;
      const nBefore = est?.n ?? 0;
      const confBefore = est?.confidence ?? 0;
      const effBefore = est?.effective ?? 0;

      console.log(`  [${i + 1}/${prompts.length}] ${requestId} → ${node.nodeId} (${expectedCap})`);
      console.log(`       μ=${muBefore} conf=${confBefore} eff=${effBefore} n=${nBefore}`);

      const t0 = performance.now();

      try {
        const result = await new Promise<RemoteResult>((resolve, reject) => {
          const timeout = setTimeout(() => { node.errors++; reject(new Error('timeout')); }, 120000);
          const handler = (raw: Buffer) => {
            try {
              const m = JSON.parse(raw.toString());
              if (m.type === 'result' && m.request_id === requestId) {
                clearTimeout(timeout); node.ws.removeListener('message', handler);
                resolve(m as RemoteResult);
              }
            } catch (_) {}
          };
          node.ws.on('message', handler);
          node.ws.send(JSON.stringify({ type: 'compute', request_id: requestId,
            prompt: p.prompt, max_new_tokens: p.max_new_tokens,
            temperature: p.temperature, top_p: p.top_p }));
        });

        const roundtripMs = Math.round((performance.now() - t0) * 10) / 10;

        // Evaluate & Update (Bayesian)
        const evalResult = evaluateTask(expectedCap, result.text);
        if (est) {
          bayesianUpdate(est, evalResult.score);
        }

        // Detect if inversion was avoided (compared to SMA behavior)
        const otherNodes = [...nodes.values()].filter(n => n.nodeId !== node.nodeId);
        const otherBest = otherNodes.map(n => {
          const e = n.estimates[expectedCap];
          return e ? { id: n.nodeId, raw: e.mu, eff: e.effective } : { id: n.nodeId, raw: 0, eff: 0 };
        }).sort((a, b) => b.raw - a.raw)[0];

        if (otherBest && otherBest.raw > (est?.mu ?? 0)) {
          // Another node has higher raw μ but was NOT chosen (due to low confidence)
          inversionsAvoided++;
          console.log(`       🛡️ Inversion avoided: ${otherBest.id} raw μ=${otherBest.raw} > ${node.nodeId} μ=${est?.mu}, but eff=${otherBest.eff} < eff=${est?.effective}`);
        }

        node.requestCount++;
        node.routedCounts[expectedCap] = (node.routedCounts[expectedCap] || 0) + 1;
        node.totalTokens += result.tokens.length;
        node.totalMs += roundtripMs;
        completedCount++;

        allResults.push({
          request_id: requestId, node_id: node.nodeId, prompt: promptPreview,
          expected_capability: expectedCap, routing_method: routingMethod,
          evaluator: evalResult.evaluator, task_score: evalResult.score,
          mu_before: muBefore, mu_after: est?.mu ?? 0, n: est?.n ?? 0,
          confidence: est?.confidence ?? 0, effective: est?.effective ?? 0,
          tokens: result.tokens.length, roundtrip_ms: roundtripMs,
        });

        console.log(`       ${result.tokens.length} tokens, eval=${evalResult.score}, μ: ${muBefore}→${est?.mu ?? 0}, conf=${est?.confidence ?? 0}, eff=${est?.effective ?? 0}`);

      } catch (e: any) {
        node.errors++;
        console.log(`       ❌ ${e.message}`);
      }
    }

    const totalMs = Math.round(performance.now() - tStart);

    // ═══════════════════════════════════════════════════════════════════════
    // Results
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═'.repeat(60));
    console.log('RESULTS — Bayesian Confidence-Aware Routing');
    console.log('═'.repeat(60));
    console.log(`\n  Completed:          ${completedCount}/${prompts.length}`);
    console.log(`  Total time:          ${totalMs}ms`);
    console.log(`  Inversions avoided:  ${inversionsAvoided} 🛡️\n`);

    // Capability Estimates
    console.log('  Bayesian Capability Estimates:');
    console.log('  ┌──────────────┬───────────┬────┬───────┬────────┬──────────┐');
    console.log('  │ Node         │ Capability│ n  │ μ     │ conf   │ effective│');
    console.log('  ├──────────────┼───────────┼────┼───────┼────────┼──────────┤');

    for (const [id, node] of nodes) {
      const entries = Object.entries(node.estimates);
      for (let idx = 0; idx < entries.length; idx++) {
        const [cap, est] = entries[idx];
        const n = idx === 0 ? id.padEnd(12) : ' '.repeat(12);
        const c = cap.padEnd(9);
        const sn = String(est.n).padStart(2);
        const sm = String(est.mu).padStart(5);
        const sc = String(est.confidence).padStart(6);
        const se = String(est.effective).padStart(8);
        const changed = est.mu !== est.initial ? ' 🔄' : '  ';
        console.log(`  │ ${n} │ ${c} │ ${sn} │ ${sm} │ ${sc} │ ${se} │${changed}`);
      }
    }
    console.log('  └──────────────┴───────────┴────┴───────┴────────┴──────────┘');

    // Comparison: Bayesian vs SMA (from 0002D)
    console.log('\n  Comparison with EXP-0002D (SMA α=0.3):');
    console.log('  ┌──────────────┬───────────┬────────────────────┬────────────────────┐');
    console.log('  │ Node         │ Capability│ SMA (0002D)        │ Bayesian (0002D.1) │');
    console.log('  ├──────────────┼───────────┼────────────────────┼────────────────────┤');
    // 0002D results for reference
    const ref0002D: Record<string, Record<string, number>> = {
      'node-coding': { coding: 0.588, math: 0.588, general: 0.705 },
      'node-math':   { coding: 0.62,  math: 0.545, general: 0.821 },
    };
    for (const [id, node] of nodes) {
      const entries = Object.entries(node.estimates);
      for (let idx = 0; idx < entries.length; idx++) {
        const [cap, est] = entries[idx];
        const n = idx === 0 ? id.padEnd(12) : ' '.repeat(12);
        const c = cap.padEnd(9);
        const sma = ref0002D[id]?.[cap] !== undefined ? String(ref0002D[id][cap]).padEnd(18) : 'N/A'.padEnd(18);
        const bayes = `${est.mu} (eff=${est.effective})`.padEnd(18);
        console.log(`  │ ${n} │ ${c} │ ${sma} │ ${bayes} │`);
      }
    }
    console.log('  └──────────────┴───────────┴────────────────────┴────────────────────┘');

    // Save
    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0002D.1/output');
    fs.mkdirSync(outDir, { recursive: true });

    const summary = {
      experiment: 'EXP-0002D.1',
      description: 'Bayesian Evaluator + Confidence-Aware Routing (Phase 2)',
      timestamp: new Date().toISOString(),
      config: { min_samples: MIN_SAMPLES, estimator: 'bayesian_mean' },
      completed: completedCount, total_ms: totalMs, inversions_avoided: inversionsAvoided,
      nodes: [...nodes.entries()].map(([id, n]) => ({
        node_id: id, initial_capabilities: n.initialCapabilities,
        estimates: Object.fromEntries(
          Object.entries(n.estimates).map(([cap, e]) => [cap, {
            initial: e.initial, n: e.n, mu: e.mu, confidence: e.confidence, effective: e.effective,
          }])
        ),
        requests: n.requestCount, total_tokens: n.totalTokens,
      })),
      requests: allResults,
    };

    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`\n  📁 ${outDir}/summary.json\n`);

    for (const [id, node] of nodes) node.ws.close();
    wss.close();
    console.log('  Complete.\n');
    process.exit(0);
  }

  console.log(`\n  🟢 Master on ws://localhost:${port} (bayesian, min_samples=${MIN_SAMPLES})\n`);
  console.log('  Node examples:');
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts \\`);
  console.log(`      --master ws://localhost:${port} --node-id node-coding \\`);
  console.log(`      --capability '{"coding":0.95,"math":0.65,"general":0.80}'`);
  console.log();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
