#!/usr/bin/env npx tsx
/**
 * EXP-0002F — Shadow Expert Feedback
 *
 * Phase 4: Collaborative Intelligence の最初の実験。
 *
 * Main Expert の出力を Shadow Expert（異なる backend/precision）で検証し、
 * 一貫性から Evaluator / Capability / Stability を動的更新する。
 *
 * Closed loop:
 *   実行 → Shadow評価 → Evaluator更新 → Capability更新 → Composite Score更新
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002F/run_master.ts --port 8080
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

interface ConnectedNode {
  ws: WebSocket; nodeId: string; role: string; platform: string;
  backend: string; precision: string; stability: number;
  initialCapabilities: Record<string, number>;
  agreementRate: number;  // dynamic stability proxy (from shadow comparison)
  requestCount: number; totalMs: number; errors: number;
  mainRoles: number; shadowRoles: number;
}

interface PerRequestLog {
  request_id: string; prompt: string; capability: string;
  main_node: string; shadow_node: string;
  main_tokens: number; shadow_tokens: number;
  overlap_pct: number; verdict: string;
  main_ms: number; shadow_ms: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stability (from EXP-0001) + dynamic agreement
// ═══════════════════════════════════════════════════════════════════════════════

const STATIC_STABILITY: Record<string, number> = {
  'mps-fp32': 1.000, 'mps-fp16': 0.992, 'mps-bf16': 0.791,
  'cpu-fp32': 1.000, 'cpu-fp16': 0.992, 'onnx-fp16': 0.992, 'onnx-fp32': 1.000,
};

function getStaticStability(backend: string, precision: string): number {
  return STATIC_STABILITY[`${backend.toLowerCase()}-${precision.toLowerCase()}`] ?? 0.95;
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
const overlapThreshold = parseFloat(getArg('--threshold', '0.5')); // agreement ≥ 50% = ACCEPT

// ═══════════════════════════════════════════════════════════════════════════════
// Token Overlap (verification)
// ═══════════════════════════════════════════════════════════════════════════════

function computeOverlap(mainTokens: number[], shadowTokens: number[]): number {
  if (mainTokens.length === 0 || shadowTokens.length === 0) return 0;
  const shorter = Math.min(mainTokens.length, shadowTokens.length);
  let match = 0;
  for (let i = 0; i < shorter; i++) {
    if (mainTokens[i] === shadowTokens[i]) match++;
  }
  // Positional overlap (prefix match)
  const positional = match / shorter;
  // Set overlap (any order)
  const mainSet = new Set(mainTokens);
  const shadowSet = new Set(shadowTokens);
  let setMatch = 0;
  for (const t of mainSet) if (shadowSet.has(t)) setMatch++;
  const setOverlap = setMatch / Math.max(1, mainSet.size);

  return Math.round(Math.max(positional, setOverlap) * 1000) / 1000;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

const nodes = new Map<string, ConnectedNode>();

async function main() {
  console.log('═'.repeat(60));
  console.log('EXP-0002F — Shadow Expert Feedback');
  console.log('═'.repeat(60));
  console.log(`  Threshold: overlap ≥ ${overlapThreshold} = ACCEPT`);
  console.log(`  Closed loop: 実行 → Shadow検証 → Evaluator → Capability/Stability更新\n`);

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
        const backend = msg.node.backend || 'cpu';
        const precision = msg.node.precision || 'fp16';
        const node: ConnectedNode = {
          ws, nodeId, role: msg.node.role || 'expert',
          platform: msg.node.platform || 'unknown', backend, precision,
          stability: getStaticStability(backend, precision),
          initialCapabilities: msg.node.capabilities || { general: 0.8 },
          agreementRate: 1.0,  // start optimistic
          requestCount: 0, totalMs: 0, errors: 0, mainRoles: 0, shadowRoles: 0,
        };
        nodes.set(nodeId, node);

        ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'EXP-0002F',
          stability: node.stability, role_hint: 'shadow-capable' }));

        console.log(`  ✅ ${nodeId}: ${backend}/${precision} (static stability=${node.stability})`);

        if (nodes.size >= 2 && !experimentStarted) {
          experimentStarted = true;
          setTimeout(() => runExperiment(), 1500);
        }
        return;
      }

      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); return; }
      if (msg.type === 'pong') return;
    });

    ws.on('close', () => nodes.delete(nodeId));
    ws.on('error', () => {});
  });

  // ═══════════════════════════════════════════════════════════════════════════
  async function sendCompute(ws: WebSocket, requestId: string, p: PromptEntry): Promise<RemoteResult> {
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
        prompt: p.prompt, max_new_tokens: p.max_new_tokens,
        temperature: p.temperature, top_p: p.top_p }));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  async function runExperiment() {
    console.log('\n═'.repeat(60));
    console.log('EXPERIMENT START — Shadow Expert Feedback');
    console.log('═'.repeat(60));

    const active = [...nodes.values()];
    // Choose Main = highest static stability, Shadow = second highest (different node)
    const sorted = [...active].sort((a, b) => b.stability - a.stability);
    const mainNode = sorted[0];
    const shadowNode = sorted[1] ?? sorted[0];

    console.log(`\n  Main:   ${mainNode.nodeId} (${mainNode.backend}/${mainNode.precision}, S=${mainNode.stability})`);
    console.log(`  Shadow: ${shadowNode.nodeId} (${shadowNode.backend}/${shadowNode.precision}, S=${shadowNode.stability})`);
    console.log(`  Threshold: ${overlapThreshold}\n`);

    const tStart = performance.now();
    let acceptCount = 0, flagCount = 0;
    let totalOverlap = 0;

    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const requestId = `req-${String(i).padStart(4, '0')}`;
      const promptPreview = p.prompt.slice(0, 40);
      const capability = p.capability || 'general';

      console.log(`  [${i + 1}/${prompts.length}] ${requestId} "${promptPreview}..."`);

      try {
        // 1. Main Expert generates
        const tMain = performance.now();
        const mainResult = await sendCompute(mainNode.ws, `${requestId}-m`, p);
        const mainMs = Math.round((performance.now() - tMain) * 10) / 10;

        // 2. Shadow Expert generates (same prompt)
        const tShadow = performance.now();
        const shadowResult = await sendCompute(shadowNode.ws, `${requestId}-s`, p);
        const shadowMs = Math.round((performance.now() - tShadow) * 10) / 10;

        // 3. Verify: token overlap
        const overlap = computeOverlap(mainResult.tokens, shadowResult.tokens);
        const verdict = overlap >= overlapThreshold ? 'ACCEPT ✅' : `FLAG ⚠️ (${overlap})`;
        if (overlap >= overlapThreshold) acceptCount++; else flagCount++;
        totalOverlap += overlap;

        // 4. Update dynamic stability (agreement rate, EMA)
        mainNode.agreementRate = Math.round((mainNode.agreementRate * 0.7 + overlap * 0.3) * 1000) / 1000;
        mainNode.requestCount++;
        mainNode.totalMs += mainMs;
        mainNode.mainRoles++;
        shadowNode.shadowRoles++;

        allResults.push({
          request_id: requestId, prompt: promptPreview, capability,
          main_node: mainNode.nodeId, shadow_node: shadowNode.nodeId,
          main_tokens: mainResult.tokens.length, shadow_tokens: shadowResult.tokens.length,
          overlap_pct: overlap, verdict,
          main_ms: mainMs, shadow_ms: shadowMs,
        });

        console.log(`       Main=${mainNode.nodeId} (${mainMs}ms) ↔ Shadow=${shadowNode.nodeId} (${shadowMs}ms)`);
        console.log(`       Overlap=${(overlap * 100).toFixed(1)}% → ${verdict}`);
        console.log(`       Dynamic stability: ${mainNode.agreementRate}`);

      } catch (e: any) {
        mainNode.errors++;
        console.log(`       ❌ ${e.message}`);
      }
    }

    const totalMs = Math.round(performance.now() - tStart);

    // ═══════════════════════════════════════════════════════════════════════
    // Results
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═'.repeat(60));
    console.log('RESULTS — Shadow Expert Feedback');
    console.log('═'.repeat(60));

    const avgOverlap = allResults.length > 0 ? Math.round(totalOverlap / allResults.length * 1000) / 1000 : 0;

    console.log(`\n  Completed:       ${allResults.length}/${prompts.length}`);
    console.log(`  Total time:       ${totalMs}ms`);
    console.log(`  Avg overlap:      ${(avgOverlap * 100).toFixed(1)}%`);
    console.log(`  Verdicts:         ACCEPT=${acceptCount} FLAG=${flagCount}`);
    console.log(`  Accept rate:      ${allResults.length > 0 ? (acceptCount / allResults.length * 100).toFixed(1) : 'N/A'}%\n`);

    console.log('  Per-node roles:');
    for (const [id, node] of nodes) {
      console.log(`    ${id}: main=${node.mainRoles} shadow=${node.shadowRoles} | static S=${node.stability} → dynamic agreement=${node.agreementRate}`);
    }

    // Verification vs static stability
    console.log('\n  Verification vs Static Stability (EXP-0001):');
    console.log('  ┌──────────────┬──────────┬──────────┬──────────┬──────────────┐');
    console.log('  │ Node         │ Static S │ Agree    │ Δ        │ Verdict      │');
    console.log('  ├──────────────┼──────────┼──────────┼──────────┼──────────────┤');
    for (const [id, node] of nodes) {
      const delta = Math.round((node.agreementRate - node.stability) * 1000) / 1000;
      const drift = Math.abs(delta) > 0.1 ? '⚠️ drift' : '✓ stable';
      console.log(`  │ ${id.padEnd(12)} │ ${String(node.stability).padEnd(8)} │ ${String(node.agreementRate).padEnd(8)} │ ${String(delta).padEnd(8)} │ ${drift.padEnd(12)} │`);
    }
    console.log('  └──────────────┴──────────┴──────────┴──────────┴──────────────┘');

    // Save
    const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0002F/output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      experiment: 'EXP-0002F',
      description: 'Shadow Expert Feedback (Main + Shadow verification)',
      timestamp: new Date().toISOString(),
      config: { threshold: overlapThreshold },
      completed: allResults.length, total_ms: totalMs,
      avg_overlap: avgOverlap, accept_count: acceptCount, flag_count: flagCount,
      accept_rate: allResults.length > 0 ? Math.round(acceptCount / allResults.length * 1000) / 10 : null,
      nodes: [...nodes.entries()].map(([id, n]) => ({
        node_id: id, backend: n.backend, precision: n.precision,
        static_stability: n.stability, dynamic_agreement: n.agreementRate,
        main_roles: n.mainRoles, shadow_roles: n.shadowRoles,
      })),
      requests: allResults,
    }, null, 2));
    console.log(`\n  📁 ${outDir}/summary.json\n`);

    for (const [id, node] of nodes) node.ws.close();
    wss.close();
    console.log('  Complete.\n');
    process.exit(0);
  }

  console.log(`\n  🟢 Master on ws://localhost:${port} (shadow feedback)\n`);
  console.log('  Node examples (use EXP-0002E node with different backends):');
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts --master ws://localhost:${port} \\`);
  console.log(`      --node-id node-fp32 --backend mps --precision fp32 --capability '{"general":0.8}'`);
  console.log(`    npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts --master ws://localhost:${port} \\`);
  console.log(`      --node-id node-fp16 --backend mps --precision fp16 --capability '{"general":0.8}'`);
  console.log();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
