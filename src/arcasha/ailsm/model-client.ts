/**
 * Model Client（Phase 1.0）— 実デバイス（Qwen/Phi/Gemma）への抽象インターフェース
 *
 * ExpertHub（WS:8080 に接続された iPad/iPhone の llama.cpp/ggml-metal）を
 * AILSM 側から使うための最小インターフェース。実装は Hub のアダプタ（demo-web.ts 等）が担う。
 * テストでは MockModelClient で決定論的な応答を返す。
 */

export interface ModelNode {
  nodeId: string;
  modelId: string;
  paramsM: number;
}

export interface ModelClient {
  listNodes(): ModelNode[];
  generate(nodeId: string, prompt: string, maxTokens?: number): Promise<string>;
}

/** テスト用 Mock（決定論）: プロンプト → 固定テキスト または [mock nodeId] prompt */
export class MockModelClient implements ModelClient {
  private readonly texts: Record<string, string>;
  private readonly nodes: ModelNode[];
  calls: { nodeId: string; prompt: string; maxTokens: number }[] = [];

  constructor(texts: Record<string, string> = {}, nodes?: ModelNode[]) {
    this.texts = texts;
    this.nodes = nodes ?? [
      { nodeId: 'mock-qwen-1.5b', modelId: 'Qwen/Qwen2.5-1.5B-Instruct', paramsM: 1540 },
      { nodeId: 'mock-iphone15', modelId: 'Qwen/Qwen2.5-1.5B-Instruct', paramsM: 1540 },
    ];
  }

  listNodes(): ModelNode[] {
    return [...this.nodes];
  }

  async generate(nodeId: string, prompt: string, maxTokens = 64): Promise<string> {
    this.calls.push({ nodeId, prompt, maxTokens });
    return this.texts[prompt] ?? `[mock ${nodeId}] ${prompt.slice(0, 40)}`;
  }
}
