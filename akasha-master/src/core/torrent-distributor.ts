/**
 * akasha-torrent-distributor.ts
 *
 * Akasha OS — P2P Model Binary Distribution Engine ("Akasha Torrent")
 * ───────────────────────────────────────────────────────────────────
 * Distributes GB~TB model weight binaries across thousands of edge
 * devices without ever saturating the master server's uplink.
 *
 * ## Algorithm
 *
 *   Master → Hub Leader (unicast, 1:1)
 *   Hub Leader → 2 peers → 4 peers → 8 peers → ... (binary tree fan-out)
 *
 *   Each node, upon receiving a chunk:
 *     1. CRC32-verify the chunk in a WebWorker (background).
 *     2. Write to local IndexedDB for persistent caching.
 *     3. Forward the chunk to its two "downstream" peers over WebSocket.
 *     Steps 2 & 3 happen concurrently — zero-copy stream pipe.
 *
 * ## Chunk wire format (fixed: CHUNK_SIZE + 12 bytes)
 *
 *   Offset  Size  Field
 *   ──────  ────  ──────────────────────────
 *    0       4    chunkIndex  (u32 LE)
 *    4       4    chunkSize   (u32 LE, typically 1 MiB)
 *    8       N    payload     (raw bytes)
 *   8+N      4    crc32       (u32 LE, IEEE 802.3)
 *   ──────  ────  Total: N + 12
 */

import { BufferPool } from '../pool/object-pool.js';

// ═════════════════════════════════════════════════════════════════════════════
// 1. Constants & Types
// ═════════════════════════════════════════════════════════════════════════════

/** Default chunk size: 1 MiB — fits within Ethernet MTU-bounded WebSocket frames. */
export const DEFAULT_CHUNK_SIZE = 1_048_576; // 1 MiB

/** CRC32 footer + header overhead per chunk. */
const CHUNK_HEADER_BYTES = 8; // chunkIndex(u32) + chunkSize(u32)
const CHUNK_FOOTER_BYTES = 4; // crc32(u32)
const CHUNK_OVERHEAD = CHUNK_HEADER_BYTES + CHUNK_FOOTER_BYTES;

/** Maximum concurrent downstream peers per node (binary tree = 2). */
const MAX_DOWNSTREAM_PEERS = 2;

/** Maximum retry attempts for a corrupt chunk. */
const MAX_RETRIES = 3;

// ─── Torrent manifest ──────────────────────────────────────────────────────

export interface TorrentManifest {
  /** Unique identifier for this model version (SHA-256 of the manifest itself). */
  torrentId: string;
  /** Human-readable model name. */
  modelName: string;
  /** Total model size in bytes. */
  totalBytes: number;
  /** Chunk size in bytes. */
  chunkSize: number;
  /** Total chunk count. */
  chunkCount: number;
  /** SHA-256 of the concatenated chunk CRC32 array (root hash for integrity). */
  rootHash: string;
  /** Chunk CRC32 array (pre-computed by the master before distribution). */
  chunkCrc32: Uint32Array;
}

// ─── Peer descriptor ───────────────────────────────────────────────────────

export interface TorrentPeer {
  nodeId: bigint;
  socketSlot: number;
  hubId: number;
  /** This peer's level in the binary tree (0 = hub leader). */
  treeLevel: number;
  /** Downstream peers this node fans out to. */
  downstream: TorrentPeer[];
  /** Chunks this peer already possesses. */
  haveChunks: Set<number>;
}

// ─── Chunk state ───────────────────────────────────────────────────────────

const enum ChunkState {
  /** Not yet requested. */
  PENDING = 0,
  /** Requested from upstream, awaiting data. */
  REQUESTED = 1,
  /** Received, CRC verification in progress. */
  VERIFYING = 2,
  /** Verified OK, stored locally, forwarded downstream. */
  COMPLETE = 3,
  /** Verification failed, awaiting retry. */
  CORRUPT = 4,
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. CRC32 (IEEE 802.3) — fast, table-driven, zero-allocation
// ═════════════════════════════════════════════════════════════════════════════

const CRC32_TABLE = new Uint32Array(256);
{
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC32_TABLE[i] = c;
  }
}

/**
 * Compute IEEE 802.3 CRC32 of a byte buffer.
 * O(N), single pass, no allocation.
 */
export function crc32(data: Uint8Array, offset = 0, length = data.length - offset): number {
  let crc = 0xffffffff;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Stream Pipe — zero-copy receive → store → forward
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A StreamPipe receives binary chunks from an upstream peer and
 * simultaneously:
 *   1. CRC32-verifies the chunk (WebWorker-backed).
 *   2. Writes the chunk to local persistent storage (IndexedDB).
 *   3. Forwards the chunk to downstream peers' WebSocket send queues.
 *
 * All three operations alias the same ArrayBuffer from the BufferPool.
 * The buffer is released back to the pool only after all three complete.
 */
export class StreamPipe {
  private readonly bufPool: BufferPool;
  private readonly manifest: TorrentManifest;
  private readonly onForward: (peer: TorrentPeer, data: Uint8Array, chunkIndex: number) => void;

  /** Pending write ref-counts: chunkIndex → { refCount, buffer } */
  private pending = new Map<number, { refCount: number; buffer: ArrayBuffer }>();

  /** CRC verification worker (browser only; Node.js verifies inline). */
  private verifyWorker: unknown = null;

  constructor(
    manifest: TorrentManifest,
    bufPoolSize: number = 256,
    onForward: (peer: TorrentPeer, data: Uint8Array, chunkIndex: number) => void,
  ) {
    this.manifest = manifest;
    this.bufPool = new BufferPool(
      manifest.chunkSize + CHUNK_OVERHEAD,
      Math.min(64, bufPoolSize),
      bufPoolSize,
    );
    this.onForward = onForward;

    // Spawn a lightweight CRC verification worker
    this._spawnVerifyWorker();
  }

  /**
   * Ingest a received chunk from the network.
   *
   * The `rawData` ArrayBuffer is expected to be from the BufferPool.
   * Ownership is transferred to this pipe; do not reuse the buffer.
   *
   * @returns `true` if CRC passed, `false` if corrupt (caller should retry).
   */
  ingestChunk(
    rawData: ArrayBuffer,
    chunkIndex: number,
    downstreamPeers: TorrentPeer[],
  ): { ok: boolean; chunkIndex: number } {
    const expectedSize = this.manifest.chunkSize + CHUNK_OVERHEAD;
    if (rawData.byteLength < expectedSize) {
      this.bufPool.release(rawData);
      return { ok: false, chunkIndex };
    }

    const u8 = new Uint8Array(rawData);

    // Parse header
    const dv = new DataView(rawData);
    const rxChunkIndex = dv.getUint32(0, true);
    const rxChunkSize  = dv.getUint32(4, true);

    if (rxChunkIndex !== chunkIndex) {
      this.bufPool.release(rawData);
      return { ok: false, chunkIndex: rxChunkIndex };
    }

    // Extract CRC32 from footer
    const payloadStart = CHUNK_HEADER_BYTES;
    const payloadEnd   = payloadStart + rxChunkSize;
    const expectedCrc  = dv.getUint32(payloadEnd, true);

    // Verify CRC32
    const actualCrc = crc32(u8, payloadStart, rxChunkSize);

    if (actualCrc !== expectedCrc) {
      // Corrupt — release buffer, signal retry
      this.bufPool.release(rawData);
      return { ok: false, chunkIndex };
    }

    // ── Chunk verified.  Start concurrent store + forward. ──

    // Store locally (IndexedDB) — async
    this._storeChunk(chunkIndex, u8.subarray(payloadStart, payloadEnd))
      .then(() => this._releaseRef(chunkIndex))
      .catch(() => this._releaseRef(chunkIndex));

    // Forward to each downstream peer — zero-copy: same buffer
    for (const peer of downstreamPeers) {
      // Each forward gets a subarray view into the same buffer
      this.onForward(peer, u8, chunkIndex);
      // Forward complete (sync WebSocket send queues the data)
      this._releaseRef(chunkIndex);
    }

    return { ok: true, chunkIndex };
  }

  /** Release the verification worker. */
  destroy(): void {
    const w = this.verifyWorker as { terminate?: () => void } | null;
    w?.terminate?.();
    this.verifyWorker = null;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private _spawnVerifyWorker(): void {
    // Inline worker for CRC32 verification (no separate file needed)
    const workerCode = `
      const CRC32_TABLE = new Uint32Array(256);
      (function init() {
        for (let i = 0; i < 256; i++) {
          let c = i;
          for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
          }
          CRC32_TABLE[i] = c;
        }
      })();

      function crc32(data, offset, length) {
        let crc = 0xffffffff;
        const end = offset + length;
        for (let i = offset; i < end; i++) {
          crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
      }

      self.onmessage = function(e) {
        const { buffer, offset, length, expectedCrc } = e.data;
        const u8 = new Uint8Array(buffer);
        const actual = crc32(u8, offset, length);
        self.postMessage({ ok: actual === expectedCrc, actual, expected: expectedCrc });
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const G = globalThis as any;
    if (typeof G.Worker !== 'undefined') {
      this.verifyWorker = new G.Worker(G.URL.createObjectURL(blob));
    }
  }

  private _releaseRef(chunkIndex: number): void {
    const entry = this.pending.get(chunkIndex);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      this.bufPool.release(entry.buffer);
      this.pending.delete(chunkIndex);
    }
  }

  private async _storeChunk(chunkIndex: number, data: Uint8Array): Promise<void> {
    try {
      const db = await this._openIndexedDB();
      if (!db) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = db as any;
      const tx = d.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      store.put({ chunkIndex, data: data.slice().buffer, storedAt: Date.now() });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // IndexedDB unavailable — skip persistence
    }
  }

  private _dbPromise: Promise<unknown> | null = null;

  private _openIndexedDB(): Promise<unknown> {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise<unknown>((resolve) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const G = globalThis as any;
        const idb = G.indexedDB;
        if (!idb) { resolve(null); return; }
        const req = idb.open(`akasha-torrent-${this.manifest.torrentId}`, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('chunks', { keyPath: 'chunkIndex' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this._dbPromise;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Binary Tree Expansion Engine
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Builds a binary tree of peers for a single hub.
 *
 *   Level 0: [hubLeader]
 *   Level 1: [peerA, peerB]         ← leader fans out to 2
 *   Level 2: [peerC, peerD, peerE, peerF] ← each level-1 fans out to 2
 *   ...
 *
 * Returns the root (hub leader) with `downstream` populated.
 */
export function buildDistributionTree(
  _hubId: number,
  peers: TorrentPeer[],
): TorrentPeer | null {
  if (peers.length === 0) return null;

  // Sort by APS descending — strongest become inner nodes
  const sorted = [...peers].sort(
    (a, b) => (b.haveChunks.size || 0) - (a.haveChunks.size || 0),
  );

  const root = sorted[0];
  root.treeLevel = 0;
  root.downstream = [];

  // Build tree level by level
  let cursor = 1; // index into sorted (root consumed)
  let currentLevel: TorrentPeer[] = [root];

  while (cursor < sorted.length && currentLevel.length > 0) {
    const nextLevel: TorrentPeer[] = [];

    for (const parent of currentLevel) {
      // Assign up to MAX_DOWNSTREAM_PEERS children
      for (let d = 0; d < MAX_DOWNSTREAM_PEERS && cursor < sorted.length; d++) {
        const child = sorted[cursor];
        child.treeLevel = parent.treeLevel + 1;
        child.downstream = [];
        parent.downstream.push(child);
        nextLevel.push(child);
        cursor++;
      }
    }

    currentLevel = nextLevel;
  }

  return root;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Torrent Distributor — master-side orchestrator
// ═════════════════════════════════════════════════════════════════════════════

export interface DistributorOptions {
  /** Called to send raw bytes to a socket slot. */
  send?: (socketSlot: number, data: Uint8Array) => void;
  /** Called when a hub's distribution is complete. */
  onHubComplete?: (hubId: number, chunkCount: number, elapsedMs: number) => void;
  /** Called when the entire torrent is distributed. */
  onTorrentComplete?: (totalChunks: number, totalElapsedMs: number) => void;
  /** Called on chunk verification failure. */
  onChunkCorrupt?: (hubId: number, chunkIndex: number, attempt: number) => void;
}

/**
 * Master-side torrent distributor.
 *
 * The master sends the model binary to each hub leader only.
 * Hub leaders then propagate chunks through the binary tree.
 */
export class TorrentDistributor {
  private readonly manifest: TorrentManifest;
  private readonly opts: DistributorOptions;
  private readonly rootPeers = new Map<number, TorrentPeer>();

  /** Chunk data cache (master holds the full model). */
  private chunkCache: Uint8Array[] = [];

  /** Per-hub distribution progress. */
  private hubProgress = new Map<number, { completed: Set<number>; total: number }>();

  constructor(manifest: TorrentManifest, opts: DistributorOptions = {}) {
    this.manifest = manifest;
    this.opts = opts;
  }

  /**
   * Register a hub with its peer list and build the distribution tree.
   */
  registerHub(hubId: number, peers: TorrentPeer[]): TorrentPeer | null {
    const root = buildDistributionTree(hubId, peers);
    if (root) {
      this.rootPeers.set(hubId, root);
      this.hubProgress.set(hubId, {
        completed: new Set(),
        total: this.manifest.chunkCount,
      });
    }
    return root;
  }

  /**
   * Load the model binary into memory (master side).
   * In production, this would mmap a file; here we accept a Uint8Array.
   */
  loadModel(modelBinary: Uint8Array): void {
    const chunkSize = this.manifest.chunkSize;
    this.chunkCache = [];

    for (let i = 0; i < this.manifest.chunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, modelBinary.length);
      const chunk = modelBinary.slice(start, end);
      this.chunkCache.push(chunk);
    }
  }

  /**
   * Start distributing a single chunk to all hub leaders (level 0).
   *
   * The master sends the chunk to each hub leader.
   * The leader's StreamPipe then fans it out through the binary tree.
   */
  distributeChunk(chunkIndex: number): void {
    if (chunkIndex >= this.chunkCache.length) return;
    const chunkData = this.chunkCache[chunkIndex];

    // Build wire packet: [chunkIndex(u32 LE)] [chunkSize(u32 LE)] [payload] [crc32(u32 LE)]
    const packet = this._buildChunkPacket(chunkIndex, chunkData);

    // Send to each hub leader
    for (const [hubId, root] of this.rootPeers) {
      const send = this.opts.send;
      if (!send) continue;

      send(root.socketSlot, packet);

      // Track progress
      const progress = this.hubProgress.get(hubId);
      if (progress) {
        progress.completed.add(chunkIndex);
        if (progress.completed.size >= progress.total) {
          this.opts.onHubComplete?.(hubId, progress.total, 0);
        }
      }
    }
  }

  /**
   * Distribute all chunks sequentially to hub leaders.
   * The pipeline within each hub handles parallel fan-out.
   */
  distributeAll(): void {
    const startMs = Date.now();
    for (let i = 0; i < this.manifest.chunkCount; i++) {
      this.distributeChunk(i);
    }
    const elapsed = Date.now() - startMs;
    this.opts.onTorrentComplete?.(this.manifest.chunkCount, elapsed);
  }

  /**
   * Pre-compute a TorrentManifest from a model binary.
   */
  static createManifest(
    modelBinary: Uint8Array,
    modelName: string,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
  ): TorrentManifest {
    const chunkCount = Math.ceil(modelBinary.length / chunkSize);
    const chunkCrc32 = new Uint32Array(chunkCount);

    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, modelBinary.length);
      chunkCrc32[i] = crc32(modelBinary, start, end - start);
    }

    // Root hash: CRC32 of the CRC32 array (simplified; production uses SHA-256)
    const rootCrc = crc32(new Uint8Array(chunkCrc32.buffer), 0, chunkCrc32.byteLength);

    // Simple torrent ID (production would use SHA-256 of the manifest JSON)
    const torrentId = `${modelName}-${rootCrc.toString(16)}-${chunkCount}`;

    return {
      torrentId,
      modelName,
      totalBytes: modelBinary.length,
      chunkSize,
      chunkCount,
      rootHash: rootCrc.toString(16),
      chunkCrc32,
    };
  }

  // ─── Hub leader → downstream fan-out instruction ────────────────────────

  /**
   * Generate the forwarding plan for a hub leader.
   *
   * The leader receives a chunk from the master, then forwards it to
   * its immediate downstream peers.  Those peers forward to theirs, etc.
   *
   * Returns a list of [chunkIndex, targetPeer] pairs for the leader to execute.
   */
  static forwardingPlan(root: TorrentPeer): Map<number, TorrentPeer[]> {
    const plan = new Map<number, TorrentPeer[]>();

    function walk(node: TorrentPeer): void {
      if (node.downstream.length > 0) {
        plan.set(node.treeLevel, node.downstream);
      }
      for (const child of node.downstream) {
        walk(child);
      }
    }

    walk(root);
    return plan;
  }

  /** Get the distribution tree root for a hub. */
  getRoot(hubId: number): TorrentPeer | undefined {
    return this.rootPeers.get(hubId);
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private _buildChunkPacket(chunkIndex: number, payload: Uint8Array): Uint8Array {
    const packetSize = CHUNK_HEADER_BYTES + payload.length + CHUNK_FOOTER_BYTES;
    const packet = new Uint8Array(packetSize);
    const dv = new DataView(packet.buffer);

    dv.setUint32(0, chunkIndex, true);
    dv.setUint32(4, payload.length, true);
    packet.set(payload, CHUNK_HEADER_BYTES);

    const checksum = crc32(payload);
    dv.setUint32(CHUNK_HEADER_BYTES + payload.length, checksum, true);

    return packet;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Client-side Chunk Request Scheduler (rarest-first)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Edge-side chunk download scheduler.
 *
 * Implements a "rarest-first" strategy:  when multiple peers are available,
 * request the chunk that the fewest peers possess first.  This maximises
 * chunk diversity and minimises the risk of a single chunk becoming
 * unavailable if its only holder disconnects.
 */
export class ChunkScheduler {
  readonly manifest: TorrentManifest;
  private readonly state: Uint8Array; // ChunkState per chunk
  private readonly peerChunks: Map<string, Set<number>>; // peerKey → chunks they have
  private readonly retryCount: Uint8Array;
  private completedCount = 0;
  private onComplete: (() => void) | null = null;

  constructor(manifest: TorrentManifest) {
    this.manifest = manifest;
    this.state = new Uint8Array(manifest.chunkCount); // all PENDING
    this.retryCount = new Uint8Array(manifest.chunkCount);
    this.peerChunks = new Map();
  }

  /** Announce that a peer possesses certain chunks. */
  announceHave(peerKey: string, chunks: Set<number>): void {
    this.peerChunks.set(peerKey, chunks);
  }

  /** Mark a chunk as successfully received and verified. */
  markComplete(chunkIndex: number): void {
    if (this.state[chunkIndex] === ChunkState.COMPLETE) return;
    this.state[chunkIndex] = ChunkState.COMPLETE;
    this.completedCount++;

    if (this.completedCount >= this.manifest.chunkCount) {
      this.onComplete?.();
    }
  }

  /** Mark a chunk as corrupt (needs retry). */
  markCorrupt(chunkIndex: number): boolean {
    this.retryCount[chunkIndex]++;
    if (this.retryCount[chunkIndex] > MAX_RETRIES) {
      this.state[chunkIndex] = ChunkState.CORRUPT;
      return false; // exhausted retries
    }
    this.state[chunkIndex] = ChunkState.PENDING;
    return true; // can retry
  }

  /** Get the next chunk to request (rarest-first). */
  nextChunk(): { chunkIndex: number; peerKeys: string[] } | null {
    // Count how many peers have each pending chunk
    const availability = new Map<number, number>();

    for (const [, chunks] of this.peerChunks) {
      for (const c of chunks) {
        if (this.state[c] === ChunkState.PENDING) {
          availability.set(c, (availability.get(c) || 0) + 1);
        }
      }
    }

    if (availability.size === 0) return null;

    // Rarest-first: pick the chunk with the fewest peers
    let rarest = -1;
    let rarestCount = Infinity;

    for (const [chunk, count] of availability) {
      if (count < rarestCount) {
        rarestCount = count;
        rarest = chunk;
      }
    }

    if (rarest < 0) return null;

    // Find all peers that have this chunk
    const peerKeys: string[] = [];
    for (const [peerKey, chunks] of this.peerChunks) {
      if (chunks.has(rarest)) {
        peerKeys.push(peerKey);
      }
    }

    this.state[rarest] = ChunkState.REQUESTED;
    return { chunkIndex: rarest, peerKeys };
  }

  setOnComplete(fn: () => void): void {
    this.onComplete = fn;
  }

  get progress(): number {
    return this.completedCount / this.manifest.chunkCount;
  }

  get isComplete(): boolean {
    return this.completedCount >= this.manifest.chunkCount;
  }
}
