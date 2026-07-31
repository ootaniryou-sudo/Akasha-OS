import { ClusterId, nowUs } from '../binary/protocol.js';
import type { IdleClusterPool, AkashaNodeRecord } from '../structures/idle-cluster-pool.js';
import { ObjectPool } from '../pool/object-pool.js';

/**
 * Pooled inference transaction — no per-request heap churn.
 */
export interface InferenceTx {
  txId: bigint;
  clusterId: number;
  primaryNodeId: bigint;
  shadowNodeId: bigint;
  startUs: bigint;
  deadlineUs: bigint;
  seq: number;
  /** 0=active, 1=done, 2=failed, 3=failover */
  state: number;
  /** index into activation scratch (optional) */
  payloadSlot: number;
  inUse: boolean;
}

export const TX_ACTIVE = 0;
export const TX_DONE = 1;
export const TX_FAILED = 2;
export const TX_FAILOVER = 3;

export function createTxPool(size: number): ObjectPool<InferenceTx> {
  return new ObjectPool<InferenceTx>(
    () => ({
      txId: 0n,
      clusterId: 0,
      primaryNodeId: 0n,
      shadowNodeId: 0n,
      startUs: 0n,
      deadlineUs: 0n,
      seq: 0,
      state: TX_ACTIVE,
      payloadSlot: -1,
      inUse: false,
    }),
    (tx) => {
      tx.txId = 0n;
      tx.clusterId = 0;
      tx.primaryNodeId = 0n;
      tx.shadowNodeId = 0n;
      tx.startUs = 0n;
      tx.deadlineUs = 0n;
      tx.seq = 0;
      tx.state = TX_ACTIVE;
      tx.payloadSlot = -1;
      tx.inUse = false;
    },
    Math.min(256, size),
    size,
  );
}

/**
 * fault-tolerance.ts — Shadow of Wisdom (Shadow Execution) + Divine Safeguard (Fault Protection)
 *
 * 同一計算を Primary Node と Shadow Node（Guardian Terminal）に同時送信し、
 * If now > start + (EWMA + margin), immediately fan-out the same binary tensor
 * to a shadow node — non-blocking, primary result wins (first RESULT completes).
 */
export class FaultToleranceEngine {
  private readonly active = new Map<string, InferenceTx>();
  private readonly marginUs: number;
  private readonly shadowClusterId: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seqCounter = 1;

  constructor(
    private readonly pool: IdleClusterPool,
    private readonly txPool: ObjectPool<InferenceTx>,
    opts?: { marginUs?: number; shadowClusterId?: number; tickMs?: number },
  ) {
    this.marginUs = opts?.marginUs ?? 2_000; // +2ms
    this.shadowClusterId = opts?.shadowClusterId ?? ClusterId.SHADOW_POOL;
  }

  track(tx: InferenceTx): void {
    this.active.set(tx.txId.toString(), tx);
  }

  untrack(txId: bigint): InferenceTx | undefined {
    const key = txId.toString();
    const tx = this.active.get(key);
    if (tx) {
      this.active.delete(key);
      return tx;
    }
    return undefined;
  }

  get(txId: bigint): InferenceTx | undefined {
    return this.active.get(txId.toString());
  }

  nextSeq(): number {
    return (this.seqCounter = (this.seqCounter + 1) >>> 0) || 1;
  }

  /**
   * Allocate + arm a transaction against a primary node.
   */
  arm(
    txId: bigint,
    clusterId: number,
    primary: AkashaNodeRecord,
  ): InferenceTx {
    const tx = this.txPool.acquire();
    tx.inUse = true;
    tx.txId = txId;
    tx.clusterId = clusterId;
    tx.primaryNodeId = primary.nodeId;
    tx.shadowNodeId = 0n;
    tx.startUs = nowUs();
    tx.deadlineUs = tx.startUs + BigInt(this.pool.deadlineUs(primary.nodeId, this.marginUs));
    tx.seq = this.nextSeq();
    tx.state = TX_ACTIVE;
    this.track(tx);
    return tx;
  }

  /**
   * Scan active txs; invoke onTimeout(tx, shadow) when deadline breached
   * and no shadow yet dispatched.
   */
  scan(
    onTimeout: (tx: InferenceTx, shadow: AkashaNodeRecord) => void,
  ): number {
    const now = nowUs();
    let fired = 0;
    for (const tx of this.active.values()) {
      if (tx.state !== TX_ACTIVE) continue;
      if (tx.shadowNodeId !== 0n) continue; // already failed over
      if (now <= tx.deadlineUs) continue;

      const primary = this.pool.get(tx.primaryNodeId);
      if (!primary) {
        tx.state = TX_FAILED;
        continue;
      }
      const shadow = this.pool.acquireShadow(primary, this.shadowClusterId);
      if (!shadow) continue;

      tx.shadowNodeId = shadow.nodeId;
      tx.state = TX_FAILOVER;
      // extend deadline once for shadow attempt
      tx.deadlineUs = now + BigInt(this.pool.deadlineUs(shadow.nodeId, this.marginUs));
      onTimeout(tx, shadow);
      fired++;
    }
    return fired;
  }

  complete(txId: bigint, nodeId: bigint, latencyUs: number): InferenceTx | null {
    const tx = this.untrack(txId);
    if (!tx) return null; // late duplicate (shadow after primary, or vice versa)
    this.pool.observeLatency(nodeId, latencyUs);
    // release both primary and shadow if still computing
    this.pool.releaseToIdle(tx.primaryNodeId);
    if (tx.shadowNodeId !== 0n && tx.shadowNodeId !== nodeId) {
      this.pool.releaseToIdle(tx.shadowNodeId);
    } else if (tx.shadowNodeId === nodeId) {
      this.pool.releaseToIdle(tx.primaryNodeId);
    }
    tx.state = TX_DONE;
    return tx;
  }

  releaseTx(tx: InferenceTx): void {
    if (!tx.inUse) return;
    tx.inUse = false;
    this.txPool.release(tx);
  }

  start(tickMs: number, onTimeout: (tx: InferenceTx, shadow: AkashaNodeRecord) => void): void {
    if (this.timer) return;
    // Sub-ms polling via setInterval(1) + hrtime check; production can use
    // a dedicated worker with Atomics.wait timed wakes.
    this.timer = setInterval(() => this.scan(onTimeout), Math.max(1, tickMs));
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get inFlight(): number {
    return this.active.size;
  }
}

/**
 * Ultra-cheap semantic router — keyword / digit scan without allocating
 * intermediate strings beyond the original prompt buffer view.
 */
export function routeCluster(prompt: string): number {
  const len = prompt.length;
  let hasDigit = false;
  let hasMathOp = false;
  // scan once
  for (let i = 0; i < len; i++) {
    const c = prompt.charCodeAt(i);
    if (c >= 48 && c <= 57) hasDigit = true;
    else if (c === 43 || c === 45 || c === 42 || c === 47 || c === 61) hasMathOp = true;
  }
  if (hasDigit && hasMathOp) return ClusterId.MATH;

  // case-insensitive needle checks without toLowerCase() alloc of whole string
  if (includesInsensitive(prompt, 'math') || includesInsensitive(prompt, 'calc')) {
    return ClusterId.MATH;
  }
  if (includesInsensitive(prompt, 'code') || includesInsensitive(prompt, 'function')) {
    return ClusterId.CODE;
  }
  return ClusterId.GENERAL;
}

function includesInsensitive(hay: string, needle: string): boolean {
  const nlen = needle.length;
  const hlen = hay.length;
  outer: for (let i = 0; i <= hlen - nlen; i++) {
    for (let j = 0; j < nlen; j++) {
      let a = hay.charCodeAt(i + j);
      let b = needle.charCodeAt(j);
      if (a >= 65 && a <= 90) a += 32;
      if (b >= 65 && b <= 90) b += 32;
      if (a !== b) continue outer;
    }
    return true;
  }
  return false;
}

// ─── Dynamic router (plugin-aware) ──────────────────────────────────────────

/**
 * Create a semantic router that consults the plugin registry first,
 * then falls back to the static `routeCluster` heuristics.
 *
 * Usage:
 * ```ts
 * const registry = new PluginRegistry();
 * await registry.install(myMathPlugin);
 * const router = createDynamicRouter(registry);
 * const clusterId = router("solve 2x + 5 = 15"); // → math plugin cluster
 * ```
 *
 * @param registry — PluginRegistry instance (optional; if omitted, behaves
 *                   identically to the static `routeCluster`).
 * @returns A `(prompt: string) => number` function suitable for use in
 *          the router worker's dispatch path.
 */
export function createDynamicRouter(
  registry?: { route: (prompt: string, fallback: number) => number } | null,
): (prompt: string) => number {
  if (!registry) return routeCluster;

  return (prompt: string): number => {
    // Try plugin registry first
    const pluginCluster = registry.route(prompt, -1);
    if (pluginCluster !== -1) return pluginCluster;

    // Fall back to static routing
    return routeCluster(prompt);
  };
}
