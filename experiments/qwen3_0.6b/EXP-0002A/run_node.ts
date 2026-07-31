#!/usr/bin/env npx tsx
/**
 * EXP-0002A — Remote Node Server
 *
 * WebSocket server that loads Qwen3-0.6B and processes prompts from the Master.
 *
 * Protocol (JSON for MVP — binary protocol in EXP-0002B):
 *   → {"type":"compute","request_id":"...","prompt":"..."}
 *   ← {"type":"result","request_id":"...","tokens":[...],"text":"...","timing":{...}}
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/EXP-0002A/run_node.ts --port 8081
 */

import { WebSocketServer, WebSocket } from 'ws';
import { QwenAdapter } from '../../../src/llm/adapters/qwen.js';

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
  timing: {
    tokenize_ms: number;
    prefill_ms: number;
    decode_ms: number;
    total_ms: number;
  };
  metadata: {
    node_id: string;
    model_id: string;
    backend: string;
    precision: string;
    platform: string;
  };
}

const args = process.argv.slice(2);
const port = parseInt(args[args.indexOf('--port') + 1] || '8081', 10);
const modelId = 'onnx-community/Qwen3-0.6B-ONNX';
const nodeId = `node-${port}`;

async function main() {
  console.log(`EXP-0002A Node Server — ${nodeId}`);
  console.log(`  Model: ${modelId}`);
  console.log(`  Port: ${port}`);

  // Load model
  console.log('\nLoading Qwen adapter...');
  const adapter = new QwenAdapter({ modelId, device: 'cpu' });
  await adapter.loadModel();
  const meta = adapter.getModelMetadata();
  console.log(`  Loaded: ${meta.name} (${(meta.paramCount / 1e9).toFixed(1)}B params)`);

  // WebSocket server
  const wss = new WebSocketServer({ port });
  console.log(`\nWebSocket server listening on :${port}`);

  wss.on('connection', (ws: WebSocket) => {
    console.log(`  Client connected`);

    ws.on('message', async (raw: Buffer) => {
      let req: ComputeRequest;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      if (req.type !== 'compute') return;

      const t0 = performance.now();

      // Tokenize
      const tTok = performance.now();
      const tokResult = await adapter.tokenize(req.prompt);
      const tokenizeMs = performance.now() - tTok;

      // Generate
      const tGen = performance.now();
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
          tokenize_ms: Math.round(tokenizeMs * 10) / 10,
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
        },
      };

      ws.send(JSON.stringify(result));
      console.log(`  [${req.request_id}] ${output.tokenIds.length} tokens, ${totalMs.toFixed(0)}ms`);
    });

    ws.on('close', () => console.log('  Client disconnected'));
    ws.on('error', (e) => console.error('  WS error:', e.message));
  });

  console.log('\nReady. Waiting for Master connections...\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
