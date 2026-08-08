#!/usr/bin/env npx tsx
/**
 * EXP-0002E — Composite-Aware Node Client
 *
 * Registers with backend/precision for Stability lookup from EXP-0001.
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002E/run_node.ts \
 *     --master ws://localhost:8080 --node-id node-fp16 \
 *     --backend mps --precision fp16 \
 *     --capability '{"coding":0.95,"math":0.65,"general":0.80}'
 */

import WebSocket from 'ws';
import { QwenAdapter } from '../../../src/llm/adapters/qwen.js';
import * as os from 'node:os';

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const masterUrl = getArg('--master', 'ws://localhost:8080');
const nodeId = getArg('--node-id', `node-${process.pid}`);
const backend = getArg('--backend', 'cpu');
const precision = getArg('--precision', 'fp16');
const capabilityStr = getArg('--capability', '{"general":0.8}');
const modelId = getArg('--model', 'onnx-community/Qwen3-0.6B-ONNX');
const device = getArg('--device', 'cpu');

let capabilities: Record<string, number>;
try { capabilities = JSON.parse(capabilityStr); } catch { capabilities = { general: 0.8 }; }

async function main() {
  console.log('═'.repeat(60));
  console.log(`EXP-0002E Node — ${nodeId}`);
  console.log(`  Backend: ${backend}/${precision}`);
  console.log(`  Caps: ${JSON.stringify(capabilities)}`);
  console.log('═'.repeat(60));

  console.log('\n[1/2] Loading Qwen adapter...');
  const adapter = new QwenAdapter({ modelId, device });
  await adapter.loadModel();
  console.log(`       Loaded.`);

  console.log(`\n[2/2] Connecting to ${masterUrl} ...`);
  const ws = new WebSocket(masterUrl);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'register', node: {
        id: nodeId, platform: `${process.platform}-${process.arch}`,
        device: 'PC', role: 'expert',
        backend, precision, capabilities, cores: os.cpus().length,
      },
    }));
    console.log(`  ✅ Registered: ${backend}/${precision}`);
  });

  ws.on('message', async (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'register_ack') {
      console.log(`  ✅ ACK. Stability=${msg.stability}. Weights=${JSON.stringify(msg.weights)}`);
      console.log(`  🟢 ${nodeId} ready\n`);
      return;
    }
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); return; }

    if (msg.type === 'compute') {
      const t0 = performance.now();
      try {
        const output = await adapter.generate({
          prompt: msg.prompt, maxNewTokens: msg.max_new_tokens || 32,
          temperature: msg.temperature ?? 0, topP: msg.top_p ?? 1, topK: 50,
        });
        ws.send(JSON.stringify({
          type: 'result', request_id: msg.request_id,
          tokens: output.tokenIds, text: output.text,
          timing: {
            tokenize_ms: Math.round(output.latencyBreakdown.tokenizeMs * 10) / 10,
            prefill_ms: Math.round(output.latencyBreakdown.prefillMs * 10) / 10,
            decode_ms: Math.round(output.latencyBreakdown.decodeMsTotal * 10) / 10,
            total_ms: Math.round((performance.now() - t0) * 10) / 10,
          },
          metadata: { node_id: nodeId, backend, precision, platform: `${process.platform}-${process.arch}`, role: 'expert' },
        }));
      } catch (e: any) { ws.send(JSON.stringify({ type: 'error', request_id: msg.request_id, error: e.message })); }
    }
  });

  ws.on('close', () => { adapter.unload().catch(() => {}); process.exit(0); });
  ws.on('error', (e) => { console.error(`  ❌ ${e.message}`); process.exit(1); });
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

