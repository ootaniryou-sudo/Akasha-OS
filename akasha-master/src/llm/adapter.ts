/**
 * llm/adapter.ts
 *
 * Akasha-OS — LLM Adapter Interface
 * ─────────────────────────────────
 * モデル固有実装をこのインターフェースの背後に閉じ込める。
 * 将来的に Qwen / Llama / Akasha-native / MoE の切り替えを可能にする。
 *
 * ## Contract
 *
 *   - All methods operate on raw token IDs (number[]) where possible.
 *   - `prefill` and `decode` receive/return Float32Array tensors for
 *     Akasha Runtime compatibility.
 *   - Adapters MUST be stateless aside from loaded model weights;
 *     per-request state (KV cache) is owned by the caller.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

export interface ModelMetadata {
  name: string;
  revision: string;
  paramCount: number;
  hiddenSize: number;
  numLayers: number;
  numHeads: number;
  numKvHeads: number;
  headDim: number;
  intermediateSize: number;
  vocabSize: number;
  maxContextLength: number;
  quantization: string;
  bytesPerParam: number;
}

export interface CacheMetadata {
  maxBatchSize: number;
  maxSeqLen: number;
  kvBytesPerToken: number;
  totalKvBytesForMaxContext: number;
}

export interface TokenizeResult {
  tokenIds: number[];
  numTokens: number;
}

export interface GenerateInput {
  prompt: string;
  /** Pre-tokenized prompt (if available — skips tokenize step). */
  promptTokenIds?: number[];
  maxNewTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  /** Seed for reproducible generation (optional). */
  seed?: number;
}

export interface GenerateOutput {
  tokenIds: number[];
  text: string;
  /** Per-token timing (ms). */
  tokenTimingsMs: number[];
  /** Per-token latency breakdown (ms). */
  latencyBreakdown: LatencyBreakdown;
}

export interface LatencyBreakdown {
  tokenizeMs: number;
  prefillMs: number;
  decodeMsTotal: number;
  totalMs: number;
}

export interface PrefillResult {
  kvCache: ArrayBuffer | null;
  firstTokenLogits: Float32Array;
  elapsedMs: number;
}

export interface DecodeResult {
  nextTokenId: number;
  logits: Float32Array;
  kvCache: ArrayBuffer | null;
  elapsedMs: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Interface
// ═════════════════════════════════════════════════════════════════════════════

export interface LLMAdapter {
  /** Load model weights into memory. Called once on startup. */
  loadModel(): Promise<void>;

  /** Tokenize a text string → token IDs. */
  tokenize(text: string): Promise<TokenizeResult>;

  /** Detokenize token IDs → text string. */
  detokenize(tokenIds: number[]): Promise<string>;

  /**
   * Prefill: process the prompt tokens and produce the first token's logits.
   * Returns KV cache for subsequent decode steps.
   */
  prefill(tokenIds: number[]): Promise<PrefillResult>;

  /**
   * Decode: produce the next token given the current KV cache.
   * Returns the next token ID and updated KV cache.
   */
  decode(lastTokenId: number, kvCache: ArrayBuffer): Promise<DecodeResult>;

  /**
   * Convenience: full generate loop (prefill → decode × N).
   * Implementations may override this for efficiency (e.g., batched decode).
   */
  generate(input: GenerateInput): Promise<GenerateOutput>;

  /** Model architecture metadata. */
  getModelMetadata(): ModelMetadata;

  /** KV cache sizing metadata. */
  getCacheMetadata(): CacheMetadata;

  /** Release model weights and GPU resources. */
  unload(): Promise<void>;
}

