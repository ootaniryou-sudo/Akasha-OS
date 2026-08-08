#!/usr/bin/env npx tsx
/**
 * EXP-0002D — Adaptive Capability Master Hub
 *
 * Extends EXP-0002C with:
 *   - TaskEvaluator: heuristic quality scoring per response
 *   - ProfileUpdater: SMA (simple moving average) score recalculation
 *   - Tracks initial → measured → adaptive score transitions
 *
 * Static Profile → Measured Performance → Adaptive Profile
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002D/run_master.ts --port 8080
 */

import WebSocket, { WebSocketServer } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface RemoteResult {
  type: 'result'; request_id: string; tokens: number[]; text: string;
  timing: { tokenize_ms: number; prefill_ms: number; decode_ms: number; total_ms: number };
  metadata: { node_id: string; model_id: string; backend: string; precision: string; platform: string; role: string; capabilities?: Record<string, number> };
}

interface PromptEntry {
  prompt: string; capability?: string;
  max_new_tokens?: number; temperature?: number; top_p?: number;
}

interface CapabilityHistory {
  capability: string;
  initial: number;
  scores: number[];      // per-task scores
  adaptive: number;       // current SMA
}

interface ConnectedNode {
  ws: WebSocket; nodeId: string; role: string; platform: string; device: string;
  initialCapabilities: Record<string, number>;
  adaptiveCapabilities: Record<string, number>;
  history: Record<string, CapabilityHistory>;
  registeredAt: number; latencyMs: number;
  requestCount: number; totalTokens: number; totalMs: number; errors: number;
  routedCounts: Record<string, number>;
  scoreDelta: number; // sum of absolute changes
}

interface PerRequestLog {
  request_id: string; node_id: string; prompt: string;
  expected_capability: string; routing_method: string;
  task_score: number; capability_before: number; capability_after: number; delta: number;
  tokens: number; roundtrip_ms: number; node_total_ms: number; network_ms: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt Classifier (same as EXP-0002C)
// ═══════════════════════════════════════════════════════════════════════════════

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  coding: ['def', 'function', 'code', 'python', 'write', 'implement', 'class', 'algorithm', 'program', 'method', 'create'],
  math: ['calculate', 'solve', 'integral', 'sum', 'equation', 'math', 'derivative', 'x^', 'x =', 'solve', '% of'],
};

function classifyPrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  const scores: Record<string, number> = {};
  for (const [capability, keywords] of Object.entries(CAPABILITY_KEYWORDS)) {
    scores[capability] = keywords.filter(kw => lower.includes(kw.toLowerCase())).length;
  }
  let best = 'general'; let bestScore = 0;
  for (const [cap, score] of Object.entries(scores)) {
    if (score > bestScore) { best = cap; bestScore = score; }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Task Evaluator (heuristic quality scoring)
// ═══════════════════════════════════════════════════════════════════════════════

const QUALITY_KEYWORDS: Record<string, { positive: string[]; negative: string[] }> = {
  coding: {
    positive: ['def', 'return', 'import', 'class', 'print', 'for', 'if', 'len', 'range', 'lambda', ':', '()', '='],
    negative: ['sorry', 'cannot', 'unable', 'error', 'I am', 'as an AI'],
  },
  math: {
    positive: ['=', '+', '-', '*', '/', 'x', '^', 'result', 'answer', 'solution', 'sum', 'product', 'integral'],
    negative: ['sorry', 'cannot', 'unable', 'error', 'I am', 'as an AI'],
  },
  general: {
    positive: ['.', ','],
    negative: ['error'],
  },
};

function evaluateTask(capability: string, text: string): number {
  const lower = text.toLowerCase();
  const rules = QUALITY_KEYWORDS[capability] || QUALITY_KEYWORDS['general'];

  // Positive signals
  const posHits = rules.positive.filter(kw => lower.includes(kw.toLowerCase())).length;
  const posScore = Math.min(1.0, posHits / Math.max(1, rules.positive.length) * 1.5);

  // Negative signals (hallucination, refusal)
  const negHits = rules.negative.filter(kw => lower.includes(kw.toLowerCase())).length;
  const negPenalty = negHits * 0.3;

  // Length bonus (very short responses are often low quality)
  const lengthScore = Math.min(1.0, text.length / 200);

  // Combine
  let score = posScore * 0.5 + lengthScore * 0.5 - negPenalty;
  return Math.max(0.0, Math.min(1.0, score));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Profile Updater (SMA)
// ═══════════════════════════════════════════════════════════════════════════════

const ALPHA = 0.3; // learning rate for SMA

function updateCapability(history: CapabilityHistory, taskScore: number): { newScore: number; delta: number } {
  const oldScore = history.adaptive;
  const newScore = ALPHA * taskScore + (1 - ALPHA) * oldScore;
  history.scores.push(taskScore);
  history.adaptive = Math.round(newScore * 1000) / 1000;
  return { newScore: history.adaptive, delta: Math.round((history.adaptive - oldScore) * 1000) / 1000 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Capability Scheduler (same as EXP-0002C, but uses adaptive scores)
// ═══════════════════════════════════════════════════════════════════════════════

function selectBestNode(
  nodes: ConnectedNode[],
  capability: string,
  useAdaptive: boolean,
): { node: ConnectedNode; method: string } {
  const active = nodes.filter(n => n.ws.readyState === WebSocket.OPEN);
  if (active.length === 0) throw new Error('No active nodes');

  const scored = active.map(node => {
    const caps = useAdaptive ? node.adaptiveCapabilities : node.initialCapabilities;
    const score = caps[capability] ?? caps['general'] ?? 0.5;
    return { node, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if (second && best.score === second.score) {
    const totalReqs = active.reduce((s, n) => s + n.requestCount, 0);
    const idx = totalReqs % active.length;
    return { node: active[idx], method: `tie-break (RR, score=${best.score})` };
  }

  const profileType = useAdaptive ? 'adaptive' : 'initial';
  return { node: best.node, method: `capability-match (${profileType} ${capability}=${best.score})` };
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
const useAdaptive = !args.includes('--no-adaptive');

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(60));
  console.log('EXP-0002D — Adaptive Capability Master Hub');
  console.log('═'.repeat(60));
  console.log(`  Port:     ${port}`);
  console.log(`  Adaptive: ${useAdaptive ? 'ON (α=' + ALPHA + ')' : 'OFF (static only)'}`);
  console.log(`  Policy:   Capability-Aware → Adaptive Profile\n`);

  // Load prompts
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
  // Node Registry
  // ═══════════════════════════════════════════════════════════════════════════
  const nodes = new Map<string, ConnectedNode>();

  // ═══════════════════════════════════════════════════════════════════════════
  // WebSocket Server
  // ═══════════════════════════════════════════════════════════════════════════
  const wss = new WebSocketServer({ port });
  const allResults: PerRequestLog[] = [];
  let experimentStarted = false;

  wss.on('connection', (ws: WebSocket, req) => {
    const clientIp = req.socket?.remoteAddress || 'unknown';
    console.log(`  🔗 New connection from ${clientIp}`);
    let nodeId = `unknown-${clientIp}`;

    ws.on('message', (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'register') {
        nodeId = msg.node.id;
        const initialCaps: Record<string, number> = msg.node.capabilities || { general: 0.8 };
        const adaptiveCaps = { ...initialCaps };
        const history: Record<string, CapabilityHistory> = {};

        for (const [cap, score] of Object.entries(initialCaps)) {
          history[cap] = { capability: cap, initial: score, scores: [], adaptive: score };
        }
        if (!history['general']) {
          history['general'] = { capability: 'general', initial: 0.8, scores: [], adaptive: 0.8 };
          adaptiveCaps['general'] = 0.8;
        }

        const node: ConnectedNode = {
          ws, nodeId, role: msg.node.role || 'expert',
          platform: msg.node.platform || 'unknown', device: msg.node.device || 'unknown',
          initialCapabilities: initialCaps, adaptiveCapabilities: adaptiveCaps, history,
          registeredAt: Date.now(), latencyMs: 0,
          requestCount: 0, totalTokens: 0, totalMs: 0, errors: 0,
          routedCounts: {}, scoreDelta: 0,
        };
        nodes.set(nodeId, node);

        const strongest = Object.entries(initialCaps).sort((a, b) => b[1] - a[1])[0];

        ws.send(JSON.stringify({
          type: 'register_ack', node_id: nodeId, master: 'EXP-0002D',
          connected_nodes: nodes.size, routed_as: strongest?.[0] || 'general',
          adaptive: useAdaptive,
        }));

        console.log(`  ✅ Registered: ${nodeId}`);
        console.log(`     Initial: ${JSON.stringify(initialCaps)}`);
        console.log(`     Mode: ${useAdaptive ? 'adaptive (will update from measured)' : 'static'}`);

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

    ws.on('close', () => { console.log(`  🔌 ${nodeId}`); nodes.delete(nodeId); });
    ws.on('error', (e) => console.error(`  ❌ ${nodeId}: ${e.message}`));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Experiment Runner
  // ═══════════════════════════════════════════════════════════════════════════

  async function runExperiment() {
    console.log('\n═'.repeat(60));
    console.log('EXPERIMENT START — Adaptive Capability Routing');
    console.log('═'.repeat(60));

    // ── Latency check ──────────────────────────────────────────────────
    for (const [id, node] of nodes) {
      const t0 = performance.now(); node.ws.send(JSON.stringify({ type: 'ping', t: t0 }));
      await new Promise(r => setTimeout(r, 300));
      console.log(`  📡 ${id}: ${node.latencyMs}ms RTT`);
    }

    // ── Run prompts ────────────────────────────────────────────────────
    console.log('\n── Adaptive Inference ──\n');
    const tStart = performance.now();
    let completedCount = 0;

    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const requestId = `req-${String(i).padStart(4, '0')}`;
      const promptPreview = p.prompt.slice(0, 50);
      const expectedCap = p.capability || classifyPrompt(p.prompt);

      let node: ConnectedNode;
      let routingMethod: string;
      try {
        const selection = selectBestNode([...nodes.values()], expectedCap, useAdaptive);
        node = selection.node; routingMethod = selection.method;
      } catch {
        console.log(`  [${i + 1}/${prompts.length}] ⚠️ No active node`);
        continue;
      }

      const capBefore = useAdaptive
        ? node.adaptiveCapabilities[expectedCap] ?? node.adaptiveCapabilities['general'] ?? 0.5
        : node.initialCapabilities[expectedCap] ?? node.initialCapabilities['general'] ?? 0.5;

      console.log(`  [${i + 1}/${prompts.length}] ${requestId} → ${node.nodeId} (${expectedCap})`);

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
        const networkMs = Math.round((roundtripMs - result.timing.total_ms) * 10) / 10;

        // ── Evaluate & Update ─────────────────────────────────────────
        const taskScore = Math.round(evaluateTask(expectedCap, result.text) * 1000) / 1000;
        let capAfter = capBefore;
        let delta = 0;

        if (useAdaptive && node.history[expectedCap]) {
          const update = updateCapability(node.history[expectedCap], taskScore);
          capAfter = update.newScore;
          delta = update.delta;
          node.adaptiveCapabilities[expectedCap] = capAfter;
          node.scoreDelta += Math.abs(delta);
        }

        node.requestCount++;
        node.routedCounts[expectedCap] = (node.routedCounts[expectedCap] || 0) + 1;
        node.totalTokens += result.tokens.length;
        node.totalMs += roundtripMs;
        completedCount++;

        allResults.push({
          request_id: requestId, node_id: node.nodeId, prompt: promptPreview,
          expected_capability: expectedCap, routing_method: routingMethod,
          task_score: taskScore, capability_before: capBefore,
          capability_after: capAfter, delta,
          tokens: result.tokens.length, roundtrip_ms: roundtripMs,
          node_total_ms: result.timing.total_ms, network_ms: networkMs,
        });

        const deltaStr = delta !== 0 ? ` (${delta >= 0 ? '+' : ''}${delta})` : '';
        console.log(`       ${result.tokens.length} tokens, RTT=${roundtripMs}ms, score=${taskScore}, ${expectedCap}: ${capBefore}→${capAfter}${deltaStr}`);

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
    console.log('RESULTS — Adaptive Capability Routing');
    console.log('═'.repeat(60));

    console.log(`\n  Completed:  ${completedCount}/${prompts.length}`);
    console.log(`  Total time:  ${totalMs}ms`);
    console.log(`  Adaptive:    ${useAdaptive ? 'ON (α=' + ALPHA + ')' : 'OFF'}\n`);

    // Capability Evolution
    console.log('  Capability Score Evolution:');
    console.log('  ┌──────────────┬───────────┬──────────────────────────────────────┐');
    console.log('  │ Node         │ Capability│ Initial → Adaptive (task scores)       │');
    console.log('  ├──────────────┼───────────┼──────────────────────────────────────┤');

    for (const [id, node] of nodes) {
      const entries = Object.entries(node.history);
      for (let idx = 0; idx < entries.length; idx++) {
        const [cap, hist] = entries[idx];
        const n = idx === 0 ? id.padEnd(12) : ' '.repeat(12);
        const c = cap.padEnd(9);
        const init = String(hist.initial).padEnd(7);
        const adapt = String(hist.adaptive).padEnd(7);
        const nTasks = hist.scores.length;
        const changed = hist.adaptive !== hist.initial ? ' 🔄' : '';
        console.log(`  │ ${n} │ ${c} │ ${init} → ${adapt} (${nTasks} tasks)${changed}       │`);
      }
      node.scoreDelta = Math.round(node.scoreDelta * 1000) / 1000;
      console.log(`  │              │ total Δ    │ ${String(node.scoreDelta).padEnd(36)} │`);
    }
    console.log('  └──────────────┴───────────┴──────────────────────────────────────┘');

    // Per-node metrics
    console.log('\n  Per-Node Metrics:');
    for (const [id, node] of nodes) {
      const avgMs = node.requestCount > 0 ? Math.round(node.totalMs / node.requestCount) : 0;
      console.log(`    ${id}: ${node.requestCount} reqs, ${node.totalTokens} tokens, avg ${avgMs}ms`);
      console.log(`      Initial:  ${JSON.stringify(node.initialCapabilities)}`);
      console.log(`      Adaptive: ${JSON.stringify(node.adaptiveCapabilities)}`);
    }

    // ── Save ───────────────────────────────────────────────────────────
    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0002D/output');
    fs.mkdirSync(outDir, { recursive: true });

    const summary = {
      experiment: 'EXP-0002D',
      description: 'Adaptive Capability Profile (SMA, α=' + ALPHA + ')',
      timestamp: new Date().toISOString(),
      config: { master_port: port, alpha: ALPHA, adaptive: useAdaptive },
      completed: completedCount, total_ms: totalMs,
      nodes: [...nodes.entries()].map(([id, n]) => ({
        node_id: id,
        initial_capabilities: n.initialCapabilities,
        adaptive_capabilities: n.adaptiveCapabilities,
        history: Object.fromEntries(
          Object.entries(n.history).map(([cap, h]) => [cap, {
            initial: h.initial, adaptive: h.adaptive,
            n_tasks: h.scores.length, scores: h.scores,
          }])
        ),
        requests: n.requestCount, total_tokens: n.totalTokens,
        total_score_delta: Math.round(n.scoreDelta * 1000) / 1000,
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

  console.log(`\n  🟢 Master on ws://localhost:${port} (adaptive=${useAdaptive})\n`);
  console.log('  Node examples:');
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts \\`);
  console.log(`      --master ws://localhost:${port} --node-id node-coding \\`);
  console.log(`      --capability '{"coding":0.95,"math":0.65,"general":0.80}'`);
  console.log();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
