#!/usr/bin/env npx tsx
/**
 * EXP-0002B — Two-Expert Node Client
 *
 * WebSocket client that connects to Master Hub, loads Qwen3-0.6B,
 * and processes compute requests.
 *
 * Protocol:
 *   → {"type":"register","node":{"id":"...","platform":"...","role":"expert"}}
 *   ← {"type":"register_ack","node_id":"...","master":"..."}
 *   ← {"type":"compute","request_id":"...","prompt":"..."}
 *   → {"type":"result","request_id":"...","tokens":[...],"text":"...","timing":{...}}
 *
 * Usage:
 *   # Node A (PC, direct Qwen3-0.6B)
 *   npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts \
 *     --master ws://localhost:8080 --node-id node-a --role expert
 *
 *   # Node B (PC, backend for iPhone relay)
 *   npx tsx experiments/qwen3_0.6b/EXP-0002B/run_node.ts \
 *     --master ws://localhost:8080 --node-id node-b --role expert-backend
 *
 *   # iPhone 12 mini → see public/iphone_12mini_node.html
 */

import WebSocket from 'ws';
import { QwenAdapter } from '../../../src/llm/adapters/qwen.js';
import * as os from 'node:os';

interface ComputeRequest {
  type: 'compute';
  request_id: string;
  prompt: string;
  max_new_tokens: number;
  temperature: number;
  top_p: number;
}

interface ComputeResult {
  type: 'result';
  request_id: string;
  tokens: number[];
  text: string;
  timing: { tokenize_ms: number; prefill_ms: number; decode_ms: number; total_ms: number };
  metadata: { node_id: string; model_id: string; backend: string; precision: string; platform: string; role: string };
}

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const masterUrl = getArg('--master', 'ws://localhost:8080');
const nodeId = getArg('--node-id', `node-${process.pid}`);
const role = getArg('--role', 'expert');
const modelId = getArg('--model', 'onnx-community/Qwen3-0.6B-ONNX');
const device = getArg('--device', 'cpu');

async function main() {
  console.log('═'.repeat(60));
  console.log(`EXP-0002B Node Client — ${nodeId}`);
  console.log(`  Role:   ${role}`);
  console.log(`  Model:  ${modelId}`);
  console.log(`  Device: ${device}`);
  console.log(`  Master: ${masterUrl}`);
  console.log('═'.repeat(60));

  // Load model
  console.log('\n[1/2] Loading Qwen adapter...');
  const tLoad = performance.now();
  const adapter = new QwenAdapter({ modelId, device });
  await adapter.loadModel();
  const meta = adapter.getModelMetadata();
  console.log(`       Loaded in ${(performance.now() - tLoad).toFixed(0)}ms`);
  console.log(`       Model: ${meta.name} (${(meta.paramCount / 1e9).toFixed(1)}B params)`);

  // Connect to Master
  console.log(`\n[2/2] Connecting to Master: ${masterUrl} ...`);
  const ws = new WebSocket(masterUrl);

  ws.on('open', () => {
    console.log(`  ✅ Connected to Master`);

    // Register
    ws.send(JSON.stringify({
      type: 'register',
      node: {
        id: nodeId,
        platform: `${process.platform}-${process.arch}`,
        device: 'PC',
        role,
        backend: 'onnx-transformers.js',
        cores: os.cpus().length,
      },
    }));
    console.log(`  📝 Registered as ${nodeId} (${role})`);
  });

  ws.on('message', async (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Register ack
    if (msg.type === 'register_ack') {
      console.log(`  ✅ Registration confirmed by Master`);
      console.log(`  🟢 ${nodeId} ready for inference\n`);
      return;
    }

    // Ping
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t, node_id: nodeId }));
      return;
    }

    // Compute request
    if (msg.type === 'compute') {
      const req = msg as ComputeRequest;
      const t0 = performance.now();
      console.log(`  📥 [${req.request_id}] "${req.prompt.slice(0, 50)}..."`);

      try {
        // Generate
        const output = await adapter.generate({
          prompt: req.prompt,
          maxNewTokens: req.max_new_tokens || 32,
          temperature: req.temperature ?? 0,
          topP: req.top_p ?? 1,
          topK: 50,
        });
        const totalMs = performance.now() - t0;

        const result: ComputeResult = {
          type: 'result',
          request_id: req.request_id,
          tokens: output.tokenIds,
          text: output.text,
          timing: {
            tokenize_ms: Math.round(output.latencyBreakdown.tokenizeMs * 10) / 10,
            prefill_ms: Math.round(output.latencyBreakdown.prefillMs * 10) / 10,
            decode_ms: Math.round(output.latencyBreakdown.decodeMsTotal * 10) / 10,
            total_ms: Math.round(totalMs * 10) / 10,
          },
          metadata: {
            node_id: nodeId,
            model_id: modelId,
            backend: 'onnx-transformers.js',
            precision: 'fp16',
            platform: `${process.platform}-${process.arch}`,
            role,
          },
        };

        ws.send(JSON.stringify(result));
        console.log(`  📤 [${req.request_id}] ${output.tokenIds.length} tokens, ${totalMs.toFixed(0)}ms`);
      } catch (e: any) {
        console.error(`  ❌ [${req.request_id}] ${e.message}`);
        ws.send(JSON.stringify({
          type: 'error',
          request_id: req.request_id,
          error: e.message,
          node_id: nodeId,
        }));
      }
    }
  });

  ws.on('close', () => {
    console.log(`\n  🔌 Disconnected from Master. Exiting.`);
    adapter.unload().catch(() => {});
    process.exit(0);
  });

  ws.on('error', (e) => {
    console.error(`  ❌ WebSocket error: ${e.message}`);
    console.error(`     Is Master running on ${masterUrl}?`);
    process.exit(1);
  });
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

