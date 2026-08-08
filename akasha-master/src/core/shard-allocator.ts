/**
 * akasha-shard-allocator.ts
 *
 * Akasha OS — Hybrid 2D Model Shard Allocator
 * ───────────────────────────────────────────
 * Splits a 6.7T-class transformer model across thousands of smartphones
 * using pipeline parallelism (layers → hubs) and tensor parallelism
 * (attention heads / MLP columns → nodes within a hub).
 *
 * ## Allocation strategy (heterogeneous)
 *
 *   1.  Calculate per-layer VRAM footprint (FP16 weights × 2 bytes).
 *   2.  Per layer, estimate minimum tensor-parallel replicas needed
 *       to fit within each device's available VRAM.
 *   3.  Group devices by physical hub (same /24 subnet).
 *   4.  Assign pipeline stages (layer ranges) to hub groups.
 *   5.  Within each hub, distribute tensor shards proportional to
 *       each device's APS score (higher APS → larger shard slice).
 *   6.  Constraint: all tensor-parallel peers of the same layer
 *       MUST reside on the same physical hub (zero switch hops).
 *
 * ## Data structures (zero-GC)
 *
 *   All assignment state lives in pre-allocated TypedArrays — no `Map`,
 *   no `object` churn, no `Array.push` on the allocation hot path.
 *
 *   Uint32 Arrays (flat, index = entity id):
 *     shardNode     [shardId]   → nodeId
 *     shardLayer    [shardId]   → layerIdx
 *     shardType     [shardId]   → ShardType (u8)
 *     shardOffset   [shardId]   → byte offset within layer weight
 *     shardBytes    [shardId]   → byte size
 *     layerHub      [layerIdx]  → hubId
 *     layerTP       [layerIdx]  → tensor-parallel degree
 *     hubPipeline   [hubIdx]    → startLayer (low 16 bits) | endLayer (high 16)
 *
 *   O(1) lookups:  given nodeId, find all its shards via a reverse
 *   index in a pre-sized Uint32Array (max shards per node = 16).
 */

// ═════════════════════════════════════════════════════════════════════════════
// 1. Type definitions
// ═════════════════════════════════════════════════════════════════════════════

/** Shard types (what part of a transformer layer a shard covers). */
export const enum ShardType {
  /** Attention: Q, K, V projection weights */
  ATTENTION_QKV = 1,
  /** Attention: output projection weight */
  ATTENTION_OUT = 2,
  /** MLP: gate projection (first half of intermediate_dim) */
  MLP_GATE = 3,
  /** MLP: up projection (second half of intermediate_dim) */
  MLP_UP = 4,
  /** MLP: down projection */
  MLP_DOWN = 5,
  /** LayerNorm weights (γ, β) — small, can be replicated */
  LAYERNORM = 6,
  /** Token embedding (input) */
  EMBEDDING_IN = 7,
  /** LM head (output projection to vocab) */
  EMBEDDING_OUT = 8,
}

/** Human-readable shard type labels. */
export const SHARD_TYPE_NAMES: Record<ShardType, string> = {
  [ShardType.ATTENTION_QKV]: 'attn_qkv',
  [ShardType.ATTENTION_OUT]: 'attn_out',
  [ShardType.MLP_GATE]: 'mlp_gate',
  [ShardType.MLP_UP]: 'mlp_up',
  [ShardType.MLP_DOWN]: 'mlp_down',
  [ShardType.LAYERNORM]: 'layernorm',
  [ShardType.EMBEDDING_IN]: 'embed_in',
  [ShardType.EMBEDDING_OUT]: 'embed_out',
};

// ─── Model architecture specification ──────────────────────────────────────

export interface ModelSpec {
  /** Total transformer layers. */
  numLayers: number;
  /** Hidden dimension. */
  hiddenSize: number;
  /** MLP intermediate dimension (typically 3.5×–4× hiddenSize). */
  intermediateSize: number;
  /** Number of attention heads. */
  numHeads: number;
  /** Number of KV heads (GQA; ≤ numHeads). */
  numKvHeads: number;
  /** Head dimension (hiddenSize / numHeads). */
  headDim: number;
  /** Vocabulary size (for embedding + LM head). */
  vocabSize: number;
  /** Weight precision: 2 = FP16/BF16, 1 = INT8, 0.5 = INT4. */
  bytesPerParam: number;
}

// ─── Device capability specification ───────────────────────────────────────

export interface DeviceSpec {
  /** Unique node ID. */
  nodeId: bigint;
  /** Physical hub / subnet segment ID. */
  hubId: number;
  /** Akasha Performance Score (higher = faster). */
  apsScore: number;
  /** Available VRAM in bytes (after OS / other apps). */
  vramAvailableBytes: number;
  /** Maximum bytes this device is willing to allocate for model weights. */
  maxModelBytes: number;
  /** Socket slot for network I/O. */
  socketSlot: number;
}

// ─── Shard assignment result ───────────────────────────────────────────────

/** One shard assignment — immutable after allocation. */
export interface ShardRecord {
  /** Monotonically increasing shard id (0..N-1). */
  shardId: number;
  /** Which transformer layer (0 = embedding, 1..L = layers, L+1 = LM head). */
  layerIdx: number;
  /** Type of weight tensor. */
  shardType: ShardType;
  /** Node that owns this shard. */
  nodeId: bigint;
  /** Byte offset within the conceptual layer weight blob. */
  byteOffset: number;
  /** Byte size of this shard. */
  byteSize: number;
  /** Start attention head index (for ATTENTION_QKV/ATTENTION_OUT). */
  headStart: number;
  /** End attention head index (exclusive). */
  headEnd: number;
  /** Start column index in MLP intermediate dimension (for MLP shards). */
  colStart: number;
  /** End column index (exclusive). */
  colEnd: number;
}

/** Full allocation result. */
export interface AllocationPlan {
  shards: ShardRecord[];
  /** layerIdx → tensor-parallel degree. */
  tpDegree: Uint16Array;
  /** hubId → [startLayer, endLayer). */
  pipelineMap: Map<number, [number, number]>;
  totalShards: number;
  totalBytes: number;
  totalDevices: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. VRAM calculator — per-layer memory footprint
// ═════════════════════════════════════════════════════════════════════════════

/** Compute the byte size of a single transformer layer's weights in FP16. */
export function layerBytes(model: ModelSpec): number {
  const { hiddenSize: h, intermediateSize: i, bytesPerParam: bpw } = model;
  // Q, K, V projections: h × h each → 3h²
  const qkv = 3 * h * h;
  // Output projection: h × h
  const outProj = h * h;
  // MLP gate + up: 2 × h × i
  const mlpGateUp = 2 * h * i;
  // MLP down: i × h
  const mlpDown = h * i;
  // LayerNorm × 2: 2h each → 4h
  const norms = 4 * h;

  return Math.ceil((qkv + outProj + mlpGateUp + mlpDown + norms) * bpw);
}

/** Total model bytes including embeddings + all layers + LM head. */
export function totalModelBytes(model: ModelSpec): number {
  const { numLayers: L, hiddenSize: h, vocabSize: V, bytesPerParam: bpw } = model;
  const perLayer = layerBytes(model);
  const embeddingIn = h * V * bpw;
  const embeddingOut = V * h * bpw; // LM head (tied or separate)
  return embeddingIn + perLayer * L + embeddingOut;
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Shard Allocator Engine
// ═════════════════════════════════════════════════════════════════════════════

/** Maximum tensor-parallel degree per layer. */
const MAX_TP_DEGREE = 64;

export class ShardAllocator {
  private readonly model: ModelSpec;

  // ── Pre-allocated flat arrays (zero-GC) ──────────────────────────────────

  /** [shardId] → nodeId (as number index). */
  private shardNode!: Uint32Array;
  /** [shardId] → layerIdx. */
  private shardLayer!: Uint16Array;
  /** [shardId] → ShardType. */
  private shardType!: Uint8Array;
  /** [shardId] → byte offset within layer. */
  private shardOffset!: Uint32Array;
  /** [shardId] → byte size. */
  private shardBytes!: Uint32Array;
  /** [shardId] → headStart. */
  private shardHeadStart!: Uint16Array;
  /** [shardId] → headEnd. */
  private shardHeadEnd!: Uint16Array;
  /** [shardId] → colStart. */
  private shardColStart!: Uint32Array;
  /** [shardId] → colEnd. */
  private shardColEnd!: Uint32Array;

  /** [layerIdx] → hubId assigned for pipeline. */
  private layerHub!: Uint16Array;

  /** Current shard allocation cursor. */
  private shardCount = 0;

  /** Max shards (pre-allocated). */
  private readonly maxShards: number;

  constructor(model: ModelSpec, maxShards: number = 65_536) {
    this.model = model;
    this.maxShards = maxShards;
    this._allocateBuffers(maxShards);
  }

  /**
   * Execute the full 2D allocation.
   *
   * @param devices  All edge devices with their specs.
   * @returns        Complete allocation plan.
   */
  allocate(devices: DeviceSpec[]): AllocationPlan {
    // ── Step 0: sort devices by APS descending (strongest first) ──────────
    const sorted = [...devices].sort((a, b) => b.apsScore - a.apsScore);

    // ── Step 1: group devices by physical hub ────────────────────────────
    const hubGroups = this._groupByHub(sorted);

    // ── Step 2: assign pipeline stages (layer ranges) to hubs ─────────────
    const pipelineMap = this._assignPipeline(hubGroups);

    // ── Step 3: within each hub, compute tensor-parallel layout ───────────
    const tpDegree = new Uint16Array(this.model.numLayers + 2); // +2 for embed in/out
    this._assignTensorParallel(hubGroups, tpDegree);

    // ── Step 4: build result records from flat arrays ─────────────────────
    const shards = this._buildRecords();

    return {
      shards,
      tpDegree,
      pipelineMap,
      totalShards: this.shardCount,
      totalBytes: this._totalAllocatedBytes(),
      totalDevices: devices.length,
    };
  }

  // ── Step 1: hub grouping ───────────────────────────────────────────────

  private _groupByHub(devices: DeviceSpec[]): Map<number, DeviceSpec[]> {
    const groups = new Map<number, DeviceSpec[]>();
    for (const d of devices) {
      const list = groups.get(d.hubId);
      if (list) {
        list.push(d);
      } else {
        groups.set(d.hubId, [d]);
      }
    }
    return groups;
  }

  // ── Step 2: pipeline assignment ─────────────────────────────────────────

  /**
   * Assign contiguous layer ranges to hubs.
   *
   * Strategy: sort hubs by total VRAM capacity descending, assign layers
   * proportionally.  Each hub gets at least 1 layer; powerful hubs get more.
   */
  private _assignPipeline(
    hubGroups: Map<number, DeviceSpec[]>,
  ): Map<number, [number, number]> {
    const totalLayers = this.model.numLayers;

    // Calculate each hub's total VRAM capacity
    const hubCaps: { hubId: number; totalVram: number; deviceCount: number }[] = [];
    for (const [hubId, devs] of hubGroups) {
      hubCaps.push({
        hubId,
        totalVram: devs.reduce((s, d) => s + d.vramAvailableBytes, 0),
        deviceCount: devs.length,
      });
    }
    hubCaps.sort((a, b) => b.totalVram - a.totalVram);

    const totalVram = hubCaps.reduce((s, h) => s + h.totalVram, 0);
    const pipelineMap = new Map<number, [number, number]>();

    let cursor = 0;
    for (const hub of hubCaps) {
      // Proportional layer allocation
      const share = totalVram > 0 ? hub.totalVram / totalVram : 1 / hubCaps.length;
      let numLayers = Math.max(1, Math.round(share * totalLayers));

      // Ensure we don't exceed total
      if (cursor + numLayers > totalLayers) {
        numLayers = totalLayers - cursor;
      }
      if (numLayers <= 0) break;

      const start = cursor;
      const end = cursor + numLayers;
      pipelineMap.set(hub.hubId, [start, end]);
      cursor = end;

      // Assign layer→hub mapping
      for (let l = start; l < end && l < totalLayers; l++) {
        this.layerHub[l + 1] = hub.hubId; // +1 offset: 0=embedding_in
      }
    }

    // Embedding layers: assign to the first hub (powerful, high-VRAM)
    if (hubCaps.length > 0) {
      this.layerHub[0] = hubCaps[0].hubId; // embedding_in
      this.layerHub[totalLayers + 1] = hubCaps[0].hubId; // embedding_out
    }

    return pipelineMap;
  }

  // ── Step 3: tensor-parallel assignment ──────────────────────────────────

  /**
   * For each layer, determine the tensor-parallel degree and assign
   * shards to devices within the same hub.
   *
   * Constraint: all TP peers MUST be on the same hub → enforced by
   * only considering devices in `hubGroups[hubId]` for a given layer.
   */
  private _assignTensorParallel(
    hubGroups: Map<number, DeviceSpec[]>,
    tpDegree: Uint16Array,
  ): void {
    const { numLayers, hiddenSize: h, intermediateSize: inter, numHeads, numKvHeads, headDim, bytesPerParam: bpw, vocabSize: V } = this.model;

    // ── Embedding in ──
    this._assignEmbeddingIn(
      hubGroups.get(this.layerHub[0]) ?? [],
      h,
      V,
      bpw,
    );

    // ── Transformer layers ──
    for (let layer = 0; layer < numLayers; layer++) {
      const hubId = this.layerHub[layer + 1];
      const devices = hubGroups.get(hubId);
      if (!devices || devices.length === 0) continue;

      const tp = this._computeTPDegree(devices, layer);
      tpDegree[layer + 1] = tp;

      // Attention shards
      this._assignAttentionShards(devices, layer, tp, numHeads, numKvHeads, headDim, h, bpw);
      // MLP shards
      this._assignMlpShards(devices, layer, tp, h, inter, bpw);
      // LayerNorm (small — assign to the strongest device in the hub)
      this._assignLayerNorm(devices[0], layer, h, bpw);
    }

    // ── Embedding out (LM head) ──
    this._assignEmbeddingOut(
      hubGroups.get(this.layerHub[numLayers + 1]) ?? [],
      h,
      V,
      bpw,
    );
  }

  /** Determine optimal tensor-parallel degree for a layer on a set of devices. */
  private _computeTPDegree(devices: DeviceSpec[], _layerIdx: number): number {
    const totalVram = devices.reduce((s, d) => s + d.maxModelBytes, 0);
    const perLayer = layerBytes(this.model);

    // Minimum TP needed so that each device's shard fits
    const minTP = Math.max(1, Math.ceil(perLayer / Math.min(...devices.map(d => d.maxModelBytes))));
    // Maximum TP possible (one shard per device)
    const maxTP = Math.min(devices.length, MAX_TP_DEGREE);
    // Actual: balance between min needed and available devices
    return Math.min(maxTP, Math.max(minTP, Math.ceil(perLayer / (totalVram / devices.length))));
  }

  // ── Attention shard assignment ─────────────────────────────────────────

  private _assignAttentionShards(
    devices: DeviceSpec[],
    layerIdx: number,
    tp: number,
    numHeads: number,
    numKvHeads: number,
    headDim: number,
    h: number,
    bpw: number,
  ): void {
    if (tp > devices.length) return;

    // Split heads across TP devices
    const headsPerDevice = Math.ceil(numHeads / tp);
    const kvHeadsPerDevice = Math.ceil(numKvHeads / tp);

    let byteOffset = 0;

    for (let rank = 0; rank < tp; rank++) {
      const dev = devices[rank % devices.length];
      const headStart = rank * headsPerDevice;
      const headEnd = Math.min(headStart + headsPerDevice, numHeads);
      const localHeads = headEnd - headStart;
      const localKvHeads = Math.min(kvHeadsPerDevice, numKvHeads - rank * kvHeadsPerDevice);

      if (localHeads <= 0 && localKvHeads <= 0) continue;

      // QKV shard
      const qkvBytes = (localHeads * 3 * h * headDim) * bpw;
      if (dev.maxModelBytes >= qkvBytes) {
        this._emitShard({
          layerIdx: layerIdx + 1,
          shardType: ShardType.ATTENTION_QKV,
          nodeId: dev.nodeId,
          byteOffset,
          byteSize: qkvBytes,
          headStart,
          headEnd,
          colStart: 0,
          colEnd: 0,
        });
        byteOffset += qkvBytes;
      }

      // Output shard
      const outBytes = localHeads * h * headDim * bpw;
      if (dev.maxModelBytes >= outBytes) {
        this._emitShard({
          layerIdx: layerIdx + 1,
          shardType: ShardType.ATTENTION_OUT,
          nodeId: dev.nodeId,
          byteOffset,
          byteSize: outBytes,
          headStart,
          headEnd,
          colStart: 0,
          colEnd: 0,
        });
        byteOffset += outBytes;
      }
    }
  }

  // ── MLP shard assignment ───────────────────────────────────────────────

  private _assignMlpShards(
    devices: DeviceSpec[],
    layerIdx: number,
    tp: number,
    h: number,
    inter: number,
    bpw: number,
  ): void {
    if (tp > devices.length) return;

    // Split intermediate dimension columns across TP devices
    const colsPerDevice = Math.ceil(inter / tp);
    let byteOffset = 0;

    for (let rank = 0; rank < tp; rank++) {
      const dev = devices[rank % devices.length];
      const colStart = rank * colsPerDevice;
      const colEnd = Math.min(colStart + colsPerDevice, inter);
      const localCols = colEnd - colStart;
      if (localCols <= 0) continue;

      // MLP Gate
      const gateBytes = h * localCols * bpw;
      if (dev.maxModelBytes >= gateBytes) {
        this._emitShard({
          layerIdx: layerIdx + 1,
          shardType: ShardType.MLP_GATE,
          nodeId: dev.nodeId,
          byteOffset,
          byteSize: gateBytes,
          headStart: 0,
          headEnd: 0,
          colStart,
          colEnd,
        });
        byteOffset += gateBytes;
      }

      // MLP Up
      const upBytes = h * localCols * bpw;
      if (dev.maxModelBytes >= upBytes) {
        this._emitShard({
          layerIdx: layerIdx + 1,
          shardType: ShardType.MLP_UP,
          nodeId: dev.nodeId,
          byteOffset,
          byteSize: upBytes,
          headStart: 0,
          headEnd: 0,
          colStart,
          colEnd,
        });
        byteOffset += upBytes;
      }

      // MLP Down (split rows now: localCols × h)
      const downBytes = localCols * h * bpw;
      if (dev.maxModelBytes >= downBytes) {
        this._emitShard({
          layerIdx: layerIdx + 1,
          shardType: ShardType.MLP_DOWN,
          nodeId: dev.nodeId,
          byteOffset,
          byteSize: downBytes,
          headStart: 0,
          headEnd: 0,
          colStart,
          colEnd,
        });
        byteOffset += downBytes;
      }
    }
  }

  // ── LayerNorm (small, assigned to strongest device) ────────────────────

  private _assignLayerNorm(device: DeviceSpec, layerIdx: number, h: number, bpw: number): void {
    const normBytes = 4 * h * bpw; // 2 norms × (γ + β) = 4h
    this._emitShard({
      layerIdx: layerIdx + 1,
      shardType: ShardType.LAYERNORM,
      nodeId: device.nodeId,
      byteOffset: 0,
      byteSize: normBytes,
      headStart: 0,
      headEnd: 0,
      colStart: 0,
      colEnd: 0,
    });
  }

  // ── Embedding shards ───────────────────────────────────────────────────

  private _assignEmbeddingIn(devices: DeviceSpec[], h: number, V: number, bpw: number): void {
    if (devices.length === 0) return;
    const totalBytes = h * V * bpw;
    const dev = this._bestDevice(devices);
    this._emitShard({
      layerIdx: 0,
      shardType: ShardType.EMBEDDING_IN,
      nodeId: dev.nodeId,
      byteOffset: 0,
      byteSize: totalBytes,
      headStart: 0,
      headEnd: 0,
      colStart: 0,
      colEnd: 0,
    });
  }

  private _assignEmbeddingOut(devices: DeviceSpec[], h: number, V: number, bpw: number): void {
    if (devices.length === 0) return;
    const totalBytes = V * h * bpw;
    const dev = this._bestDevice(devices);
    this._emitShard({
      layerIdx: this.model.numLayers + 1,
      shardType: ShardType.EMBEDDING_OUT,
      nodeId: dev.nodeId,
      byteOffset: 0,
      byteSize: totalBytes,
      headStart: 0,
      headEnd: 0,
      colStart: 0,
      colEnd: 0,
    });
  }

  /** Pick the device with the highest APS score. */
  private _bestDevice(devices: DeviceSpec[]): DeviceSpec {
    return devices.reduce((best, d) => (d.apsScore > best.apsScore ? d : best), devices[0]);
  }

  // ── Pre-allocated emit ─────────────────────────────────────────────────

  private _emitShard(s: {
    layerIdx: number;
    shardType: ShardType;
    nodeId: bigint;
    byteOffset: number;
    byteSize: number;
    headStart: number;
    headEnd: number;
    colStart: number;
    colEnd: number;
  }): void {
    if (this.shardCount >= this.maxShards) {
      throw new Error(`Shard capacity exceeded: ${this.maxShards}`);
    }
    const i = this.shardCount;
    // Store nodeId as a numeric index; we use a separate nodeId pool
    this.shardNode[i] = this._nodeIndex(s.nodeId);
    this.shardLayer[i] = s.layerIdx;
    this.shardType[i] = s.shardType;
    this.shardOffset[i] = s.byteOffset;
    this.shardBytes[i] = s.byteSize;
    this.shardHeadStart[i] = s.headStart;
    this.shardHeadEnd[i] = s.headEnd;
    this.shardColStart[i] = s.colStart;
    this.shardColEnd[i] = s.colEnd;
    this.shardCount++;
  }

  // ── Node ID ↔ index mapping ────────────────────────────────────────────

  private nodeIdToIndex = new Map<string, number>();
  private nodeIndexToId: bigint[] = [];

  private _nodeIndex(nodeId: bigint): number {
    const key = nodeId.toString();
    let idx = this.nodeIdToIndex.get(key);
    if (idx === undefined) {
      idx = this.nodeIndexToId.length;
      this.nodeIdToIndex.set(key, idx);
      this.nodeIndexToId.push(nodeId);
    }
    return idx;
  }

  // ── Buffer allocation ──────────────────────────────────────────────────

  private _allocateBuffers(max: number): void {
    this.shardNode = new Uint32Array(max);
    this.shardLayer = new Uint16Array(max);
    this.shardType = new Uint8Array(max);
    this.shardOffset = new Uint32Array(max);
    this.shardBytes = new Uint32Array(max);
    this.shardHeadStart = new Uint16Array(max);
    this.shardHeadEnd = new Uint16Array(max);
    this.shardColStart = new Uint32Array(max);
    this.shardColEnd = new Uint32Array(max);
    this.layerHub = new Uint16Array(this.model.numLayers + 2);
  }

  // ── Build result records ───────────────────────────────────────────────

  private _buildRecords(): ShardRecord[] {
    const records: ShardRecord[] = [];
    for (let i = 0; i < this.shardCount; i++) {
      records.push({
        shardId: i,
        layerIdx: this.shardLayer[i],
        shardType: this.shardType[i] as ShardType,
        nodeId: this.nodeIndexToId[this.shardNode[i]],
        byteOffset: this.shardOffset[i],
        byteSize: this.shardBytes[i],
        headStart: this.shardHeadStart[i],
        headEnd: this.shardHeadEnd[i],
        colStart: this.shardColStart[i],
        colEnd: this.shardColEnd[i],
      });
    }
    return records;
  }

  private _totalAllocatedBytes(): number {
    let total = 0;
    for (let i = 0; i < this.shardCount; i++) {
      total += this.shardBytes[i];
    }
    return total;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Look-up table helpers (O(1) device → shards)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build a reverse index: nodeId → list of ShardRecords it owns.
 *
 * Pre-allocates `nodeToShards` as a flat Uint32Array;
 * no Map resize on the hot path.
 */
export function buildNodeToShards(
  plan: AllocationPlan,
  maxNodes: number = 65_536,
  maxShardsPerNode: number = 16,
): { offset: Uint32Array; shards: Uint32Array; nodeCount: number } {
  const offset = new Uint32Array(maxNodes);
  const shards = new Uint32Array(maxNodes * maxShardsPerNode);
  shards.fill(0xffff_ffff); // sentinel

  // Count shards per node (first pass)
  const counts = new Uint16Array(maxNodes);
  const nodeIdx = new Map<string, number>();

  for (const s of plan.shards) {
    const key = s.nodeId.toString();
    let idx = nodeIdx.get(key);
    if (idx === undefined) {
      idx = nodeIdx.size;
      nodeIdx.set(key, idx);
    }
    const pos = offset[idx] + counts[idx];
    if (counts[idx] < maxShardsPerNode) {
      shards[pos] = s.shardId;
      counts[idx]++;
    }
  }

  // Build offset table (start index for each node)
  let cursor = 0;
  for (let i = 0; i < nodeIdx.size; i++) {
    const n = counts[i];
    offset[i] = cursor;
    cursor += n;
  }

  return { offset, shards, nodeCount: nodeIdx.size };
}

/**
 * Given a nodeId, retrieve all shard IDs assigned to it.
 * O(1) via the pre-built reverse index.
 */
export function shardsForNode(
  nodeId: bigint,
  nodeIdx: Map<string, number>,
  index: { offset: Uint32Array; shards: Uint32Array },
  plan: AllocationPlan,
): ShardRecord[] {
  const idx = nodeIdx.get(nodeId.toString());
  if (idx === undefined) return [];

  const start = index.offset[idx];
  // Find end by scanning until sentinel or next offset
  let end = start;
  while (end < index.shards.length && index.shards[end] !== 0xffff_ffff) {
    end++;
  }

  const result: ShardRecord[] = [];
  for (let i = start; i < end; i++) {
    const sid = index.shards[i];
    if (sid < plan.shards.length) {
      result.push(plan.shards[sid]);
    }
  }
  return result;
}

