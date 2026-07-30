/**
 * akasha-bootstrapper.ts
 *
 * Akasha OS — Boot / Auto-Discovery Engine
 * ─────────────────────────────────────────
 * Prevents self-inflicted DoS when tens of thousands of phones power on
 * simultaneously, maps each device onto the fat-tree topology from its
 * DHCP IPv4 address in O(1), measures APS (Akasha Performance Score) via
 * a single lightweight GPU probe, and auto-appoints CORE_ROUTER /
 * ACTIVE_COMPUTE / SHADOW_BACKUP roles — all without GC spikes on the
 * registration hot path (object-pooled contexts + intrusive FIFO queues).
 *
 * ## Data structures (tens of thousands of nodes)
 *
 * 1. `unevaluatedQ` — intrusive doubly-linked FIFO of pooled `BootstrapCtx`
 *    Connection handler only splices a pooled ctx onto the tail → O(1),
 *    no heap alloc, no sorting. Scheduler pops the head at ≤ N/sec.
 *
 * 2. `inflightBench` — HashMap<nodeId, BootstrapCtx> for nodes waiting on
 *    BENCHMARK RESULT. O(1) lookup when the RESULT packet returns.
 *
 * 3. `topology[rack][hub]` — nested Uint32-keyed maps → DoublyLinkedList of
 *    nodeIds. IPv4 is reduced to (rack, hub) by bit ops; list splice is O(1).
 *
 * 4. `byRole[role]` — three intrusive IDLE lists (same pattern as the
 *    runtime IdleClusterPool) so dispatch can pick a CORE / ACTIVE / SHADOW
 *    node in O(1) after appointment.
 *
 * 5. `nodes` — HashMap<nodeId, BootstrapCtx> living registry (ctx stays
 *    checked-out of the pool until disconnect, then released).
 *
 * Status bits live on the ctx itself (phase / role / aps) — no parallel
 * status objects, no per-log string formatting on the hot path.
 *
 * ## Wire sequence (binary — JSON forbidden on data plane)
 *
 *   Edge                         Master (this engine)
 *   ────                         ────────────────────
 *   WS connect ────────────────► enqueueUnevaluated()   [≤1µs, no bench]
 *   REGISTER (Cmd=0x01) ───────► bind nodeId / IP
 *        ◄────────────────────── BENCHMARK (Cmd=0x08)   [throttled ≤200/s]
 *                                payload = f32 probe tensor
 *                                TIMESTAMP_US = send time
 *   RESULT (Cmd=0x04) ─────────► APS = 1000/(gpuMs + RTT/2)
 *     expectedUs = GPU µs          ASSIGN (Cmd=0x09)
 *        ◄────────────────────── clusterId + role(seq) + layerBand(flags)
 *   ACK (optional) ────────────► mark ASSIGNED → runtime IdleClusterPool
 *
 * Edge clients that speak the 20-byte layer plane may embed the same
 * semantics: layerId=-2 REGISTER, layerId=-3 BENCHMARK, layerId=-4 ASSIGN.
 */

import { ObjectPool, BufferPool } from '../pool/object-pool.js';
import { DoublyLinkedList, type DLLNode } from '../structures/doubly-linked-list.js';
import { BinaryCodec } from '../binary/codec.js';
import {
  Cmd,
  ClusterId,
  Flag,
  HEADER_SIZE,
  MAX_PACKET_BYTES,
  NodeRole,
  nowUs,
  roleName,
  clusterName,
} from '../binary/protocol.js';

// ─── Bootstrap phase / topology ─────────────────────────────────────────────

export const enum BootstrapPhase {
  QUEUED = 0,
  BENCHMARKING = 1,
  ASSIGNED = 2,
  FAILED = 3,
  DISCONNECTED = 4,
}

/** Fat-tree coordinates derived from IPv4 (O(1) bit ops). */
export interface TopologyCoord {
  /** Rack / spine leaf id (0–255) */
  rack: number;
  /** Hub / ToR switch id within rack (0–255) */
  hub: number;
  /** Host octet (0–255) */
  host: number;
  /** Packed key = (rack << 16) | (hub << 8) | host — O(1) map key as number */
  packed: number;
  /** Segment key = (rack << 8) | hub — which physical cable bundle */
  segment: number;
}

export interface BootstrapOptions {
  /** Max REGISTER→BENCHMARK promotions per second (default 200). */
  maxPerSec?: number;
  /** APS ≥ this → CORE_ROUTER / HEAD_LAYER (default 80). */
  apsCoreMin?: number;
  /** APS ≥ this → ACTIVE_COMPUTE (default 25). Below → SHADOW. */
  apsActiveMin?: number;
  /** Benchmark tensor length in floats (default 256 — fits L1-ish probe). */
  benchFloats?: number;
  /** Drop unevaluated nodes older than this (ms). */
  queueTtlMs?: number;
  /** Benchmark RESULT timeout (ms). */
  benchTimeoutMs?: number;
  /** Called to send a raw binary frame to a socket slot.
   *  MUST be synchronous or copy the buffer — the engine releases
   *  the buffer back to the pool immediately after this call returns. */
  send?: (socketSlot: number, buf: ArrayBuffer, byteLength: number) => void;
  /** Fired once a node is fully appointed (hand off to runtime pool). */
  onAssigned?: (ctx: BootstrapCtx) => void;
  /** Optional telemetry (never allocate strings inside the engine). */
  onEvent?: (ev: BootstrapEvent) => void;
}

export type BootstrapEvent =
  | { type: 'enqueued'; nodeId: bigint; segment: number; queueDepth: number }
  | { type: 'benchmark_sent'; nodeId: bigint }
  | { type: 'assigned'; nodeId: bigint; role: NodeRole; aps: number; clusterId: number }
  | { type: 'failed'; nodeId: bigint; reason: number }
  | { type: 'throttle'; accepted: number; queued: number };

/**
 * Pooled registration context — one per live socket during bootstrap.
 * Never `new` on the connection hot path; acquire from BootstrapCtxPool.
 */
export interface BootstrapCtx {
  inUse: boolean;
  nodeId: bigint;
  socketSlot: number;
  /** IPv4 as u32 host-order (e.g. 192.168.10.45 → 0xC0A80A2D) */
  ipU32: number;
  rack: number;
  hub: number;
  host: number;
  segment: number;
  packed: number;
  phase: BootstrapPhase;
  role: NodeRole;
  clusterId: number;
  /** Layer band appointed for head/mid/tail (0=head,1=mid,2=tail/shadow) */
  layerBand: number;
  aps: number;
  gpuUs: number;
  rttUs: number;
  benchSentUs: bigint;
  enqueuedAtMs: number;
  /** Intrusive link in unevaluated FIFO */
  qLink: DLLNode<BootstrapCtx> | null;
  /** Intrusive link in topology segment list */
  topoLink: DLLNode<BootstrapCtx> | null;
  /** Intrusive link in role IDLE list after ASSIGN */
  roleLink: DLLNode<BootstrapCtx> | null;
}

const FAIL_TIMEOUT = 1;
const FAIL_BAD_RESULT = 2;
const FAIL_DISCONNECT = 3;

// ─── IPv4 → topology (pure bit ops, no string split on hot path) ─────────────

/**
 * Map DHCP IPv4 → fat-tree coordinates.
 *
 * Convention (configurable via scheme):
 *   10.<rack>.<hub>.<host>           → rack, hub, host as octets
 *   192.168.<seg>.<host>             → rack = seg >> 4, hub = seg & 0x0f
 *   anything else                    → rack = (b0^b1) & 0xff, hub = b2, host = b3
 *
 * Parsing from dotted string uses a tight digit scan (no `.split()`, no alloc).
 */
export function ipv4ToU32(ip: string): number {
  // Fast path: already numeric "3232238133"
  let n = 0;
  let octet = 0;
  let dots = 0;
  for (let i = 0; i < ip.length; i++) {
    const c = ip.charCodeAt(i);
    if (c === 46) {
      // '.'
      n = ((n << 8) | (octet & 0xff)) >>> 0;
      octet = 0;
      dots++;
    } else if (c >= 48 && c <= 57) {
      octet = octet * 10 + (c - 48);
    } else if (c === 58) {
      // IPv4-mapped in IPv6 ":ffff:x.x.x.x" — skip until last 4 octets begin
      // Fall through: caller should pass remoteAddress already normalized.
      continue;
    } else {
      // strip zone id etc.
      break;
    }
  }
  n = ((n << 8) | (octet & 0xff)) >>> 0;
  if (dots !== 3) {
    // Fallback: hash the string into a stable u32 without throwing
    let h = 2166136261;
    for (let i = 0; i < ip.length; i++) {
      h ^= ip.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  return n;
}

export function topologyFromIpU32(ipU32: number): TopologyCoord {
  const b0 = (ipU32 >>> 24) & 0xff;
  const b1 = (ipU32 >>> 16) & 0xff;
  const b2 = (ipU32 >>> 8) & 0xff;
  const b3 = ipU32 & 0xff;

  let rack: number;
  let hub: number;
  let host: number;

  if (b0 === 10) {
    // 10.<rack>.<hub>.<host>
    rack = b1;
    hub = b2;
    host = b3;
  } else if (b0 === 192 && b1 === 168) {
    // 192.168.<seg>.<host> → rack = high nibble, hub = low nibble of seg
    rack = (b2 >>> 4) & 0x0f;
    hub = b2 & 0x0f;
    host = b3;
  } else if (b0 === 172 && b1 >= 16 && b1 <= 31) {
    // 172.16-31.<hub>.<host>
    rack = b1 - 16;
    hub = b2;
    host = b3;
  } else {
    rack = (b0 ^ b1) & 0xff;
    hub = b2;
    host = b3;
  }

  const packed = ((rack & 0xff) << 16) | ((hub & 0xff) << 8) | (host & 0xff);
  const segment = ((rack & 0xff) << 8) | (hub & 0xff);
  return { rack, hub, host, packed, segment };
}

/**
 * APS = 1000 / (GPU_ms + RTT_ms / 2)
 *
 * Range: effectively 1 – ~500,000.  Higher = faster device.
 * Guard: clamps denominator ≥ 1µs to prevent Infinity.
 */
export function computeAps(gpuUs: number, rttUs: number): number {
  const gpuMs = Math.max(gpuUs, 1) / 1000;
  const halfRttMs = Math.max(rttUs, 1) / 2000;
  const denom = Math.max(gpuMs + halfRttMs, 0.001); // ≥ 1 ns guard
  const aps = 1000 / denom;
  // Clamp to sane range (hardware physics: no device is infinite)
  return Number.isFinite(aps) ? aps : 1;
}

export function appointFromAps(
  aps: number,
  apsCoreMin: number,
  apsActiveMin: number,
): { role: NodeRole; clusterId: number; layerBand: number } {
  if (aps >= apsCoreMin) {
    return { role: NodeRole.CORE_ROUTER, clusterId: ClusterId.HEAD_LAYER, layerBand: 0 };
  }
  if (aps >= apsActiveMin) {
    return { role: NodeRole.ACTIVE_COMPUTE, clusterId: ClusterId.GENERAL, layerBand: 1 };
  }
  return { role: NodeRole.SHADOW_BACKUP, clusterId: ClusterId.SHADOW_POOL, layerBand: 2 };
}

// ─── Ctx factory / pool ─────────────────────────────────────────────────────

function createEmptyCtx(): BootstrapCtx {
  return {
    inUse: false,
    nodeId: 0n,
    socketSlot: 0,
    ipU32: 0,
    rack: 0,
    hub: 0,
    host: 0,
    segment: 0,
    packed: 0,
    phase: BootstrapPhase.QUEUED,
    role: NodeRole.UNASSIGNED,
    clusterId: 0,
    layerBand: 0,
    aps: 0,
    gpuUs: 0,
    rttUs: 0,
    benchSentUs: 0n,
    enqueuedAtMs: 0,
    qLink: null,
    topoLink: null,
    roleLink: null,
  };
}

function resetCtx(c: BootstrapCtx): void {
  c.inUse = false;
  c.nodeId = 0n;
  c.socketSlot = 0;
  c.ipU32 = 0;
  c.rack = 0;
  c.hub = 0;
  c.host = 0;
  c.segment = 0;
  c.packed = 0;
  c.phase = BootstrapPhase.QUEUED;
  c.role = NodeRole.UNASSIGNED;
  c.clusterId = 0;
  c.layerBand = 0;
  c.aps = 0;
  c.gpuUs = 0;
  c.rttUs = 0;
  c.benchSentUs = 0n;
  c.enqueuedAtMs = 0;
  c.qLink = null;
  c.topoLink = null;
  c.roleLink = null;
}

// ─── Bootstrapper engine ────────────────────────────────────────────────────

export class AkashaBootstrapper {
  private readonly opts: Required<
    Pick<
      BootstrapOptions,
      'maxPerSec' | 'apsCoreMin' | 'apsActiveMin' | 'benchFloats' | 'queueTtlMs' | 'benchTimeoutMs'
    >
  > &
    Pick<BootstrapOptions, 'send' | 'onAssigned' | 'onEvent'>;

  private readonly ctxPool: ObjectPool<BootstrapCtx>;
  private readonly linkPool: ObjectPool<DLLNode<BootstrapCtx>>;
  private readonly bufPool: BufferPool;

  /** Unevaluated connection FIFO (intrusive). */
  private readonly unevaluatedQ = new DoublyLinkedList<BootstrapCtx>();
  /** nodeId → ctx */
  private readonly nodes = new Map<string, BootstrapCtx>();
  /** socketSlot → ctx (connection-handler O(1)) */
  private readonly bySlot = new Map<number, BootstrapCtx>();
  /** segment → list of nodes on that hub */
  private readonly topology = new Map<number, DoublyLinkedList<BootstrapCtx>>();
  /** role → appointed idle list */
  private readonly byRole = new Map<NodeRole, DoublyLinkedList<BootstrapCtx>>([
    [NodeRole.CORE_ROUTER, new DoublyLinkedList()],
    [NodeRole.ACTIVE_COMPUTE, new DoublyLinkedList()],
    [NodeRole.SHADOW_BACKUP, new DoublyLinkedList()],
  ]);
  /** Nodes waiting on BENCHMARK RESULT */
  private readonly inflightBench = new Map<string, BootstrapCtx>();

  private readonly benchTensor: Float32Array;
  private acceptedThisWindow = 0;
  private windowStartMs = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** Precomputed token bucket refill: maxPerSec per 1000ms, drained each tick. */
  private budget = 0;

  constructor(options: BootstrapOptions = {}) {
    this.opts = {
      maxPerSec: options.maxPerSec ?? 200,
      apsCoreMin: options.apsCoreMin ?? 80,
      apsActiveMin: options.apsActiveMin ?? 25,
      benchFloats: options.benchFloats ?? 256,
      queueTtlMs: options.queueTtlMs ?? 60_000,
      benchTimeoutMs: options.benchTimeoutMs ?? 3_000,
      send: options.send,
      onAssigned: options.onAssigned,
      onEvent: options.onEvent,
    };

    const poolSize = 65_536;
    this.ctxPool = new ObjectPool(createEmptyCtx, resetCtx, 1024, poolSize);
    this.linkPool = new ObjectPool<DLLNode<BootstrapCtx>>(
      () => ({ value: null!, prev: null, next: null }),
      (n) => {
        n.value = null!;
        n.prev = null;
        n.next = null;
      },
      2048,
      poolSize * 3,
    );
    this.bufPool = new BufferPool(MAX_PACKET_BYTES, 64, 1024);

    // Deterministic probe tensor — same every boot (cache-friendly, no RNG alloc)
    this.benchTensor = new Float32Array(this.opts.benchFloats);
    for (let i = 0; i < this.benchTensor.length; i++) {
      this.benchTensor[i] = ((i * 17) % 1000) / 1000 - 0.5;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.windowStartMs = Date.now();
    this.budget = this.opts.maxPerSec;
    // 5ms tick → smooth drain (~40 grants per tick at 200/s)
    this.tickTimer = setInterval(() => this.tick(), 5);
    if (typeof this.tickTimer === 'object' && 'unref' in this.tickTimer) {
      this.tickTimer.unref();
    }
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  get queueDepth(): number {
    return this.unevaluatedQ.length;
  }

  get assignedCount(): number {
    let n = 0;
    for (const list of this.byRole.values()) n += list.length;
    return n;
  }

  get(nodeId: bigint): BootstrapCtx | undefined {
    return this.nodes.get(nodeId.toString());
  }

  /**
   * Connection handler entry — MUST stay < ~1µs of work.
   * Only: acquire pooled ctx, fill IP/slot, push FIFO. No benchmark, no I/O.
   */
  enqueueConnection(socketSlot: number, remoteIp: string, nodeId = 0n): BootstrapCtx {
    // Replace prior occupant of this slot (reconnect)
    const prior = this.bySlot.get(socketSlot);
    if (prior) this.fail(prior, FAIL_DISCONNECT);

    const ctx = this.ctxPool.acquire();
    ctx.inUse = true;
    ctx.socketSlot = socketSlot;
    ctx.nodeId = nodeId;
    ctx.ipU32 = ipv4ToU32(normalizeRemoteIp(remoteIp));
    const topo = topologyFromIpU32(ctx.ipU32);
    ctx.rack = topo.rack;
    ctx.hub = topo.hub;
    ctx.host = topo.host;
    ctx.segment = topo.segment;
    ctx.packed = topo.packed;
    ctx.phase = BootstrapPhase.QUEUED;
    ctx.enqueuedAtMs = Date.now();

    const link = this.linkPool.acquire();
    link.value = ctx;
    link.prev = null;
    link.next = null;
    ctx.qLink = link;
    this.unevaluatedQ.pushTail(link);

    this.bySlot.set(socketSlot, ctx);
    if (nodeId !== 0n) this.nodes.set(nodeId.toString(), ctx);

    // Topology O(1) register
    this.attachTopology(ctx);

    this.opts.onEvent?.({
      type: 'enqueued',
      nodeId: ctx.nodeId,
      segment: ctx.segment,
      queueDepth: this.unevaluatedQ.length,
    });

    return ctx;
  }

  /**
   * Bind nodeId once REGISTER packet arrives (still O(1), no promotion).
   */
  bindRegister(socketSlot: number, nodeId: bigint): void {
    const ctx = this.bySlot.get(socketSlot);
    if (!ctx) return;
    if (ctx.nodeId !== 0n && ctx.nodeId !== nodeId) {
      this.nodes.delete(ctx.nodeId.toString());
    }
    ctx.nodeId = nodeId;
    this.nodes.set(nodeId.toString(), ctx);
  }

  /**
   * Handle RESULT for an in-flight benchmark.
   * `gpuUs` should be echoed by the edge in header.expectedUs (µs).
   */
  onBenchmarkResult(nodeId: bigint, gpuUs: number, recvUs: bigint = nowUs()): void {
    const key = nodeId.toString();
    const ctx = this.inflightBench.get(key);
    if (!ctx || ctx.phase !== BootstrapPhase.BENCHMARKING) return;
    this.inflightBench.delete(key);

    // Sanity: reject impossibly fast (>60s GPU kernel is absurd)
    if (gpuUs <= 0 || gpuUs > 60_000_000) {
      this.fail(ctx, FAIL_BAD_RESULT);
      return;
    }

    const rttUs = Number(recvUs - ctx.benchSentUs);
    ctx.rttUs = rttUs > 0 ? rttUs : 1;
    ctx.gpuUs = gpuUs > 0 ? gpuUs : 1;
    ctx.aps = computeAps(ctx.gpuUs, ctx.rttUs);

    const appt = appointFromAps(ctx.aps, this.opts.apsCoreMin, this.opts.apsActiveMin);
    ctx.role = appt.role;
    ctx.clusterId = appt.clusterId;
    ctx.layerBand = appt.layerBand;
    ctx.phase = BootstrapPhase.ASSIGNED;

    this.sendAssign(ctx);
    this.attachRole(ctx);

    this.opts.onEvent?.({
      type: 'assigned',
      nodeId: ctx.nodeId,
      role: ctx.role,
      aps: ctx.aps,
      clusterId: ctx.clusterId,
    });
    this.opts.onAssigned?.(ctx);
  }

  /** Socket closed — release everything back to pools. */
  onDisconnect(socketSlot: number): void {
    const ctx = this.bySlot.get(socketSlot);
    if (!ctx) return;
    this.fail(ctx, FAIL_DISCONNECT);
  }

  /** O(1) pick an appointed idle node of a given role. */
  acquireByRole(role: NodeRole): BootstrapCtx | null {
    const list = this.byRole.get(role);
    if (!list || list.length === 0) return null;
    const link = list.popHead();
    if (!link) return null;
    const ctx = link.value;
    this.linkPool.release(link);
    ctx.roleLink = null;
    return ctx;
  }

  /** Return appointed node to its role idle list. */
  releaseToRole(ctx: BootstrapCtx): void {
    if (ctx.phase !== BootstrapPhase.ASSIGNED || ctx.role === NodeRole.UNASSIGNED) return;
    if (ctx.roleLink) return;
    this.attachRole(ctx);
  }

  /** Nodes on the same physical hub/segment (shadow affinity). */
  segmentPeers(segment: number): DoublyLinkedList<BootstrapCtx> | undefined {
    return this.topology.get(segment);
  }

  // ─── Scheduler tick ───────────────────────────────────────────────────────

  private tick(): void {
    const now = Date.now();
    // Refill token bucket once per second
    if (now - this.windowStartMs >= 1000) {
      this.opts.onEvent?.({
        type: 'throttle',
        accepted: this.acceptedThisWindow,
        queued: this.unevaluatedQ.length,
      });
      this.windowStartMs = now;
      this.acceptedThisWindow = 0;
      this.budget = this.opts.maxPerSec;
    }

    // Expire stale queue heads
    while (this.unevaluatedQ.head) {
      const head = this.unevaluatedQ.head.value;
      if (now - head.enqueuedAtMs <= this.opts.queueTtlMs) break;
      this.unevaluatedQ.popHead();
      if (head.qLink) {
        this.linkPool.release(head.qLink);
        head.qLink = null;
      }
      this.fail(head, FAIL_TIMEOUT);
    }

    // Expire inflight benchmarks (hrtime-based, µs)
    const nowUsTick = nowUs();
    const timeoutUs = BigInt(this.opts.benchTimeoutMs) * 1000n;
    if (this.inflightBench.size > 0) {
      const expired: BootstrapCtx[] = [];
      for (const ctx of this.inflightBench.values()) {
        if (nowUsTick - ctx.benchSentUs > timeoutUs) expired.push(ctx);
      }
      for (const ctx of expired) {
        this.inflightBench.delete(ctx.nodeId.toString());
        this.fail(ctx, FAIL_TIMEOUT);
      }
    }

    // Drain budget into BENCHMARK phase
    // Bounded linear scan: skip unregistered nodes (requeue at tail),
    // promote registered ones. Bounded to perTick × 3 scans to avoid
    // starvation when many nodes still await REGISTER.
    const perTick = Math.max(1, Math.ceil(this.opts.maxPerSec / 200)); // ~5ms tick
    let granted = 0;
    let examined = 0;
    const maxScan = Math.min(this.unevaluatedQ.length, perTick * 3 + 1);
    while (
      granted < perTick &&
      this.budget > 0 &&
      this.unevaluatedQ.length > 0 &&
      examined < maxScan
    ) {
      const link = this.unevaluatedQ.popHead();
      if (!link) break;
      const ctx = link.value;
      examined++;

      if (ctx.nodeId === 0n) {
        // REGISTER not yet bound — requeue at tail, skip, scan next
        // Reuse the same DLL link (already detached by popHead)
        ctx.qLink = link;
        this.unevaluatedQ.pushTail(link);
        continue;
      }

      // Registered node: release link, promote
      this.linkPool.release(link);
      ctx.qLink = null;
      this.promoteToBenchmark(ctx);
      this.budget--;
      this.acceptedThisWindow++;
      granted++;
    }
  }

  private promoteToBenchmark(ctx: BootstrapCtx): void {
    ctx.phase = BootstrapPhase.BENCHMARKING;
    ctx.benchSentUs = nowUs();
    this.inflightBench.set(ctx.nodeId.toString(), ctx);
    this.sendBenchmark(ctx);
    this.opts.onEvent?.({ type: 'benchmark_sent', nodeId: ctx.nodeId });
  }

  private sendBenchmark(ctx: BootstrapCtx): void {
    if (!this.opts.send) return;
    const buf = this.bufPool.acquire();
    const len = BinaryCodec.encode(buf, {
      command: Cmd.BENCHMARK,
      flags: Flag.NONE,
      txId: ctx.nodeId, // correlate
      nodeId: ctx.nodeId,
      clusterId: 0,
      timestampUs: ctx.benchSentUs,
      expectedUs: 0,
      seq: 0,
      payload: this.benchTensor,
    });
    this.opts.send(ctx.socketSlot, buf, len);
    this.bufPool.release(buf);
  }

  private sendAssign(ctx: BootstrapCtx): void {
    if (!this.opts.send) return;
    const buf = this.bufPool.acquire();
    // Payload: [f32 aps][f32 gpuUs][f32 rttUs] — optional telemetry for the edge UI
    const telemetry = new Float32Array([ctx.aps, ctx.gpuUs, ctx.rttUs]);
    const len = BinaryCodec.encode(buf, {
      command: Cmd.ASSIGN,
      flags: ctx.layerBand & 0xffff,
      txId: ctx.nodeId,
      nodeId: ctx.nodeId,
      clusterId: ctx.clusterId,
      timestampUs: nowUs(),
      expectedUs: Math.round(ctx.aps * 1000),
      seq: ctx.role,
      payload: telemetry,
    });
    this.opts.send(ctx.socketSlot, buf, len);
    this.bufPool.release(buf);
  }

  private attachTopology(ctx: BootstrapCtx): void {
    let list = this.topology.get(ctx.segment);
    if (!list) {
      list = new DoublyLinkedList<BootstrapCtx>();
      this.topology.set(ctx.segment, list);
    }
    if (ctx.topoLink) return;
    const link = this.linkPool.acquire();
    link.value = ctx;
    ctx.topoLink = link;
    list.pushTail(link);
  }

  private detachTopology(ctx: BootstrapCtx): void {
    if (!ctx.topoLink) return;
    const list = this.topology.get(ctx.segment);
    if (list) list.remove(ctx.topoLink);
    this.linkPool.release(ctx.topoLink);
    ctx.topoLink = null;
  }

  private attachRole(ctx: BootstrapCtx): void {
    const list = this.byRole.get(ctx.role);
    if (!list || ctx.roleLink) return;
    const link = this.linkPool.acquire();
    link.value = ctx;
    ctx.roleLink = link;
    list.pushTail(link);
  }

  private detachRole(ctx: BootstrapCtx): void {
    if (!ctx.roleLink) return;
    const list = this.byRole.get(ctx.role);
    if (list) list.remove(ctx.roleLink);
    this.linkPool.release(ctx.roleLink);
    ctx.roleLink = null;
  }

  private detachQueue(ctx: BootstrapCtx): void {
    if (!ctx.qLink) return;
    this.unevaluatedQ.remove(ctx.qLink);
    this.linkPool.release(ctx.qLink);
    ctx.qLink = null;
  }

  private fail(ctx: BootstrapCtx, reason: number): void {
    if (ctx.phase === BootstrapPhase.DISCONNECTED) return;
    this.detachQueue(ctx);
    this.detachTopology(ctx);
    this.detachRole(ctx);
    this.inflightBench.delete(ctx.nodeId.toString());
    this.bySlot.delete(ctx.socketSlot);
    if (ctx.nodeId !== 0n) this.nodes.delete(ctx.nodeId.toString());
    ctx.phase = BootstrapPhase.DISCONNECTED;
    this.opts.onEvent?.({ type: 'failed', nodeId: ctx.nodeId, reason });
    if (ctx.inUse) {
      ctx.inUse = false;
      this.ctxPool.release(ctx);
    }
  }
}

/** Strip IPv6-mapped prefix `::ffff:` for ws remoteAddress. */
export function normalizeRemoteIp(addr: string): string {
  if (addr.startsWith('::ffff:')) return addr.slice(7);
  if (addr.startsWith('[::ffff:')) {
    const end = addr.indexOf(']');
    return addr.slice(8, end > 0 ? end : undefined);
  }
  return addr;
}

// ─── Convenience: decode GPU µs from RESULT header ──────────────────────────

/**
 * Edge should set `expectedUs` = GPU kernel time in microseconds on RESULT
 * responding to BENCHMARK. RTT is measured server-side via TIMESTAMP_US echo.
 */
export function gpuUsFromResultHeader(expectedUs: number): number {
  return expectedUs > 0 ? expectedUs : 1;
}

export {
  roleName,
  clusterName,
  HEADER_SIZE,
  Cmd,
  NodeRole,
  ClusterId,
};
