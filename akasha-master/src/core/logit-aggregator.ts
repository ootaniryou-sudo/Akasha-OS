/**
 * akasha-logit-aggregator.ts
 *
 * Akasha OS — Hierarchical Logit Tournament Engine
 * ────────────────────────────────────────────────
 * Aggregates top-5 token predictions from thousands of edge devices through
 * a two-level reduction tree (hub-leader → master).  Eliminates the O(N)
 * bandwidth explosion of sending full 32,000-dimension logit vectors to the
 * master by compressing each result into a fixed 36-byte binary packet.
 *
 * ## Algorithm (two-level reduction)
 *
 *   Level 1 — Hub Ensemble:
 *     N edge devices per hub → hub leader merges N × top-5 → 1 refined top-5
 *     Complexity: O(N × 5 log 5) per hub,  O(5) scratch buffer
 *     Traffic:    N × 36 B → 36 B  (reduction factor: N)
 *
 *   Level 2 — Master Tournament:
 *     H hub leaders → master merges H × top-5 → final token via temp/Top-P
 *     Complexity: O(H × 5 log 5),  O(H × 5) scratch buffer
 *     Traffic:    H × 36 B  (flat, independent of total device count)
 *
 * ## Top-5 Binary Packet Format (36 bytes total)
 *
 *   Offset Size  Type     Field
 *   ────── ───── ──────── ─────────────────
 *    0      8    u64 LE   txId        (transaction id)
 *    8      8    u64 LE   nodeId      (edge device id)
 *   16     10    u16×5 LE tokenIds[5] (top-5 token ids)
 *   26     10    u16×5 LE scores[5]   (fp32 → u16 quantised: score×65535 as u16)
 *   ────── ─────          Total: 36 bytes
 *
 * ## Token ID / Score merge (zero-allocation)
 *
 *   A single pre-allocated Uint32Array (`mergeScratch`) is used as a
 *   hash-map substitute: index = tokenId, value = merged score (u32 fixed-point).
 *   No Map, no Object, no Array.push, no concat — pure typed-array index
 *   arithmetic.  The scratch buffer is zeroed in O(K) after each merge pass
 *   where K = number of touched token slots (≤ N×5, cheap memset-style loop).
 */

// nowUs available from '../binary/protocol.js' if timestamp injection is needed

// ─── Constants ─────────────────────────────────────────────────────────────

/** Number of top token candidates each edge device reports. */
export const TOP_K = 5;

/** Byte layout of a Top-K logit packet. */
export const TOPK_PACKET_BYTES = 36; // 8(txId)+8(nodeId)+10(ids)+10(scores)

/** Maximum vocab size supported by the scratch buffer. Adjust for your model. */
const MAX_VOCAB_SIZE = 128_000; // Llama-3 class vocabulary

/** Quantisation multiplier: fp32 score [0,1] → u16 score [0,65535]. */
const SCORE_QUANT = 65535;

// ─── Types ─────────────────────────────────────────────────────────────────

/** One token candidate with its probability score. */
export interface TokenCandidate {
  tokenId: number;
  /** Probability in [0, 1] (not logit).  Aggregated by averaging. */
  score: number;
}

/** A decoded Top-5 logit packet. */
export interface TopKPacket {
  txId: bigint;
  nodeId: bigint;
  candidates: [TokenCandidate, TokenCandidate, TokenCandidate, TokenCandidate, TokenCandidate];
  /** Number of valid candidates (≤ 5). */
  count: number;
}

/** Aggregation result from a hub leader. */
export interface HubAggregation {
  hubId: number;
  refined: TokenCandidate[];
  nodeCount: number;
  totalLatencyUs: number;
}

/** Final sampling configuration. */
export interface SamplingConfig {
  /** Temperature: > 0.  Higher = more random.  1.0 = neutral. */
  temperature: number;
  /** Top-P (nucleus): keep tokens until cumulative prob ≥ topP.  1.0 = all. */
  topP: number;
  /** Random seed for reproducible sampling (optional). */
  seed?: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Top-K Binary Packet Codec
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Encode a Top-5 prediction into a 36-byte binary packet.
 *
 * @param txId     Transaction ID.
 * @param nodeId   Edge device ID.
 * @param candidates  Top-5 token candidates (will be truncated to 5).
 * @param dst      Destination buffer (must be ≥ 36 bytes).
 * @returns        Number of bytes written (always 36).
 */
export function encodeTopKPacket(
  txId: bigint,
  nodeId: bigint,
  candidates: TokenCandidate[],
  dst: Uint8Array,
): number {
  const dv = new DataView(dst.buffer, dst.byteOffset, TOPK_PACKET_BYTES);
  dv.setBigUint64(0, txId, true);
  dv.setBigUint64(8, nodeId, true);

  const n = Math.min(candidates.length, TOP_K);
  for (let i = 0; i < TOP_K; i++) {
    if (i < n) {
      dv.setUint16(16 + i * 2, candidates[i].tokenId & 0xffff, true);
      // Quantise fp32 score → u16
      const q = Math.min(65535, Math.max(0, Math.round(candidates[i].score * SCORE_QUANT)));
      dv.setUint16(26 + i * 2, q, true);
    } else {
      dv.setUint16(16 + i * 2, 0, true);
      dv.setUint16(26 + i * 2, 0, true);
    }
  }

  return TOPK_PACKET_BYTES;
}

/**
 * Decode a Top-5 binary packet.
 *
 * @param src   Raw bytes (must be ≥ 36 bytes).
 * @returns     Decoded packet with up to 5 candidates.
 */
export function decodeTopKPacket(src: Uint8Array): TopKPacket {
  const dv = new DataView(src.buffer, src.byteOffset, TOPK_PACKET_BYTES);
  const txId = dv.getBigUint64(0, true);
  const nodeId = dv.getBigUint64(8, true);

  const candidates: TopKPacket['candidates'] = [
    { tokenId: 0, score: 0 },
    { tokenId: 0, score: 0 },
    { tokenId: 0, score: 0 },
    { tokenId: 0, score: 0 },
    { tokenId: 0, score: 0 },
  ];
  let count = 0;

  for (let i = 0; i < TOP_K; i++) {
    const tid = dv.getUint16(16 + i * 2, true);
    const q = dv.getUint16(26 + i * 2, true);
    if (tid === 0 && q === 0) continue; // empty slot
    candidates[i] = {
      tokenId: tid,
      score: q / SCORE_QUANT,
    };
    count++;
  }

  return { txId, nodeId, candidates, count };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Hub-Leader Local Ensemble (Level-1 Reduction)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Hub-leader aggregator.
 *
 * Each hub (subnet) has one `HubAggregator` instance.  Edge devices on the
 * same physical switch send their Top-5 packets here.  The aggregator merges
 * them into a single refined Top-5 that represents the hub's collective
 * prediction.
 *
 * ## Zero-allocation guarantee
 *
 * A single `Uint32Array` scratch buffer (size = MAX_VOCAB_SIZE) is
 * pre-allocated in the constructor.  All merge operations write into
 * this same buffer via index arithmetic — no `Map`, no `Array.push`,
 * no temporary objects.
 */
export class HubAggregator {
  readonly hubId: number;

  /**
   * Scratch buffer for merging scores.
   * `scratch[tokenId]` stores the accumulated score as a u32 fixed-point
   * (score × 2^24).  This allows summing up to ~255 nodes without overflow.
   *
   * Dirty slots are tracked in `dirtyList` and zeroed after each merge.
   */
  private readonly scratch: Uint32Array;
  private readonly dirtyList: Uint32Array;
  private dirtyCount = 0;

  /** Refined top-5 buffer (reused every merge). */
  private readonly refined: TokenCandidate[] = [
    { tokenId: 0, score: 0 },
    { tokenId: 0, score: 0 },
    { tokenId: 0, score: 0 },
    { tokenId: 0, score: 0 },
    { tokenId: 0, score: 0 },
  ];

  private nodeCount = 0;
  private totalLatencyUs = 0;

  constructor(hubId: number) {
    this.hubId = hubId;
    // Single allocation: vocab-sized score accumulator
    this.scratch = new Uint32Array(MAX_VOCAB_SIZE);
    this.dirtyList = new Uint32Array(TOP_K * 256); // max 256 nodes per hub
  }

  /**
   * Ingest one edge device's Top-5 prediction.
   *
   * O(5) — writes into the scratch buffer, no heap allocation.
   */
  ingest(packet: TopKPacket, rttUs: number): void {
    for (let i = 0; i < packet.count; i++) {
      const c = packet.candidates[i];
      const tid = c.tokenId;
      if (tid >= MAX_VOCAB_SIZE) continue;

      // First time touching this slot → record for later zeroing
      if (this.scratch[tid] === 0) {
        this.dirtyList[this.dirtyCount] = tid;
        this.dirtyCount++;
      }

      // Accumulate: score × 2^24 (24 bits of fixed-point precision)
      const fixed = Math.round(c.score * 0x100_0000); // 2^24 = 16,777,216
      this.scratch[tid] += fixed;
    }
    this.nodeCount++;
    this.totalLatencyUs += rttUs;
  }

  /**
   * Compute the hub's refined Top-5 from all ingested predictions.
   *
   * O(K + 5) where K = number of distinct token IDs seen.
   * The scratch buffer is zeroed in-place after reading.
   *
   * @returns Sorted TokenCandidate[] (length ≤ 5, descending score).
   */
  refine(): TokenCandidate[] {
    if (this.nodeCount === 0) return [];

    const invN = 1.0 / this.nodeCount;

    // Reset refined buffer
    for (let i = 0; i < TOP_K; i++) {
      this.refined[i].tokenId = 0;
      this.refined[i].score = 0;
    }

    // Scan all dirty slots → insert into top-5 (insertion sort over 5 elements)
    for (let i = 0; i < this.dirtyCount; i++) {
      const tid = this.dirtyList[i];
      const accumulated = this.scratch[tid];
      if (accumulated === 0) continue;

      const avgScore = (accumulated * invN) / 0x100_0000; // dequantise + average

      // Insert into refined top-5 (descending, O(5) per element)
      let insertIdx = TOP_K;
      for (let j = 0; j < TOP_K; j++) {
        if (avgScore > this.refined[j].score) {
          insertIdx = j;
          break;
        }
      }
      if (insertIdx < TOP_K) {
        // Shift down
        for (let j = TOP_K - 1; j > insertIdx; j--) {
          this.refined[j] = this.refined[j - 1];
        }
        this.refined[insertIdx] = { tokenId: tid, score: avgScore };
      }
    }

    // Zero-out scratch buffer (only dirty slots — O(K), not O(vocab))
    for (let i = 0; i < this.dirtyCount; i++) {
      this.scratch[this.dirtyList[i]] = 0;
    }

    const result = this.refined.filter((c) => c.score > 0);
    this.nodeCount = 0;
    this.totalLatencyUs = 0;
    this.dirtyCount = 0;

    return result;
  }

  /** Number of nodes ingested since last refine. */
  get pendingNodeCount(): number {
    return this.nodeCount;
  }

  /** Average RTT of ingested nodes (μs). */
  get averageLatencyUs(): number {
    return this.nodeCount > 0 ? Math.round(this.totalLatencyUs / this.nodeCount) : 0;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Master Final Sampler (Temperature + Top-P)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Master-level token aggregator + sampler.
 *
 * Collects refined Top-5 packets from all hub leaders, merges them into
 * a single probability distribution, then applies Temperature scaling
 * and Top-P (nucleus) sampling to produce the final token.
 */
export class MasterSampler {
  private readonly scratch: Float64Array; // full vocab probs for sampling
  private readonly dirtyList: Uint32Array;
  private dirtyCount = 0;

  /** Merged candidate list (temporary, reused). */
  private merged: TokenCandidate[] = [];

  constructor() {
    this.scratch = new Float64Array(MAX_VOCAB_SIZE);
    // Worst case: all hub leaders contribute distinct tokens
    this.dirtyList = new Uint32Array(MAX_VOCAB_SIZE);
  }

  /**
   * Ingest hub refinements.
   *
   * Each hub contributes its refined Top-5.  Candidates with the same
   * tokenId are summed (ensemble voting).
   */
  ingestHub(hubResult: HubAggregation): void {
    for (const c of hubResult.refined) {
      const tid = c.tokenId;
      if (tid >= MAX_VOCAB_SIZE) continue;

      if (this.scratch[tid] === 0) {
        this.dirtyList[this.dirtyCount] = tid;
        this.dirtyCount++;
      }
      // Average across hubs: sum scores
      this.scratch[tid] += c.score;
    }
  }

  /**
   * Sample the final token given Temperature and Top-P constraints.
   *
   * Algorithm:
   * 1. Gather all candidate scores from scratch.
   * 2. Apply temperature: score' = score^(1/T).
   * 3. Sort descending.
   * 4. Truncate to Top-P cumulative mass.
   * 5. Re-normalise.
   * 6. Multinomial sample.
   *
   * @returns The sampled token ID.
   */
  sample(config: SamplingConfig): number {
    const { temperature, topP, seed } = config;
    const T = Math.max(temperature, 0.01); // prevent division by zero

    // 1. Gather → merged list (O(K))
    this.merged = [];
    for (let i = 0; i < this.dirtyCount; i++) {
      const tid = this.dirtyList[i];
      const score = this.scratch[tid];
      if (score <= 0) continue;
      this.merged.push({ tokenId: tid, score });
    }

    if (this.merged.length === 0) {
      this._cleanup();
      return 0; // fallback: <unk> token
    }

    // 2. Apply temperature: scale log-prob space
    //    p_new = exp(log(p_old) / T)  →  p_old^(1/T)
    for (const c of this.merged) {
      c.score = Math.pow(Math.max(c.score, 1e-12), 1.0 / T);
    }

    // 3. Sort descending by score
    this.merged.sort((a, b) => b.score - a.score);

    // 4. Top-P truncation: keep until cumulative mass ≥ topP
    let totalMass = 0;
    for (const c of this.merged) {
      totalMass += c.score;
    }

    if (totalMass <= 0) {
      this._cleanup();
      return this.merged[0]?.tokenId ?? 0;
    }

    // Normalise + cumulative → find Top-P cutoff
    const cutoffIdx = this._topPIndex(this.merged, totalMass, topP);

    // 5. Re-normalise within Top-P set
    const kept = this.merged.slice(0, cutoffIdx + 1);
    let keptMass = 0;
    for (const c of kept) keptMass += c.score;

    // 6. Multinomial sample
    const rng: () => number = seed !== undefined ? this._seededRandom(seed) : Math.random;
    let dart = rng() * keptMass;
    let sampled = kept[0]?.tokenId ?? 0;

    for (const c of kept) {
      dart -= c.score;
      if (dart <= 0) {
        sampled = c.tokenId;
        break;
      }
    }

    this._cleanup();
    return sampled;
  }

  /**
   * Merge all hub refinements and get the full candidate list
   * (without sampling — useful for debugging / streaming logprobs).
   */
  getCandidates(): TokenCandidate[] {
    const result: TokenCandidate[] = [];
    for (let i = 0; i < this.dirtyCount; i++) {
      const tid = this.dirtyList[i];
      const score = this.scratch[tid];
      if (score > 0) result.push({ tokenId: tid, score });
    }
    result.sort((a, b) => b.score - a.score);
    return result;
  }

  /** Reset internal state for the next token. */
  reset(): void {
    this._cleanup();
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private _topPIndex(sorted: TokenCandidate[], totalMass: number, topP: number): number {
    let cum = 0;
    const threshold = totalMass * Math.min(topP, 1.0);
    for (let i = 0; i < sorted.length; i++) {
      cum += sorted[i].score;
      if (cum >= threshold) return i;
    }
    return sorted.length - 1;
  }

  private _cleanup(): void {
    for (let i = 0; i < this.dirtyCount; i++) {
      this.scratch[this.dirtyList[i]] = 0;
    }
    this.dirtyCount = 0;
    this.merged = [];
  }

  /** Simple deterministic PRNG (mulberry32) for reproducible sampling. */
  private _seededRandom(seed: number): () => number {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Top-Level Tournament Orchestrator
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Full two-level logit tournament.
 *
 * Usage per token step:
 *
 * ```ts
 * const tournament = new LogitTournament(hubIds);
 *
 * // Level 1: feed edge packets into their respective hub leaders
 * for (const packet of edgePackets) {
 *   tournament.feedEdge(packet.hubId, packet.topK, packet.rttUs);
 * }
 *
 * // Level 2: refine hubs → feed master → sample
 * const tokenId = tournament.finalise({ temperature: 0.8, topP: 0.9 });
 * ```
 */
export class LogitTournament {
  private readonly hubs: Map<number, HubAggregator>;
  private readonly master: MasterSampler;

  constructor(hubIds: number[]) {
    this.hubs = new Map();
    for (const id of hubIds) {
      this.hubs.set(id, new HubAggregator(id));
    }
    this.master = new MasterSampler();
  }

  /**
   * Feed one edge device's Top-5 prediction into its hub leader.
   * O(5) — zero allocation.
   */
  feedEdge(hubId: number, packet: TopKPacket, rttUs: number): void {
    const hub = this.hubs.get(hubId);
    if (!hub) {
      // Auto-register unknown hubs (hot-plug)
      const newHub = new HubAggregator(hubId);
      this.hubs.set(hubId, newHub);
      newHub.ingest(packet, rttUs);
      return;
    }
    hub.ingest(packet, rttUs);
  }

  /**
   * Feed a raw binary Top-K packet into its hub leader.
   * Parses the binary inline, then delegates to `feedEdge`.
   */
  feedEdgeRaw(hubId: number, rawPacket: Uint8Array, rttUs: number): void {
    const packet = decodeTopKPacket(rawPacket);
    this.feedEdge(hubId, packet, rttUs);
  }

  /**
   * Execute the full two-level reduction:
   * 1. Each hub leader refines its local ensemble.
   * 2. Master merges hub refinements.
   * 3. Master samples final token.
   *
   * @returns The sampled token ID.
   */
  finalise(config: SamplingConfig): number {
    this.master.reset();

    // Level 1 → 2: refine each hub, feed to master
    for (const hub of this.hubs.values()) {
      const refined = hub.refine();
      if (refined.length === 0) continue;

      this.master.ingestHub({
        hubId: hub.hubId,
        refined,
        nodeCount: hub.pendingNodeCount,
        totalLatencyUs: hub.averageLatencyUs,
      });
    }

    return this.master.sample(config);
  }

  /** Get all hub aggregators for inspection. */
  getHubs(): ReadonlyMap<number, HubAggregator> {
    return this.hubs;
  }

  /** Get the master sampler for direct access. */
  getMaster(): MasterSampler {
    return this.master;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Utility: fast top-5 extraction from a Float32Array logits vector
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Extract top-5 token IDs and their softmax probabilities from a raw logits
 * vector.  This runs on the EDGE device before sending the Top-K packet.
 *
 * O(vocab_size + 5) — single scan with 5-element insertion buffer.
 *
 * @param logits  Raw logits (unnormalised) of shape [vocabSize].
 * @returns       Top-5 TokenCandidates with softmax probabilities.
 */
export function extractTop5(logits: Float32Array): TokenCandidate[] {
  const top5: TokenCandidate[] = [
    { tokenId: 0, score: -Infinity },
    { tokenId: 0, score: -Infinity },
    { tokenId: 0, score: -Infinity },
    { tokenId: 0, score: -Infinity },
    { tokenId: 0, score: -Infinity },
  ];

  // Find max for numerical stability
  let maxLogit = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > maxLogit) maxLogit = logits[i];
  }

  // Softmax denominator + top-5 extraction in a single pass
  let denom = 0.0;
  for (let i = 0; i < logits.length; i++) {
    const prob = Math.exp(logits[i] - maxLogit);
    denom += prob;

    // Insert into top-5 (descending by logit)
    const score = logits[i]; // use raw logit for ranking
    let insertIdx = 5;
    for (let j = 0; j < 5; j++) {
      if (score > top5[j].score) {
        insertIdx = j;
        break;
      }
    }
    if (insertIdx < 5) {
      for (let j = 4; j > insertIdx; j--) {
        top5[j] = top5[j - 1];
      }
      top5[insertIdx] = { tokenId: i, score: prob };
    }
  }

  // Normalise probabilities
  const invDenom = 1.0 / Math.max(denom, 1e-12);
  for (const c of top5) {
    c.score *= invDenom;
  }

  return top5.filter((c) => c.score > 0);
}

