#!/usr/bin/env npx tsx
/**
 * EXP-0002B — Two-Expert Master (WebSocket Hub Server)
 *
 * Accepts WebSocket connections from Expert Nodes.
 * Routes prompts round-robin between connected nodes.
 * Validates: Star Registry, multi-node routing, per-node metrics,
 *            heterogeneous nodes (PC + iPhone relay).
 *
 * Architecture:
 *   Master Hub (:8080)
 *     ├── Node A (PC)           — ws client, Qwen3-0.6B direct
 *     └── Node B (iPhone 12 mini) — ws client, relay → Qwen3-0.6B (PC backend)
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002B/run_master.ts \
 *     --port 8080 \
 *     --prompts ../golden/prompts.jsonl
 */

import WebSocket, { WebSocketServer } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface RemoteResult {
  type: 'result';
  request_id: string;
  tokens: number[];
  text: string;
  timing: { tokenize_ms: number; prefill_ms: number; decode_ms: number; total_ms: number };
  metadata: { node_id: string; model_id: string; backend: string; precision: string; platform: string; role: string };
}

interface NodeRegistration {
  type: 'register';
  node: {
    id: string;
    platform: string;
    device?: string;
    role: string;
    backend?: string;
    cores?: number;
  };
}

interface PromptEntry {
  prompt: string;
  max_new_tokens: number;
  temperature: number;
  top_p: number;
}

interface ConnectedNode {
  ws: WebSocket;
  nodeId: string;
  role: string;
  platform: string;
  device: string;
  registeredAt: number;
  latencyMs: number;
  requestCount: number;
  totalTokens: number;
  totalMs: number;
  errors: number;
}

interface PerRequestLog {
  request_id: string;
  node_id: string;
  prompt: string;
  tokens: number;
  roundtrip_ms: number;
  node_total_ms: number;
  network_ms: number;
  error?: string;
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
const promptFile = getArg('--prompts', path.resolve('experiments/qwen3_0.6b/golden/prompts.jsonl'));
const minNodes = parseInt(getArg('--min-nodes', '2'), 10);

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(60));
  console.log('EXP-0002B — Two-Expert Master (Hub Server)');
  console.log('═'.repeat(60));
  console.log(`  Port:    ${port}`);
  console.log(`  Prompts: ${promptFile}`);
  console.log(`  Policy:  Round-Robin`);
  console.log(`  Min Nodes: ${minNodes}\n`);

  // Load prompts
  const prompts: PromptEntry[] = [];
  for (const line of fs.readFileSync(promptFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line);
    prompts.push({
      prompt: raw.prompt,
      max_new_tokens: raw.max_new_tokens || 32,
      temperature: raw.temperature ?? 0,
      top_p: raw.top_p ?? 1,
    });
  }
  console.log(`  Loaded ${prompts.length} prompts\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Node Registry
  // ═══════════════════════════════════════════════════════════════════════════
  const nodes = new Map<string, ConnectedNode>();
  let nextNodeIdx = 0;

  function getRoundRobinNode(): ConnectedNode | null {
    const active = [...nodes.values()].filter(n => n.ws.readyState === WebSocket.OPEN);
    if (active.length === 0) return null;
    const node = active[nextNodeIdx % active.length];
    nextNodeIdx = (nextNodeIdx + 1) % active.length;
    return node;
  }

  function nodeListSummary(): string {
    return [...nodes.values()]
      .map(n => `${n.nodeId}(${n.role}, ${n.platform}, ${n.latencyMs}ms)`)
      .join(', ');
  }

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

      // ── Registration ──────────────────────────────────────────────────
      if (msg.type === 'register') {
        const reg = msg as NodeRegistration;
        nodeId = reg.node.id;
        const node: ConnectedNode = {
          ws,
          nodeId,
          role: reg.node.role || 'unknown',
          platform: reg.node.platform || 'unknown',
          device: reg.node.device || 'unknown',
          registeredAt: Date.now(),
          latencyMs: 0,
          requestCount: 0,
          totalTokens: 0,
          totalMs: 0,
          errors: 0,
        };
        nodes.set(nodeId, node);

        ws.send(JSON.stringify({
          type: 'register_ack',
          node_id: nodeId,
          master: 'EXP-0002B',
          connected_nodes: nodes.size,
          role: 'expert-router',
        }));

        console.log(`  ✅ Registered: ${nodeId}`);
        console.log(`     Platform: ${reg.node.platform}, Role: ${reg.node.role}, Device: ${reg.node.device || '?'}`);
        console.log(`     Active nodes: ${nodes.size} — ${nodeListSummary()}`);

        // Auto-start experiment when enough nodes connect
        if (nodes.size >= minNodes && !experimentStarted) {
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
        if (node && msg.t) {
          node.latencyMs = Math.round((performance.now() - msg.t) * 10) / 10;
        }
        return;
      }
    });

    ws.on('close', () => {
      console.log(`  🔌 Disconnected: ${nodeId}`);
      nodes.delete(nodeId);
      console.log(`     Active nodes: ${nodes.size}`);
    });

    ws.on('error', (e) => {
      console.error(`  ❌ ${nodeId}: ${e.message}`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Experiment Runner
  // ═══════════════════════════════════════════════════════════════════════════

  async function runExperiment() {
    console.log('\n═'.repeat(60));
    console.log('EXPERIMENT START — Two-Expert Round-Robin');
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

    // ── Round-Robin Inference ──────────────────────────────────────────
    console.log('\n── Round-Robin Inference ──\n');
    const tStart = performance.now();
    let completedCount = 0;

    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const node = getRoundRobinNode();

      if (!node) {
        console.log(`  [${i + 1}/${prompts.length}] ⚠️ No active node`);
        allResults.push({
          request_id: `req-${String(i).padStart(4, '0')}`,
          node_id: 'none',
          prompt: p.prompt.slice(0, 40),
          tokens: 0, roundtrip_ms: 0, node_total_ms: 0, network_ms: 0,
          error: 'no active node',
        });
        continue;
      }

      const requestId = `req-${String(i).padStart(4, '0')}`;
      console.log(`  [${i + 1}/${prompts.length}] ${requestId} → ${node.nodeId}`);

      const t0 = performance.now();

      try {
        const result = await new Promise<RemoteResult>((resolve, reject) => {
          const timeout = setTimeout(() => {
            node.errors++;
            reject(new Error('timeout'));
          }, 120000);

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
            type: 'compute',
            request_id: requestId,
            prompt: p.prompt,
            max_new_tokens: p.max_new_tokens,
            temperature: p.temperature,
            top_p: p.top_p,
          }));
        });

        const roundtripMs = Math.round((performance.now() - t0) * 10) / 10;
        const networkMs = Math.round((roundtripMs - result.timing.total_ms) * 10) / 10;

        node.requestCount++;
        node.totalTokens += result.tokens.length;
        node.totalMs += roundtripMs;
        completedCount++;

        allResults.push({
          request_id: requestId,
          node_id: node.nodeId,
          prompt: p.prompt.slice(0, 40),
          tokens: result.tokens.length,
          roundtrip_ms: roundtripMs,
          node_total_ms: result.timing.total_ms,
          network_ms: networkMs,
        });

        console.log(`       ✅ ${result.tokens.length} tokens, RTT=${roundtripMs}ms (node=${result.timing.total_ms.toFixed(0)}ms, net=${networkMs}ms)`);

      } catch (e: any) {
        node.errors++;
        allResults.push({
          request_id: requestId,
          node_id: node.nodeId,
          prompt: p.prompt.slice(0, 40),
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
    console.log('RESULTS — Two-Expert Round-Robin');
    console.log('═'.repeat(60));

    console.log(`\n  Completed:   ${completedCount}/${prompts.length}`);
    console.log(`  Total time:   ${totalMs}ms`);
    console.log(`  Throughput:   ${(completedCount / (totalMs / 1000)).toFixed(2)} req/s\n`);

    // Per-node breakdown
    console.log('  Per-Node Metrics:');
    console.log('  ┌──────────────┬──────┬────────┬────────┬────────┬──────────────┐');
    console.log('  │ Node         │ Reqs │ Tokens │ Avg ms │ Err    │ Role         │');
    console.log('  ├──────────────┼──────┼────────┼────────┼────────┼──────────────┤');

    for (const [id, node] of nodes) {
      const avgMs = node.requestCount > 0 ? Math.round(node.totalMs / node.requestCount) : 0;
      const n = id.padEnd(12);
      const r = String(node.requestCount).padStart(4);
      const t = String(node.totalTokens).padStart(6);
      const a = String(avgMs).padStart(6);
      const e = String(node.errors).padStart(6);
      const ro = node.role.padEnd(12);
      console.log(`  │ ${n} │ ${r} │ ${t} │ ${a} │ ${e} │ ${ro} │`);
    }
    console.log('  └──────────────┴──────┴────────┴────────┴────────┴──────────────┘');

    // Routing distribution
    console.log('\n  Routing Distribution:');
    const totalReqs = [...nodes.values()].reduce((s, n) => s + n.requestCount, 0) || 1;
    for (const [id, node] of nodes) {
      const pct = (node.requestCount / totalReqs * 100).toFixed(1);
      const bar = '█'.repeat(Math.max(1, Math.round(node.requestCount / totalReqs * 20)));
      console.log(`    ${id}: ${pct}% ${bar} (${node.requestCount}/${totalReqs})`);
    }

    // ── Save Results ───────────────────────────────────────────────────
    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0002B/output');
    fs.mkdirSync(outDir, { recursive: true });

    const summary = {
      experiment: 'EXP-0002B',
      description: 'Two-Expert Round-Robin Routing (Master Hub + iPhone 12 mini Relay)',
      timestamp: new Date().toISOString(),
      config: {
        master_port: port,
        prompts_file: promptFile,
        num_prompts: prompts.length,
        policy: 'round-robin',
        min_nodes: 2,
      },
      completed: completedCount,
      total_ms: totalMs,
      throughput_req_per_sec: Math.round(completedCount / (totalMs / 1000) * 100) / 100,
      nodes: [...nodes.entries()].map(([id, n]) => ({
        node_id: id,
        role: n.role,
        platform: n.platform,
        device: n.device,
        latency_ms: n.latencyMs,
        requests: n.requestCount,
        total_tokens: n.totalTokens,
        avg_roundtrip_ms: n.requestCount > 0 ? Math.round(n.totalMs / n.requestCount * 10) / 10 : 0,
        errors: n.errors,
      })),
      routing_distribution: [...nodes.entries()].map(([id, n]) => ({
        node_id: id,
        requests: n.requestCount,
        pct: Math.round(n.requestCount / totalReqs * 1000) / 10,
      })),
      requests: allResults,
    };

    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`\n  📁 Results saved to ${outDir}/summary.json\n`);

    // Cleanup
    for (const [id, node] of nodes) {
      node.ws.close();
    }
    wss.close();
    console.log('  Experiment complete. Master shutting down.\n');
    process.exit(0);
  }

  console.log(`\n  🟢 Master Hub listening on ws://localhost:${port}`);
  const remaining = minNodes - nodes.size;
  console.log(`     Waiting for ${remaining} more node(s) to connect...`);
  console.log(`     (Auto-starts experiment when ${minNodes} nodes connect)\n`);

  // Print connection instructions
  const localIp = getLocalIp();
  console.log('  ── Node Connection Instructions ──');
  console.log(`  Node A (PC direct):`);
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts \\`);
  console.log(`      --master ws://localhost:${port} --node-id node-a --role expert`);
  console.log();
  console.log(`  Node B (PC backend for iPhone relay):`);
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts \\`);
  console.log(`      --master ws://localhost:${port} --node-id node-b --role expert-backend`);
  console.log();
  console.log(`  iPhone 12 mini (Relay):`);
  console.log(`    Open Safari → http://${localIp}:${port}/iphone_12mini_node.html`);
  console.log(`    Or serve: npx serve experiments/qwen3_0.6b/EXP-0002B/public`);
  console.log(`    Set Master URL: ws://${localIp}:${port}`);
  console.log(`    Set Backend URL: ws://${localIp}:8082  (if using relay mode)`);
  console.log();
}

function getLocalIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
