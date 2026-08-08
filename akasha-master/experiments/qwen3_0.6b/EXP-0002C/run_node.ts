#!/usr/bin/env npx tsx
/**
 * EXP-0002C — Capability-Aware Node Client
 *
 * Registers with capability profile. Master routes based on capability match.
 *
 * Usage:
 *   # Coding Expert
 *   npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts \
 *     --master ws://localhost:8080 --node-id node-coding \
 *     --capability '{"coding":0.95,"math":0.65,"general":0.80}'
 *
 *   # Math Expert
 *   npx tsx experiments/qwen3_0.6b/EXP-0002C/run_node.ts \
 *     --master ws://localhost:8080 --node-id node-math \
 *     --capability '{"coding":0.62,"math":0.94,"general":0.80}'
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
const capabilityStr = getArg('--capability', '{"general":0.8}');
const modelId = getArg('--model', 'onnx-community/Qwen3-0.6B-ONNX');
const device = getArg('--device', 'cpu');

let capabilities: Record<string, number>;
try { capabilities = JSON.parse(capabilityStr); } catch {
  capabilities = { general: 0.8 };
}

async function main() {
  console.log('═'.repeat(60));
  console.log(`EXP-0002C Node Client — ${nodeId}`);
  console.log(`  Capabilities: ${JSON.stringify(capabilities)}`);
  console.log(`  Model:  ${modelId}`);
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

    ws.send(JSON.stringify({
      type: 'register',
      node: {
        id: nodeId,
        platform: `${process.platform}-${process.arch}`,
        device: 'PC',
        role: 'expert',
        capabilities,
        cores: os.cpus().length,
      },
    }));
    console.log(`  📝 Registered with capabilities: ${JSON.stringify(capabilities)}`);
  });

  ws.on('message', async (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'register_ack') {
      console.log(`  ✅ Registration confirmed. Routed as: ${msg.routed_as || 'expert'}`);
      console.log(`  🟢 ${nodeId} ready\n`);
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t, node_id: nodeId }));
      return;
    }

    if (msg.type === 'compute') {
      const t0 = performance.now();
      const promptPreview = (msg.prompt || '').slice(0, 50);
      console.log(`  📥 [${msg.request_id}] "${promptPreview}..."`);

      try {
        const output = await adapter.generate({
          prompt: msg.prompt,
          maxNewTokens: msg.max_new_tokens || 32,
          temperature: msg.temperature ?? 0,
          topP: msg.top_p ?? 1,
          topK: 50,
        });
        const totalMs = performance.now() - t0;

        ws.send(JSON.stringify({
          type: 'result',
          request_id: msg.request_id,
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
            role: 'expert',
            capabilities,
          },
        }));
        console.log(`  📤 [${msg.request_id}] ${output.tokenIds.length} tokens, ${totalMs.toFixed(0)}ms`);
      } catch (e: any) {
        console.error(`  ❌ [${msg.request_id}] ${e.message}`);
        ws.send(JSON.stringify({ type: 'error', request_id: msg.request_id, error: e.message, node_id: nodeId }));
      }
    }
  });

  ws.on('close', () => { console.log(`\n  🔌 Disconnected. Exiting.`); adapter.unload().catch(() => {}); process.exit(0); });
  ws.on('error', (e) => { console.error(`  ❌ WS error: ${e.message}\n     Is Master running on ${masterUrl}?`); process.exit(1); });
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

