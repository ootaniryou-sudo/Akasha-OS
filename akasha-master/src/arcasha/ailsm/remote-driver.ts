/**
 * Remote Driver（Phase 1.0）— 実LLM（Qwen2.5 / Phi / Gemma）を呼ぶ ExpertDriver
 *
 * MockExpertDriver（決定論スタブ）を、実際のデバイス上の LLM に置き換える。
 *
 *   Driver → ModelClient（ExpertHub WS:8080）→ iPad/iPhone の llama.cpp/ggml-metal
 *
 * AILSA 命令列（CALL/INPUT）からプロンプトを組み立て、実モデルの生成結果を返す。
 * 非同期（invoke が Promise を返す）— Mock は同期のまま互換。
 */

import { Slot } from '../ailsa/vocab.js';
import { ABI_VERSION_1_0, ERRORS } from './abi.js';
import type { AbiVersion, CapabilityAbi, ErrorAbi } from './abi.js';
import type { Instruction } from '../ailsa/encoder.js';
import type { ExpertDriver, DriverRequest, DriverResponse, ContextDriverRequest } from './driver.js';
import type { ModelClient, ModelNode } from './model-client.js';

export interface RemoteDriverOptions {
  deviceId?: string; // 使用デバイス（省略時は ModelClient の最初のノード）
  maxTokens?: number; // 生成トークン上限
  capability?: CapabilityAbi;
}

/** AILSA 命令列 → LLM プロンプト（INPUT スロットを結合） */
export function buildLlmPrompt(program: Instruction[]): string {
  const parts: string[] = [];
  for (const instr of program) {
    const input = instr.slots?.find((s) => s.slot === Slot.INPUT)?.value;
    if (input !== undefined) parts.push(String(input));
  }
  return parts.join(' / ') || '...';
}

export class RemoteDriver implements ExpertDriver {
  readonly id: string;
  readonly name: string;
  readonly abiVersion: AbiVersion = ABI_VERSION_1_0;
  readonly capability: CapabilityAbi;
  private readonly client: ModelClient;
  private readonly deviceId?: string;
  private readonly maxTokens: number;
  lastNode: ModelNode | null = null;

  constructor(id: string, name: string, client: ModelClient, opts: RemoteDriverOptions = {}) {
    this.id = id;
    this.name = name;
    this.client = client;
    this.deviceId = opts.deviceId;
    this.maxTokens = opts.maxTokens ?? 64;
    this.capability = opts.capability ?? { requires: [], supports: ['string'], prefers: [] };
  }

  supports(): boolean {
    return true; // 実LLMは任意のオペコードを扱える（言語理解で対応）
  }

  private node(): ModelNode {
    const nodes = this.client.listNodes();
    if (nodes.length === 0) throw new Error(`実デバイスが接続されていません (${this.id})`);
    if (this.deviceId) {
      const n = nodes.find((x) => x.nodeId === this.deviceId);
      if (n) return n;
    }
    return nodes[0];
  }

  async invoke(req: DriverRequest): Promise<DriverResponse> {
    const trace: string[] = [];
    if (req.abiVersion.major !== this.abiVersion.major || req.abiVersion.minor > this.abiVersion.minor) {
      return { ok: false, error: ERRORS.UNSUPPORTED_ABI, trace: ['abi version mismatch'] };
    }
    try {
      const prompt = buildLlmPrompt(req.program);
      const node = this.node();
      this.lastNode = node;
      const t0 = Date.now();
      const text = await this.client.generate(node.nodeId, prompt, this.maxTokens);
      const ms = Date.now() - t0;
      trace.push(`CALL ${this.id} → ${node.nodeId} (${ms}ms)`);
      trace.push(`PROMPT: ${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}`);
      return { ok: true, result: text, trace };
    } catch (e) {
      const err: ErrorAbi = { code: 3001, message: String(e), recoverable: true, retryable: true };
      return { ok: false, error: err, trace: [...trace, `ERR: ${e}`] };
    }
  }

  /** Long Context ABI: 供給されたページ実体を実LLMへ渡して処理させる */
  async invokeContext(req: ContextDriverRequest): Promise<DriverResponse> {
    const trace: string[] = [];
    if (req.abiVersion.major !== this.abiVersion.major || req.abiVersion.minor > this.abiVersion.minor) {
      return { ok: false, error: ERRORS.UNSUPPORTED_ABI, trace: ['abi version mismatch'] };
    }
    try {
      const node = this.node();
      const prompt = `[${req.expert} expert] 以下のスライス（${req.loadedText.length}文字）を処理してください:\n${req.loadedText.slice(0, 400)}`;
      const text = await this.client.generate(node.nodeId, prompt, this.maxTokens);
      return { ok: true, result: text, trace: [...trace, `CONTEXT#${req.contextRef.contextId} → ${node.nodeId}`] };
    } catch (e) {
      const err: ErrorAbi = { code: 3001, message: String(e), recoverable: true, retryable: true };
      return { ok: false, error: err, trace: [...trace, `ERR: ${e}`] };
    }
  }
}

