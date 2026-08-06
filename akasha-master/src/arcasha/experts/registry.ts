/**
 * ArcAsha — Expert Hub (エキスパート登録 + WS 推論 + 決定論キャッシュ)
 *
 * コントローラが WS サーバとなり、run_node_hetero.py のノードがクライアントとして接続。
 * LLM 出力は決定論的 (T=0) なので (node, prompt) をキャッシュする (0003D/E の仕組み)。
 */

import WebSocket, { WebSocketServer } from 'ws';
import type { EvalResult, ExpertInfo, Task } from '../core/types.js';
import { evaluateWith } from '../shadow/shadow.js';

const KNOWN_PARAMS: Record<string, number> = {
  'Qwen/Qwen3-0.6B': 596,
  'HuggingFaceTB/SmolLM2-360M-Instruct': 362,
  'unsloth/gemma-3-1b-it': 1000,
  'Qwen/Qwen2.5-Coder-0.5B': 494,
  'HuggingFaceTB/SmolLM2-135M-Instruct': 135,
  'meta-llama/Llama-3.2-1B-Instruct': 1235,
  'unsloth/Llama-3.2-1B-Instruct': 1235,
  'Qwen/Qwen2.5-1.5B-Instruct': 1540,
};

export function paramsOf(modelId: string): number {
  const known = KNOWN_PARAMS[modelId];
  if (known) return known;
  const m = modelId.match(/(\d+\.?\d*)[bB]/);
  return m ? Math.round(parseFloat(m[1]) * 1000) : 500;
}

export class ExpertHub {
  readonly experts: ExpertInfo[] = [];
  /** register 時に送られた生のノード情報 (platform/backend/precision/settings等) */
  readonly nodeDetails = new Map<string, Record<string, any>>();
  private sockets = new Map<string, WebSocket>();
  private cache = new Map<string, EvalResult>();
  private genCache = new Map<string, string>();
  cacheMiss = 0;
  cacheHit = 0;
  genCacheMiss = 0;
  genCacheHit = 0;
  private started = false;

  /** WS サーバ開始。minNodes 接続で onReady を呼ぶ */
  start(port: number, minNodes: number, onReady: () => void): void {
    if (this.started) return;
    this.started = true;
    const wss = new WebSocketServer({ port });
    wss.on('connection', (ws: WebSocket, req) => {
      const clientIp = req.socket?.remoteAddress || 'unknown';
      let nodeId = `unknown-${clientIp}`;
      ws.on('message', (raw: Buffer) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'register') {
          nodeId = msg.node.id;
          const modelId = msg.node.model_id || 'unknown';
          const params = paramsOf(modelId);
          this.nodeDetails.set(nodeId, msg.node);
          this.experts.push({
            nodeId,
            modelId,
            family: nodeId.split('-').pop() || 'unknown',
            paramsM: params,
            memoryGB: Math.round((params / 500) * 100) / 100,
            temperature: 0.6,
          });
          this.sockets.set(nodeId, ws);
          ws.send(JSON.stringify({ type: 'register_ack', node_id: nodeId, master: 'ArcAsha' }));
          console.log(`  ✅ expert ${nodeId} (${modelId}, ${params}M)`);
          if (this.experts.length >= minNodes) onReady();
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        }
      });
      ws.on('close', () => {
        this.sockets.delete(nodeId);
        this.experts.splice(this.experts.indexOf(this.experts.find(e => e.nodeId === nodeId)!), 1);
      });
      ws.on('error', () => {});
    });
    console.log(`  🟢 ArcAsha ExpertHub on ws://localhost:${port} (need ${minNodes} experts)`);
  }

  /** エキスパートに推論を依頼 (決定論出力キャッシュ付き) */
  async compute(node: ExpertInfo, task: Task): Promise<EvalResult> {
    const key = `${node.nodeId}|${task.prompt}`;
    const hit = this.cache.get(key);
    if (hit) { this.cacheHit++; return hit; }
    const ws = this.sockets.get(node.nodeId);
    if (!ws) throw new Error(`expert ${node.nodeId} not connected`);
    const chat = node.family !== 'qwen';
    const res = await this.sendCompute(ws, `arcasha-${this.cacheMiss}-${node.nodeId}`, task.prompt, chat, 60);
    const val = evaluateWith(node, task, res.text, res.timing.total_ms);
    this.cache.set(key, val);
    this.cacheMiss++;
    return val;
  }

  /** 生テキスト生成 (EXP-0005B LLM Planner 用)。(node,prompt) キャッシュで決定論 */
  async generate(nodeId: string, prompt: string, maxTokens = 200): Promise<string> {
    const key = `gen|${nodeId}|${prompt}`;
    const hit = this.genCache.get(key);
    if (hit !== undefined) { this.genCacheHit++; return hit; }
    const ws = this.sockets.get(nodeId);
    if (!ws) throw new Error(`expert ${nodeId} not connected`);
    const res = await this.sendCompute(ws, `gen-${this.genCacheMiss}-${nodeId}`, prompt, true, maxTokens);
    this.genCache.set(key, res.text);
    this.genCacheMiss++;
    return res.text;
  }

  private sendCompute(
    ws: WebSocket,
    requestId: string,
    prompt: string,
    chat: boolean,
    maxTokens = 60,
  ): Promise<{ text: string; timing: { total_ms: number } }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 120000);
      const handler = (raw: Buffer) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === 'result' && m.request_id === requestId) {
            clearTimeout(timeout);
            ws.removeListener('message', handler);
            resolve({ text: m.text, timing: m.timing });
          } else if (m.type === 'error' && m.request_id === requestId) {
            clearTimeout(timeout);
            ws.removeListener('message', handler);
            reject(new Error(`node error: ${m.error}`));
          }
        } catch { /* ignore */ }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({
        type: 'compute', request_id: requestId, prompt,
        max_new_tokens: maxTokens, temperature: 0, top_p: 1, chat,
      }));
    });
  }

  close(): void {
    for (const ws of this.sockets.values()) ws.close();
  }
}
