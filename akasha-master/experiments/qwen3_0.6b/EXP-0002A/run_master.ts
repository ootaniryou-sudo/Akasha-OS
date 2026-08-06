#!/usr/bin/env npx tsx
/**
 * EXP-0002A — Master Client
 *
 * Connects to a Remote Node, sends prompts, measures Local vs Remote overhead.
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002A/run_master.ts \
 *     --node ws://localhost:8081 \
 *     --prompts ../golden/prompts.jsonl
 */

import WebSocket from 'ws';
import { QwenAdapter } from '../../../src/llm/adapters/qwen.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface RemoteResult {
  type: 'result';
  request_id: string;
  tokens: number[];
  text: string;
  timing: { tokenize_ms: number; prefill_ms: number; decode_ms: number; total_ms: number };
  metadata: { node_id: string; model_id: string; backend: string; precision: string; platform: string };
}

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const nodeUrl = getArg('--node', 'ws://localhost:8081');

async function main() {
  const prompts: { prompt: string; max_new_tokens: number; temperature: number; top_p: number }[] = [];
  const promptFile = getArg('--prompts', path.resolve('experiments/qwen3_0.6b/golden/prompts.jsonl'));
  for (const line of fs.readFileSync(promptFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    prompts.push(JSON.parse(line));
  }
  console.log(`EXP-0002A Master — ${prompts.length} prompts → ${nodeUrl}\n`);

  // ── Local baseline ──────────────────────────────────────────────────────
  console.log('=== Local Baseline ===');
  const adapter = new QwenAdapter({ modelId: 'onnx-community/Qwen3-0.6B-ONNX', device: 'cpu' });
  await adapter.loadModel();

  const localResults: { tokens: number; total_ms: number }[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const t0 = performance.now();
    const output = await adapter.generate({
      prompt: p.prompt,
      maxNewTokens: p.max_new_tokens,
      temperature: p.temperature,
      topP: p.top_p,
      topK: 50,
    });
    const ms = performance.now() - t0;
    localResults.push({ tokens: output.tokenIds.length, total_ms: ms });
    if ((i + 1) % 3 === 0 || i === prompts.length - 1) {
      console.log(`  [${i + 1}/${prompts.length}] ${output.tokenIds.length} tokens, ${ms.toFixed(0)}ms`);
    }
  }

  // ── Remote via WebSocket ────────────────────────────────────────────────
  console.log('\n=== Remote via WebSocket ===');

  const ws = new WebSocket(nodeUrl);
  const remoteResults: (RemoteResult & { roundtrip_ms: number })[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.on('open', async () => {
      console.log('  Connected to node');

      for (let i = 0; i < prompts.length; i++) {
        const p = prompts[i];
        const requestId = `req-${String(i).padStart(4, '0')}`;
        const t0 = performance.now();

        const result = await new Promise<RemoteResult>((res, rej) => {
          const timeout = setTimeout(() => rej(new Error('timeout')), 30000);
          ws.once('message', (raw: Buffer) => {
            clearTimeout(timeout);
            res(JSON.parse(raw.toString()));
          });
          ws.send(JSON.stringify({
            type: 'compute',
            request_id: requestId,
            prompt: p.prompt,
            max_new_tokens: p.max_new_tokens,
            temperature: p.temperature,
            top_p: p.top_p,
          }));
        });

        const roundtripMs = performance.now() - t0;
        remoteResults.push({ ...result, roundtrip_ms: roundtripMs });
        if ((i + 1) % 3 === 0 || i === prompts.length - 1) {
          console.log(`  [${i + 1}/${prompts.length}] ${result.tokens.length} tokens, roundtrip=${roundtripMs.toFixed(0)}ms (node=${result.timing.total_ms.toFixed(0)}ms)`);
        }
      }

      ws.close();
      resolve();
    });
    ws.on('error', reject);
  });

  // ── Comparison ──────────────────────────────────────────────────────────
  console.log('\n=== Local vs Remote Comparison ===');
  console.log(`  Prompts: ${prompts.length}`);

  const localAvg = localResults.reduce((s, r) => s + r.total_ms, 0) / localResults.length;
  const remoteAvg = remoteResults.reduce((s, r) => s + r.roundtrip_ms, 0) / remoteResults.length;
  const nodeAvg = remoteResults.reduce((s, r) => s + r.timing.total_ms, 0) / remoteResults.length;
  const overheadAvg = remoteAvg - localAvg;
  const networkMs = remoteAvg - nodeAvg;

  console.log(`  Local avg:      ${localAvg.toFixed(0)}ms`);
  console.log(`  Remote avg:     ${remoteAvg.toFixed(0)}ms (roundtrip)`);
  console.log(`  Node avg:       ${nodeAvg.toFixed(0)}ms (inference only)`);
  console.log(`  Network avg:    ${networkMs.toFixed(0)}ms (serialization + transport)`);
  console.log(`  Overhead:       ${overheadAvg.toFixed(0)}ms (${(overheadAvg / localAvg * 100).toFixed(1)}% of local)`);
  console.log(`  Tokens/s local: ${(localResults.reduce((s, r) => s + r.tokens, 0) / (localResults.reduce((s, r) => s + r.total_ms, 0) / 1000)).toFixed(1)}`);
  console.log(`  Tokens/s remote:${(remoteResults.reduce((s, r) => s + r.tokens.length, 0) / (remoteResults.reduce((s, r) => s + r.roundtrip_ms, 0) / 1000)).toFixed(1)}`);

  // ── Save results ───────────────────────────────────────────────────────
  const outDir = path.resolve('experiments/qwen3_0.6b/EXP-0002A/output');
  fs.mkdirSync(outDir, { recursive: true });

  const localData = localResults.map((r, i) => ({
    prompt_index: i, prompt: prompts[i].prompt.slice(0, 60),
    tokens: r.tokens, total_ms: r.total_ms,
  }));
  const remoteData = remoteResults.map((r, i) => ({
    prompt_index: i, prompt: prompts[i].prompt.slice(0, 60),
    tokens: r.tokens.length, roundtrip_ms: r.roundtrip_ms,
    node_ms: r.timing.total_ms, network_ms: r.roundtrip_ms - r.timing.total_ms,
  }));
  const comparison = {
    experiment: 'EXP-0002A',
    node_url: nodeUrl,
    num_prompts: prompts.length,
    local_avg_ms: Math.round(localAvg),
    remote_avg_ms: Math.round(remoteAvg),
    node_avg_ms: Math.round(nodeAvg),
    network_avg_ms: Math.round(networkMs),
    overhead_avg_ms: Math.round(overheadAvg),
    overhead_pct: Math.round(overheadAvg / localAvg * 100 * 10) / 10,
    node_metadata: remoteResults[0]?.metadata || {},
    local: localData,
    remote: remoteData,
  };

  fs.writeFileSync(path.join(outDir, 'comparison.json'), JSON.stringify(comparison, null, 2));
  console.log(`\n  Results saved to ${outDir}/comparison.json`);

  await adapter.unload();
}

main().catch((e) => { console.error(e); process.exit(1); });
