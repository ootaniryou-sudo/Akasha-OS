#!/usr/bin/env npx tsx
/**
 * EXP-0002C — Capability-Aware Master Hub
 *
 * Extended Master Hub with:
 *   - CapabilityRegistry: stores per-node capability profiles
 *   - PromptClassifier: keyword-based capability classifier (MVP)
 *   - CapabilityScheduler: selects best node by capability match
 *   - Fallback to round-robin on capability tie
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002C/run_master.ts --port 8080
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

interface ConnectedNode {
  ws: WebSocket; nodeId: string; role: string; platform: string; device: string;
  capabilities: Record<string, number>;
  registeredAt: number; latencyMs: number;
  requestCount: number; totalTokens: number; totalMs: number; errors: number;
  routedCounts: Record<string, number>; // per-capability routing counts
}

interface PerRequestLog {
  request_id: string; node_id: string; prompt: string;
  expected_capability: string; matched_capability: string; routing_method: string;
  tokens: number; roundtrip_ms: number; node_total_ms: number; network_ms: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prompt Classifier (keyword-based MVP)
// ═══════════════════════════════════════════════════════════════════════════════

const CAPABILITY_KEYWORDS: Record<string, string[]> = {
  coding: ['def', 'function', 'code', 'python', 'write', 'implement', 'class', 'algorithm', 'program', 'method', 'create'],
  math: ['calculate', 'solve', 'integral', 'sum', 'equation', 'math', 'derivative', 'x^', 'x =', 'solve', '% of', '+', '*', 'compute'],
};

function classifyPrompt(prompt: string): string {
  const lower = prompt.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [capability, keywords] of Object.entries(CAPABILITY_KEYWORDS)) {
    scores[capability] = keywords.filter(kw => lower.includes(kw.toLowerCase())).length;
  }

  // Find highest scoring capability
  let best = 'general';
  let bestScore = 0;
  for (const [cap, score] of Object.entries(scores)) {
    if (score > bestScore) { best = cap; bestScore = score; }
  }

  return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Capability Scheduler
// ═══════════════════════════════════════════════════════════════════════════════

function selectBestNode(
  nodes: ConnectedNode[],
  capability: string,
): { node: ConnectedNode; method: string } {
  const active = nodes.filter(n => n.ws.readyState === WebSocket.OPEN);
  if (active.length === 0) throw new Error('No active nodes');

  // Score each node for the target capability
  const scored = active.map(node => ({
    node,
    score: node.capabilities[capability] ?? node.capabilities['general'] ?? 0.5,
  }));

  // Sort by capability score descending
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  // If top two have same score → tie-break via round-robin
  if (second && best.score === second.score) {
    // Use round-robin based on total requests
    const totalReqs = active.reduce((s, n) => s + n.requestCount, 0);
    const idx = totalReqs % active.length;
    return { node: active[idx], method: `tie-break (round-robin, score=${best.score})` };
  }

  return { node: best.node, method: `capability-match (${capability}=${best.score})` };
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
  console.log('EXP-0002C — Capability-Aware Master Hub');
  console.log('═'.repeat(60));
  console.log(`  Port:     ${port}`);
  console.log(`  Prompts:  ${promptFile}`);
  console.log(`  Policy:   Capability-Aware (keyword classifier MVP)`);
  console.log(`  Fallback: Round-Robin\n`);

  // Load prompts
  const prompts: PromptEntry[] = [];
  for (const line of fs.readFileSync(promptFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line);
    prompts.push({
      prompt: raw.prompt,
      capability: raw.capability,
      max_new_tokens: raw.max_new_tokens || 32,
      temperature: raw.temperature ?? 0,
      top_p: raw.top_p ?? 1,
    });
  }
  console.log(`  Loaded ${prompts.length} prompts\n`);

  // Capability distribution
  const capCounts: Record<string, number> = {};
  for (const p of prompts) {
    const classified = p.capability || classifyPrompt(p.prompt);
    capCounts[classified] = (capCounts[classified] || 0) + 1;
  }
  console.log('  Prompt Distribution:');
  for (const [cap, count] of Object.entries(capCounts)) {
    console.log(`    ${cap}: ${count} prompts`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  // Node Registry
  // ═══════════════════════════════════════════════════════════════════════════
  const nodes = new Map<string, ConnectedNode>();

  function nodeListSummary(): string {
    return [...nodes.values()]
      .map(n => `${n.nodeId}(${JSON.stringify(n.capabilities)})`)
      .join(', ');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WebSocket Server
  // ═══════════════════════════════════════════════════════════════════════════
  const wss = new WebSocketServer({ port });
  const allResults: PerRequestLog[] = [];
  let experimentStarted = false;
  let capabilityRoutingCorrect = 0;
  let capabilityRoutingTotal = 0;

  wss.on('connection', (ws: WebSocket, req) => {
    const clientIp = req.socket?.remoteAddress || 'unknown';
    console.log(`  🔗 New connection from ${clientIp}`);

    let nodeId = `unknown-${clientIp}`;

    ws.on('message', (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // ── Registration ──────────────────────────────────────────────────
      if (msg.type === 'register') {
        nodeId = msg.node.id;
        const caps = msg.node.capabilities || { general: 0.8 };
        const node: ConnectedNode = {
          ws, nodeId,
          role: msg.node.role || 'expert',
          platform: msg.node.platform || 'unknown',
          device: msg.node.device || 'unknown',
          capabilities: caps,
          registeredAt: Date.now(), latencyMs: 0,
          requestCount: 0, totalTokens: 0, totalMs: 0, errors: 0,
          routedCounts: {},
        };
        nodes.set(nodeId, node);

        // Find the strongest capability for ack
        const strongest = Object.entries(caps).sort((a, b) => b[1] - a[1])[0];

        ws.send(JSON.stringify({
          type: 'register_ack',
          node_id: nodeId,
          master: 'EXP-0002C',
          connected_nodes: nodes.size,
          routed_as: strongest?.[0] || 'general',
          capabilities: caps,
        }));

        console.log(`  ✅ Registered: ${nodeId}`);
        console.log(`     Capabilities: ${JSON.stringify(caps)}`);
        console.log(`     Strongest: ${strongest?.[0]} (${strongest?.[1]})`);
        console.log(`     Active nodes: ${nodes.size} — ${nodeListSummary()}`);

        if (nodes.size >= 2 && !experimentStarted) {
          experimentStarted = true;
          setTimeout(() => runExperiment(), 1500);
        }
        return;
      }

      // ── Ping/Pong ─────────────────────────────────────────────────────
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t, master_time: Date.now() }));
        return;
      }
      if (msg.type === 'pong') {
        const node = nodes.get(nodeId);
        if (node && msg.t) node.latencyMs = Math.round((performance.now() - msg.t) * 10) / 10;
        return;
      }
    });

    ws.on('close', () => {
      console.log(`  🔌 Disconnected: ${nodeId}`);
      nodes.delete(nodeId);
      console.log(`     Active nodes: ${nodes.size}`);
    });
    ws.on('error', (e) => console.error(`  ❌ ${nodeId}: ${e.message}`));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Experiment Runner
  // ═══════════════════════════════════════════════════════════════════════════

  async function runExperiment() {
    console.log('\n═'.repeat(60));
    console.log('EXPERIMENT START — Capability-Aware Routing');
    console.log('═'.repeat(60));
    console.log(`  Nodes (${nodes.size}): ${nodeListSummary()}`);
    console.log(`  Prompts: ${prompts.length}\n`);

    // ── Latency check ──────────────────────────────────────────────────
    console.log('── Latency Check ──\n');
    for (const [id, node] of nodes) {
      const t0 = performance.now();
      node.ws.send(JSON.stringify({ type: 'ping', t: t0 }));
      await new Promise(r => setTimeout(r, 300));
      console.log(`  📡 ${id}: ${node.latencyMs}ms RTT`);
    }

    // ── Capability-Aware Inference ─────────────────────────────────────
    console.log('\n── Capability-Aware Inference ──\n');
    const tStart = performance.now();
    let completedCount = 0;

    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const requestId = `req-${String(i).padStart(4, '0')}`;
      const promptPreview = p.prompt.slice(0, 50);

      // Classify prompt
      const expectedCap = p.capability || classifyPrompt(p.prompt);

      // Select best node
      let node: ConnectedNode;
      let routingMethod: string;
      try {
        const selection = selectBestNode([...nodes.values()], expectedCap);
        node = selection.node;
        routingMethod = selection.method;
      } catch {
        console.log(`  [${i + 1}/${prompts.length}] ${requestId} ⚠️ No active node`);
        allResults.push({
          request_id: requestId, node_id: 'none', prompt: promptPreview,
          expected_capability: expectedCap, matched_capability: 'none', routing_method: 'none',
          tokens: 0, roundtrip_ms: 0, node_total_ms: 0, network_ms: 0,
          error: 'no active node',
        });
        continue;
      }

      // Check if routing is correct (node's strongest capability matches expected)
      const nodeStrongest = Object.entries(node.capabilities).sort((a, b) => b[1] - a[1])[0]?.[0] || 'general';
      const routingCorrect = nodeStrongest === expectedCap;

      console.log(`  [${i + 1}/${prompts.length}] ${requestId} → ${node.nodeId}`);
      console.log(`       Prompt: "${promptPreview}..."`);
      console.log(`       Expected: ${expectedCap} | Routed to: ${node.nodeId} (best=${nodeStrongest}) | ${routingMethod}`);

      if (expectedCap !== 'general') {
        capabilityRoutingTotal++;
        if (routingCorrect) capabilityRoutingCorrect++;
      }

      const t0 = performance.now();

      try {
        const result = await new Promise<RemoteResult>((resolve, reject) => {
          const timeout = setTimeout(() => { node.errors++; reject(new Error('timeout')); }, 120000);
          const handler = (raw: Buffer) => {
            try {
              const m = JSON.parse(raw.toString());
              if (m.type === 'result' && m.request_id === requestId) {
                clearTimeout(timeout);
                node.ws.removeListener('message', handler);
                resolve(m as RemoteResult);
              }
            } catch (_) {}
          };
          node.ws.on('message', handler);
          node.ws.send(JSON.stringify({
            type: 'compute', request_id: requestId,
            prompt: p.prompt, max_new_tokens: p.max_new_tokens,
            temperature: p.temperature, top_p: p.top_p,
          }));
        });

        const roundtripMs = Math.round((performance.now() - t0) * 10) / 10;
        const networkMs = Math.round((roundtripMs - result.timing.total_ms) * 10) / 10;

        node.requestCount++;
        node.routedCounts[expectedCap] = (node.routedCounts[expectedCap] || 0) + 1;
        node.totalTokens += result.tokens.length;
        node.totalMs += roundtripMs;
        completedCount++;

        allResults.push({
          request_id: requestId, node_id: node.nodeId, prompt: promptPreview,
          expected_capability: expectedCap, matched_capability: nodeStrongest,
          routing_method: routingMethod,
          tokens: result.tokens.length, roundtrip_ms: roundtripMs,
          node_total_ms: result.timing.total_ms, network_ms: networkMs,
        });

        const correctMarker = expectedCap === 'general' ? '⬜' : routingCorrect ? '✅' : '❌';
        console.log(`       ${correctMarker} ${result.tokens.length} tokens, RTT=${roundtripMs}ms (node=${result.timing.total_ms.toFixed(0)}ms)`);

      } catch (e: any) {
        node.errors++;
        allResults.push({
          request_id: requestId, node_id: node.nodeId, prompt: promptPreview,
          expected_capability: expectedCap, matched_capability: nodeStrongest, routing_method: routingMethod,
          tokens: 0, roundtrip_ms: 0, node_total_ms: 0, network_ms: 0,
          error: e.message,
        });
        console.log(`       ❌ ${e.message}`);
      }
    }

    const totalMs = Math.round(performance.now() - tStart);

    // ═══════════════════════════════════════════════════════════════════════
    // Results Summary
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═'.repeat(60));
    console.log('RESULTS — Capability-Aware Routing');
    console.log('═'.repeat(60));

    const accuracy = capabilityRoutingTotal > 0
      ? (capabilityRoutingCorrect / capabilityRoutingTotal * 100).toFixed(1)
      : 'N/A';

    console.log(`\n  Completed:         ${completedCount}/${prompts.length}`);
    console.log(`  Total time:         ${totalMs}ms`);
    console.log(`  Throughput:         ${(completedCount / (totalMs / 1000)).toFixed(2)} req/s`);
    console.log(`  Routing Accuracy:   ${accuracy}% (${capabilityRoutingCorrect}/${capabilityRoutingTotal} non-general)`);
    console.log();

    // Per-node breakdown
    console.log('  Per-Node Metrics:');
    console.log('  ┌──────────────┬──────┬────────┬────────┬────────┬──────────────────────────┐');
    console.log('  │ Node         │ Reqs │ Tokens │ Avg ms │ Err    │ Routed Capabilities      │');
    console.log('  ├──────────────┼──────┼────────┼────────┼────────┼──────────────────────────┤');

    for (const [id, node] of nodes) {
      const avgMs = node.requestCount > 0 ? Math.round(node.totalMs / node.requestCount) : 0;
      const n = id.padEnd(12);
      const r = String(node.requestCount).padStart(4);
      const t = String(node.totalTokens).padStart(6);
      const a = String(avgMs).padStart(6);
      const e = String(node.errors).padStart(6);
      const routed = Object.entries(node.routedCounts).map(([c, n]) => `${c}:${n}`).join(' ');
      console.log(`  │ ${n} │ ${r} │ ${t} │ ${a} │ ${e} │ ${routed.padEnd(24)} │`);
    }
    console.log('  └──────────────┴──────┴────────┴────────┴────────┴──────────────────────────┘');

    // Routing accuracy
    console.log('\n  Routing Accuracy by Capability:');
    for (const cap of ['coding', 'math', 'general']) {
      const relevant = allResults.filter(r => r.expected_capability === cap && !r.error);
      if (relevant.length === 0) continue;
      const correct = relevant.filter(r => r.expected_capability === r.matched_capability).length;
      const pct = (correct / relevant.length * 100).toFixed(1);
      const bar = '█'.repeat(Math.max(1, Math.round(correct / relevant.length * 15)));
      console.log(`    ${cap.padEnd(8)}: ${pct}% ${bar} (${correct}/${relevant.length})`);
    }

    // Routing method distribution
    const capMatch = allResults.filter(r => r.routing_method?.startsWith('capability-match')).length;
    const tieBreak = allResults.filter(r => r.routing_method?.startsWith('tie-break')).length;
    console.log(`\n  Routing Methods:`);
    console.log(`    capability-match: ${capMatch}`);
    console.log(`    tie-break (RR):   ${tieBreak}`);

    // ── Save Results ───────────────────────────────────────────────────
    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0002C/output');
    fs.mkdirSync(outDir, { recursive: true });

    const summary = {
      experiment: 'EXP-0002C',
      description: 'Capability-Aware Routing (keyword classifier MVP)',
      timestamp: new Date().toISOString(),
      config: { master_port: port, prompts_file: promptFile, num_prompts: prompts.length, policy: 'capability-aware' },
      completed: completedCount, total_ms: totalMs,
      throughput_req_per_sec: Math.round(completedCount / (totalMs / 1000) * 100) / 100,
      routing_accuracy_pct: capabilityRoutingTotal > 0
        ? Math.round(capabilityRoutingCorrect / capabilityRoutingTotal * 1000) / 10 : null,
      routing_accuracy: { correct: capabilityRoutingCorrect, total: capabilityRoutingTotal },
      routing_methods: { capability_match: capMatch, tie_break_round_robin: tieBreak },
      nodes: [...nodes.entries()].map(([id, n]) => ({
        node_id: id, capabilities: n.capabilities,
        role: n.role, platform: n.platform,
        latency_ms: n.latencyMs, requests: n.requestCount,
        total_tokens: n.totalTokens,
        avg_roundtrip_ms: n.requestCount > 0 ? Math.round(n.totalMs / n.requestCount * 10) / 10 : 0,
        errors: n.errors,
        routed_counts: n.routedCounts,
      })),
      requests: allResults,
    };

    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`\n  📁 Results saved to ${outDir}/summary.json\n`);

    for (const [id, node] of nodes) node.ws.close();
    wss.close();
    console.log('  Experiment complete. Master shutting down.\n');
    process.exit(0);
  }

  console.log(`\n  🟢 Master Hub listening on ws://localhost:${port}`);
  console.log(`     Waiting for nodes with capability profiles...`);
  console.log(`     (Auto-starts when 2 nodes connect)\n`);

  console.log('  ── Node Connection Examples ──');
  console.log(`  Coding Expert:`);
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts \\`);
  console.log(`      --master ws://localhost:${port} --node-id node-coding \\`);
  console.log(`      --capability '{"coding":0.95,"math":0.65,"general":0.80}'`);
  console.log();
  console.log(`  Math Expert:`);
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts \\`);
  console.log(`      --master ws://localhost:${port} --node-id node-math \\`);
  console.log(`      --capability '{"coding":0.62,"math":0.94,"general":0.80}'`);
  console.log();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
