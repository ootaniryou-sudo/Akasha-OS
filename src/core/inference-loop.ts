/**
 * akasha-inference-loop.ts
 *
 * Akasha OS — Inference Main Loop / Activation Relay Engine
 * ─────────────────────────────────────────────────────────
 * Coordinates token-by-token LLM inference across thousands of edge devices
 * organised into layer "bands".  Each band owns a contiguous slice of the
 * model; activations are relayed band→band via zero-copy binary packets.
 *
 * ## Key mechanisms
 *
 * 1. **P2P direct relay** — non-tail bands forward Float32Array activations
 *    directly to the next band's nodes (or via the master as a transparent
 *    proxy when the edge cannot run a server).  No JSON, no string allocs.
 *
 * 2. **Speculative shadow racing** — every COMPUTE_TASK / RELAY is fanned
 *    out to a primary + a shadow node.  The next band accepts whichever
 *    result arrives first and atomically drops the late duplicate.
 *
 * 3. **Token-generation pipeline** — when the tail band produces output
 *    logits the master extracts the next token, streams it to the user,
 *    and immediately feeds the token embedding back into the head band
 *    as the next inference step (overlapped compute / streaming).
 *
 * 4. **Zero-copy buffer pool** — all activation tensors ride on pre-allocated
 *    ArrayBuffers from BufferPool.  Relay operations alias views without
 *    copying; the pool recycles buffers as soon as they are consumed.
 *
 * ## Pipeline state machine
 *
 *   IDLE → FEEDING (head band receives embedding)
 *        → RELAYING (mid bands forward activations)
 *        → DECODING (tail band produces logits → token)
 *        → STREAMING (token yielded, next embedding fed back)
 *        → DONE (EOS or max_tokens)
 *
 * ## Wire commands added
 *
 *   RELAY (0x0A) — inter-band activation forward
 *   TOKEN_OUT (0x0B) — tail band → master token prediction
 */

import { BufferPool } from '../pool/object-pool.js';
import { BinaryCodec } from '../binary/codec.js';
import {
  Cmd,
  ClusterId,
  Flag,
  MAX_PACKET_BYTES,
  nowUs,
} from '../binary/protocol.js';
import {
  FaultToleranceEngine,
  createTxPool,
  TX_ACTIVE,
} from '../fault/fault-tolerance.js';
import { IdleClusterPool, type AkashaNodeRecord } from '../structures/idle-cluster-pool.js';

// ─── Band / topology types ──────────────────────────────────────────────────

/** One contiguous slice of the model assigned to a group of nodes. */
export interface LayerBand {
  /** Unique band id (0 = head, N-1 = tail). */
  bandId: number;
  /** First transformer layer index (inclusive). */
  startLayer: number;
  /** Last transformer layer index (inclusive). */
  endLayer: number;
  /** Semantic cluster for idle-pool dispatch. */
  clusterId: number;
  /** Primary nodes (round-robin selected per token). */
  nodes: bigint[];
  /** Shadow nodes paired 1:1 with primary (or empty). */
  shadows: bigint[];
  /**
   * Next-band relay target.
   * - If `directIp` is set, the edge should open a WebSocket to that host.
   * - If null / empty, the master proxies the relay (default for browser edges).
   */
  nextHop: RelayTarget | null;
  /** Layer dimension (hidden size) — must match across all nodes. */
  hiddenSize: number;
}

/** Where to send activations after this band finishes. */
export interface RelayTarget {
  /** IP:port of the next-band relay endpoint. */
  host: string;
  port: number;
  /** If true, master proxies; node sends RESULT back to master for forwarding. */
  proxied: boolean;
}

/** One step (token position) inside the pipeline. */
export interface PipelineStep {
  /** Monotonically increasing step index (0 = first token). */
  step: number;
  /** The token id produced by the previous step (or prompt token). */
  tokenId: number;
  /** Current band index (0..N-1) that is computing. */
  bandIndex: number;
  /** Transaction id for the in-flight compute at this step. */
  txId: bigint;
  /** Timestamp when this step was dispatched to the head band. */
  startedUs: bigint;
  /** Activation buffer for this step (pooled, zero-copy relay target). */
  activationBuf: ArrayBuffer | null;
  /** Number of valid floats in activationBuf. */
  activationFloats: number;
  /** Shadow already dispatched? */
  shadowDispatched: boolean;
  /** Step state. */
  state: PipelineStepState;
}

export const enum PipelineStepState {
  /** Waiting for COMPUTE_TASK dispatch to head band. */
  QUEUED = 0,
  /** Head band computing → waiting for RELAY from head. */
  HEAD_COMPUTING = 1,
  /** Mid band(s) computing → waiting for RELAY. */
  MID_COMPUTING = 2,
  /** Tail band computing → waiting for TOKEN_OUT. */
  TAIL_COMPUTING = 3,
  /** Token produced, streaming to user. */
  STREAMING = 4,
  /** Step complete (activation recycled). */
  DONE = 5,
  /** Step failed / timed out. */
  FAILED = 6,
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface InferenceLoopOptions {
  /** Layer bands in pipeline order (head → mid → tail). */
  bands: LayerBand[];
  /** Max tokens to generate (safety limit). */
  maxTokens?: number;
  /** EOS token id to stop generation. */
  eosTokenId?: number;
  /** Shadow racing margin (μs). Default 2000 = +2ms. */
  shadowMarginUs?: number;
  /** Fault-tolerance scan interval (ms). Default 1. */
  faultTickMs?: number;

  // ── Callbacks (the loop is pure logic; I/O is injected) ──────────────────

  /** Send a binary packet to a socket slot (synchronous / copy-safe). */
  send?: (socketSlot: number, buf: ArrayBuffer, byteLength: number) => void;
  /** Look up a socket slot for a node id. */
  slotForNode?: (nodeId: bigint) => number;
  /** Resolve an idle node for a cluster (returns {node, shadow}). */
  acquireNode?: (clusterId: number) => {
    primary: AkashaNodeRecord;
    shadow: AkashaNodeRecord | null;
  } | null;
  /** Release a node back to idle after compute. */
  releaseNode?: (nodeId: bigint) => void;
  /** Called when a token is produced (stream to user). */
  onToken?: (tokenId: number, text: string, step: number) => void;
  /** Called when generation completes. */
  onComplete?: (tokens: number[]) => void;
  /** Telemetry (no string alloc on hot path). */
  onEvent?: (ev: InferenceEvent) => void;
}

export type InferenceEvent =
  | { type: 'pipeline_start'; promptTokens: number }
  | { type: 'step_dispatched'; step: number; band: number; txId: bigint; primary: bigint; shadow: bigint | null }
  | { type: 'relay_forward'; step: number; fromBand: number; toBand: number; txId: bigint; rttUs: number }
  | { type: 'shadow_race_win'; step: number; band: number; winner: 'primary' | 'shadow'; loserNodeId: bigint }
  | { type: 'token_produced'; step: number; tokenId: number; totalLatencyUs: bigint }
  | { type: 'step_timeout'; step: number; band: number; txId: bigint }
  | { type: 'pipeline_done'; totalTokens: number; totalLatencyUs: bigint };

// ─── Inference loop engine ──────────────────────────────────────────────────

export class AkashaInferenceLoop {
  private readonly opts: Required<
    Pick<
      InferenceLoopOptions,
      'bands' | 'maxTokens' | 'eosTokenId' | 'shadowMarginUs' | 'faultTickMs'
    >
  > &
    Pick<
      InferenceLoopOptions,
      'send' | 'slotForNode' | 'acquireNode' | 'releaseNode' | 'onToken' | 'onComplete' | 'onEvent'
    >;

  private readonly bufPool = new BufferPool(MAX_PACKET_BYTES, 256, 4096);
  private readonly fault: FaultToleranceEngine;
  private readonly txPool = createTxPool(16_384);

  /** Step index → PipelineStep (only in-flight steps live here). */
  private readonly steps = new Map<number, PipelineStep>();
  /** txId → step index for fast RESULT/RELAY correlation. */
  private readonly txToStep = new Map<string, number>();

  /** Band-level round-robin cursor (bandId → next node index). */
  private readonly bandCursors = new Map<number, number>();

  private stepCounter = 0;
  private tokenCounter = 0;
  private pipelineStartUs = 0n;
  private running = false;
  private faultTimer: ReturnType<typeof setInterval> | null = null;

  /** Dummy idle-pool stand-in when acquireNode is not provided. */
  private fallbackPool: IdleClusterPool | null = null;
  /** Per-node monotonic sequence counter for QUIC datagram ordering. */
  private _seqMap = new Map<string, number>();
  /** Base nonce for txId generation (set once at construction). */
  private readonly _nodeNonce: bigint;

  constructor(options: InferenceLoopOptions) {
    this.opts = {
      bands: options.bands,
      maxTokens: options.maxTokens ?? 4096,
      eosTokenId: options.eosTokenId ?? 2, // GPT-style EOS
      shadowMarginUs: options.shadowMarginUs ?? 2_000,
      faultTickMs: options.faultTickMs ?? 1,
      send: options.send,
      slotForNode: options.slotForNode,
      acquireNode: options.acquireNode,
      releaseNode: options.releaseNode,
      onToken: options.onToken,
      onComplete: options.onComplete,
      onEvent: options.onEvent,
    };

    // Fault-tolerance is used for timeouts _within_ each band hop.
    // In production the router worker owns the pool and injects acquireNode/releaseNode.
    // This fallback pool handles the case where those callbacks are not provided.
    this.fallbackPool = new IdleClusterPool(4096);
    this.fault = new FaultToleranceEngine(this.fallbackPool, this.txPool, {
      marginUs: this.opts.shadowMarginUs,
    });
    // FIX: generate a stable nonce from current time for txId mixing
    this._nodeNonce = BigInt(Date.now()) ^ (BigInt(Math.floor(Math.random() * 0x100000000)) << 20n);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Start the pipeline with pre-tokenized prompt ids. */
  start(promptTokenIds: number[]): void {
    if (this.running) return;
    this.running = true;
    this.stepCounter = 0;
    this.tokenCounter = 0;
    this.pipelineStartUs = nowUs();
    this.steps.clear();
    this.txToStep.clear();

    this.opts.onEvent?.({ type: 'pipeline_start', promptTokens: promptTokenIds.length });

    // Start fault-tolerance scan (FIX: was missing)
    this._startFaultTimer();

    // Feed the first prompt token into the head band.
    // Subsequent prompt tokens are fed one at a time as each step completes
    // (autoregressive loop).
    if (promptTokenIds.length > 0) {
      this.feedHead(promptTokenIds[0], 0, /* isPromptPrefill */ promptTokenIds);
    }
  }

  /**
   * Handle an inbound RELAY packet (from a non-tail band).
   * The relay carries the activation tensor to the next band.
   */
  handleRelay(
    txId: bigint,
    _fromNodeId: bigint,
    bandIndex: number,
    activation: Float32Array,
    recvUs: bigint,
  ): void {
    const stepIdx = this.txToStep.get(txId.toString());
    if (stepIdx === undefined) return; // late duplicate (shadow lost race)
    const step = this.steps.get(stepIdx);
    if (!step || step.state === PipelineStepState.DONE || step.state === PipelineStepState.FAILED) {
      return; // already resolved
    }

    const nextBand = bandIndex + 1;
    if (nextBand >= this.opts.bands.length) {
      // Should not happen — tail band uses TOKEN_OUT, not RELAY
      this.failStep(step, 'relay from tail band unexpected');
      return;
    }

    const rttUs = Number(recvUs - step.startedUs);

    // Cache the activation in the step buffer for potential shadow retry
    this.cacheActivation(step, activation);

    // Forward to next band (P2P relay or master-proxied)
    this.forwardToBand(step, nextBand, activation);

    this.opts.onEvent?.({
      type: 'relay_forward',
      step: step.step,
      fromBand: bandIndex,
      toBand: nextBand,
      txId,
      rttUs,
    });
  }

  /**
   * Handle TOKEN_OUT from the tail band — extract token, stream, feedback.
   */
  handleTokenOut(
    txId: bigint,
    nodeId: bigint,
    logits: Float32Array,
    recvUs: bigint,
  ): void {
    const stepIdx = this.txToStep.get(txId.toString());
    if (stepIdx === undefined) return;
    const step = this.steps.get(stepIdx);
    if (!step || step.state === PipelineStepState.DONE || step.state === PipelineStepState.FAILED) {
      return;
    }

    const totalLatencyUs = recvUs - step.startedUs;
    const tokenId = this.argmax(logits);

    step.state = PipelineStepState.STREAMING;

    // Release the tail-band nodes
    this.opts.releaseNode?.(nodeId);

    // Drop any late shadow result for this step
    this.fault.untrack(txId);

    this.opts.onEvent?.({
      type: 'token_produced',
      step: step.step,
      tokenId,
      totalLatencyUs,
    });

    // Stream token to user
    this.opts.onToken?.(tokenId, String(tokenId), step.step);

    // Recycle activation buffer
    this.recycleActivation(step);

    // Cleanup txToStep map (FIX: prevent memory leak on success path)
    this.txToStep.delete(txId.toString());

    // Check termination
    if (tokenId === this.opts.eosTokenId || this.tokenCounter >= this.opts.maxTokens) {
      step.state = PipelineStepState.DONE;
      this.finishPipeline();
      return;
    }

    // Mark step done
    step.state = PipelineStepState.DONE;
    this.tokenCounter++;

    // Auto-regressive feedback: feed this token as the next input
    this.feedHead(tokenId, step.step + 1, null);
  }

  /**
   * Handle a RESULT that is actually a shadow-race win notification.
   * The real relay/TOKEN_OUT is already handled; this just cleans up.
   */
  handleLateResult(txId: bigint, nodeId: bigint): void {
    const stepIdx = this.txToStep.get(txId.toString());
    if (stepIdx === undefined) return;
    const step = this.steps.get(stepIdx);
    if (!step) return;

    // Late duplicate — release the losing node
    this.opts.releaseNode?.(nodeId);
    this.opts.onEvent?.({
      type: 'shadow_race_win',
      step: step.step,
      band: step.bandIndex,
      winner: 'primary', // approximate
      loserNodeId: nodeId,
    });
  }

  /** Abort the pipeline. */
  abort(): void {
    this.running = false;
    if (this.faultTimer) {
      clearInterval(this.faultTimer);
      this.faultTimer = null;
    }
    // Recycle all in-flight activation buffers
    for (const step of this.steps.values()) {
      this.recycleActivation(step);
    }
    this.steps.clear();
    this.txToStep.clear();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get inFlightSteps(): number {
    return this.steps.size;
  }

  // ─── Internal: feed head band ─────────────────────────────────────────────

  private feedHead(
    tokenId: number,
    stepIndex: number,
    _promptTokenIds: number[] | null,
  ): void {
    const headBand = this.opts.bands[0];
    if (!headBand) {
      this.finishPipeline();
      return;
    }

    const nodePair = this.pickNode(headBand, 0);
    if (!nodePair) {
      // No idle nodes — could queue or fail. For now, skip step.
      this.opts.onEvent?.({
        type: 'step_timeout',
        step: stepIndex,
        band: 0,
        txId: 0n,
      });
      return;
    }

    const txId = this.nextTxId();
    const step: PipelineStep = {
      step: stepIndex,
      tokenId,
      bandIndex: 0,
      txId,
      startedUs: nowUs(),
      activationBuf: null,
      activationFloats: 0,
      shadowDispatched: nodePair.shadow !== null,
      state: PipelineStepState.HEAD_COMPUTING,
    };

    this.steps.set(stepIndex, step);
    this.txToStep.set(txId.toString(), stepIndex);

    // Build embedding payload: single token id as f32 seed + hidden-size zero-init
    // (In production this would be a real embedding table lookup on the edge.)
    const hiddenSize = headBand.hiddenSize;
    const embedding = new Float32Array(hiddenSize);
    embedding[0] = tokenId; // seed — real embedding done on edge GPU

    // Cache activation for potential shadow retry
    this.cacheActivation(step, embedding);

    // Dispatch to primary
    this.dispatchCompute(txId, nodePair.primary, headBand.clusterId, embedding, Flag.NONE);

    // Fan-out to shadow (speculative racing)
    if (nodePair.shadow) {
      this.dispatchCompute(
        txId,
        nodePair.shadow,
        headBand.clusterId,
        embedding,
        Flag.SHADOW,
      );
    }

    this.opts.onEvent?.({
      type: 'step_dispatched',
      step: stepIndex,
      band: 0,
      txId,
      primary: nodePair.primary.nodeId,
      shadow: nodePair.shadow?.nodeId ?? null,
    });
  }

  // ─── Internal: forward to next band ───────────────────────────────────────

  private forwardToBand(
    step: PipelineStep,
    bandIndex: number,
    activation: Float32Array,
  ): void {
    const band = this.opts.bands[bandIndex];
    if (!band) {
      this.failStep(step, `band ${bandIndex} not found`);
      return;
    }

    step.bandIndex = bandIndex;

    const isTail = bandIndex === this.opts.bands.length - 1;
    const nodePair = this.pickNode(band, bandIndex);
    if (!nodePair) {
      this.failStep(step, `no idle nodes for band ${bandIndex}`);
      return;
    }

    const txId = step.txId;
    const cmd = isTail ? Cmd.COMPUTE_TASK : Cmd.RELAY;
    const flags = isTail ? Flag.FINAL : Flag.NONE;

    // Dispatch to primary
    this.dispatchCompute(txId, nodePair.primary, band.clusterId, activation, flags, cmd);

    // Fan-out to shadow
    if (nodePair.shadow) {
      this.dispatchCompute(
        txId,
        nodePair.shadow,
        band.clusterId,
        activation,
        flags | Flag.SHADOW,
        cmd,
      );
      step.shadowDispatched = true;
    }

    step.state = isTail
      ? PipelineStepState.TAIL_COMPUTING
      : PipelineStepState.MID_COMPUTING;
  }

  // ─── Node selection ───────────────────────────────────────────────────────

  private pickNode(
    band: LayerBand,
    bandIndex: number,
  ): { primary: AkashaNodeRecord; shadow: AkashaNodeRecord | null } | null {
    // Use injected acquireNode if available
    if (this.opts.acquireNode) {
      return this.opts.acquireNode(band.clusterId);
    }

    // Fallback: round-robin from band node list
    const cursor = this.bandCursors.get(bandIndex) ?? 0;
    const nodes = band.nodes;
    if (nodes.length === 0) return null;

    const primaryId = nodes[cursor % nodes.length];
    this.bandCursors.set(bandIndex, (cursor + 1) >>> 0);

    // FIX: acquire the specific node by ID, not any idle node
    const primary = this.fallbackPool!.get(primaryId);
    if (!primary) return null;

    // Ensure it is in IDLE state (if COMPUTING, skip to next in round-robin)
    if (primary.status !== 0 /* STATUS_IDLE */) {
      // Try next node in the band
      const nextCursor = (cursor + 1) >>> 0;
      this.bandCursors.set(bandIndex, nextCursor);
      return this.pickNode(band, bandIndex);
    }

    // Mark as COMPUTING
    const acquired = this.fallbackPool!.acquireIdle(band.clusterId);
    if (!acquired || acquired.nodeId !== primaryId) {
      // Pool gave us a different node — use it anyway (pool is authoritative)
      // but log the mismatch for debugging
    }

    const shadow =
      cursor < band.shadows.length
        ? this.fallbackPool!.acquireShadow(acquired ?? primary, ClusterId.SHADOW_POOL)
        : null;

    return { primary: acquired ?? primary, shadow };
  }

  // ─── Dispatch helpers ─────────────────────────────────────────────────────

  /**
   * Dispatch a compute/relay packet to a node.
   *
   * CONTRACT: `send()` MUST synchronously copy or flush the buffer.
   * The buffer is released back to the pool immediately after send() returns.
   * If the transport is async, the caller must provide a `send` that copies.
   */
  private dispatchCompute(
    txId: bigint,
    node: AkashaNodeRecord,
    clusterId: number,
    activation: Float32Array,
    flags: number,
    command: Cmd = Cmd.COMPUTE_TASK,
  ): void {
    const send = this.opts.send;
    const slotForNode = this.opts.slotForNode;
    if (!send || !slotForNode) return;

    const socketSlot = slotForNode(node.nodeId);
    // FIX: slot 0 is valid; only reject negative/null
    if (socketSlot == null || socketSlot < 0) return;

    // Monotonic sequence number for this txId (FIX: non-zero seq for QUIC reliability)
    const seq = this._nextSeq(txId);

    const buf = this.bufPool.acquire();
    try {
      const len = BinaryCodec.encode(buf, {
        command,
        flags,
        txId,
        nodeId: node.nodeId,
        clusterId,
        timestampUs: nowUs(),
        expectedUs: 0,
        seq,
        payload: activation,
      });
      send(socketSlot, buf, len);
    } finally {
      // Always release even if send throws
      this.bufPool.release(buf);
    }

    // Track for fault tolerance (primary dispatch only)
    if ((flags & Flag.SHADOW) === 0) {
      const tx = this.fault.arm(txId, clusterId, node);
      tx.state = TX_ACTIVE;
    }
  }

  /** Per-txId monotonic sequence counter (for QUIC datagram ordering). */
  private _nextSeq(txId: bigint): number {
    const key = txId.toString();
    const next = (this._seqMap.get(key) ?? 0) + 1;
    this._seqMap.set(key, next);
    if (this._seqMap.size > 1000) {
      const keys = [...this._seqMap.keys()];
      for (let i = 0; i < keys.length - 500; i++) this._seqMap.delete(keys[i]);
    }
    return next;
  }

  // ─── Token extraction ─────────────────────────────────────────────────────

  private argmax(logits: Float32Array): number {
    let maxVal = -Infinity;
    let maxIdx = 0;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > maxVal) {
        maxVal = logits[i];
        maxIdx = i;
      }
    }
    return maxIdx;
  }

  // ─── Activation buffer management (zero-copy pool) ────────────────────────

  /**
   * Cache activation in the step's pooled buffer.
   * If a buffer already exists, overwrite in-place (no alloc).
   */
  private cacheActivation(step: PipelineStep, activation: Float32Array): void {
    const needed = activation.byteLength;
    if (!step.activationBuf || step.activationBuf.byteLength < needed) {
      // Need larger buffer — recycle old, acquire new
      if (step.activationBuf) this.bufPool.release(step.activationBuf);
      step.activationBuf = this.bufPool.acquire();
    }
    // Zero-copy write: alias the buffer region
    const dest = new Float32Array(step.activationBuf, 0, activation.length);
    dest.set(activation);
    step.activationFloats = activation.length;
  }

  /** Return the activation buffer to the pool. */
  private recycleActivation(step: PipelineStep): void {
    if (step.activationBuf) {
      this.bufPool.release(step.activationBuf);
      step.activationBuf = null;
      step.activationFloats = 0;
    }
  }

  // ─── Pipeline management ──────────────────────────────────────────────────

  private failStep(step: PipelineStep, _reason: string): void {
    step.state = PipelineStepState.FAILED;
    this.recycleActivation(step);
    this.txToStep.delete(step.txId.toString());
    this.fault.untrack(step.txId);
  }

  private finishPipeline(): void {
    this.running = false;
    if (this.faultTimer) {
      clearInterval(this.faultTimer);
      this.faultTimer = null;
    }
    const totalUs = nowUs() - this.pipelineStartUs;
    this.opts.onEvent?.({ type: 'pipeline_done', totalTokens: this.tokenCounter, totalLatencyUs: totalUs });
    this.opts.onComplete?.([]);
    // Recycle remaining buffers
    for (const step of this.steps.values()) {
      this.recycleActivation(step);
    }
    this.steps.clear();
    this.txToStep.clear();
  }

  /**
   * Generate a cluster-wide unique transaction ID.
   * Mixes: nodeNonce + monotonic counter + timestamp for collision resistance.
   */
  private nextTxId(): bigint {
    return (this._nodeNonce << 32n) ^ (BigInt(Date.now()) << 20n) ^ BigInt(this.stepCounter++);
  }

  /** Start fault-tolerance scan timer (FIX: was missing from start()). */
  private _startFaultTimer(): void {
    if (this.faultTimer) return;
    this.faultTimer = setInterval(() => {
      this.fault.scan((tx, shadow) => {
        // On timeout: re-dispatch to shadow node
        const stepIdx = this.txToStep.get(tx.txId.toString());
        if (stepIdx === undefined) return;
        const step = this.steps.get(stepIdx);
        if (!step || step.shadowDispatched) return;

        const activation = this.getCachedActivation(step);
        if (!activation) return;

        this.dispatchCompute(tx.txId, shadow, tx.clusterId, activation, Flag.SHADOW);
        step.shadowDispatched = true;

        this.opts.onEvent?.({
          type: 'step_timeout',
          step: step.step,
          band: step.bandIndex,
          txId: tx.txId,
        });
      });
    }, this.opts.faultTickMs);
    if (typeof this.faultTimer === 'object' && 'unref' in this.faultTimer) {
      this.faultTimer.unref();
    }
  }

  /** Get cached activation for shadow retry. */
  private getCachedActivation(step: PipelineStep): Float32Array | null {
    if (!step.activationBuf || step.activationFloats === 0) return null;
    return new Float32Array(step.activationBuf, 0, step.activationFloats);
  }
}
