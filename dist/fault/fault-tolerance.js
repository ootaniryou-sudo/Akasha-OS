import { nowUs } from '../binary/protocol.js';
import { ObjectPool } from '../pool/object-pool.js';
export const TX_ACTIVE = 0;
export const TX_DONE = 1;
export const TX_FAILED = 2;
export const TX_FAILOVER = 3;
export function createTxPool(size) {
    return new ObjectPool(() => ({
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
    }), (tx) => {
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
    }, Math.min(256, size), size);
}
/**
 * fault-tolerance.ts — Shadow of Wisdom (Shadow Execution) + Divine Safeguard (Fault Protection)
 *
 * 同一計算を Primary Node と Shadow Node（Guardian Terminal）に同時送信し、
 * If now > start + (EWMA + margin), immediately fan-out the same binary tensor
 * to a shadow node — non-blocking, primary result wins (first RESULT completes).
 */
export class FaultToleranceEngine {
    pool;
    txPool;
    active = new Map();
    marginUs;
    shadowClusterId;
    timer = null;
    seqCounter = 1;
    constructor(pool, txPool, opts) {
        this.pool = pool;
        this.txPool = txPool;
        this.marginUs = opts?.marginUs ?? 2_000; // +2ms
        this.shadowClusterId = opts?.shadowClusterId ?? 99 /* ClusterId.SHADOW_POOL */;
    }
    track(tx) {
        this.active.set(tx.txId.toString(), tx);
    }
    untrack(txId) {
        const key = txId.toString();
        const tx = this.active.get(key);
        if (tx) {
            this.active.delete(key);
            return tx;
        }
        return undefined;
    }
    get(txId) {
        return this.active.get(txId.toString());
    }
    nextSeq() {
        return (this.seqCounter = (this.seqCounter + 1) >>> 0) || 1;
    }
    /**
     * Allocate + arm a transaction against a primary node.
     */
    arm(txId, clusterId, primary) {
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
    scan(onTimeout) {
        const now = nowUs();
        let fired = 0;
        for (const tx of this.active.values()) {
            if (tx.state !== TX_ACTIVE)
                continue;
            if (tx.shadowNodeId !== 0n)
                continue; // already failed over
            if (now <= tx.deadlineUs)
                continue;
            const primary = this.pool.get(tx.primaryNodeId);
            if (!primary) {
                tx.state = TX_FAILED;
                continue;
            }
            const shadow = this.pool.acquireShadow(primary, this.shadowClusterId);
            if (!shadow)
                continue;
            tx.shadowNodeId = shadow.nodeId;
            tx.state = TX_FAILOVER;
            // extend deadline once for shadow attempt
            tx.deadlineUs = now + BigInt(this.pool.deadlineUs(shadow.nodeId, this.marginUs));
            onTimeout(tx, shadow);
            fired++;
        }
        return fired;
    }
    complete(txId, nodeId, latencyUs) {
        const tx = this.untrack(txId);
        if (!tx)
            return null; // late duplicate (shadow after primary, or vice versa)
        this.pool.observeLatency(nodeId, latencyUs);
        // release both primary and shadow if still computing
        this.pool.releaseToIdle(tx.primaryNodeId);
        if (tx.shadowNodeId !== 0n && tx.shadowNodeId !== nodeId) {
            this.pool.releaseToIdle(tx.shadowNodeId);
        }
        else if (tx.shadowNodeId === nodeId) {
            this.pool.releaseToIdle(tx.primaryNodeId);
        }
        tx.state = TX_DONE;
        return tx;
    }
    releaseTx(tx) {
        if (!tx.inUse)
            return;
        tx.inUse = false;
        this.txPool.release(tx);
    }
    start(tickMs, onTimeout) {
        if (this.timer)
            return;
        // Sub-ms polling via setInterval(1) + hrtime check; production can use
        // a dedicated worker with Atomics.wait timed wakes.
        this.timer = setInterval(() => this.scan(onTimeout), Math.max(1, tickMs));
        if (typeof this.timer === 'object' && 'unref' in this.timer) {
            this.timer.unref();
        }
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    get inFlight() {
        return this.active.size;
    }
}
/**
 * Ultra-cheap semantic router — keyword / digit scan without allocating
 * intermediate strings beyond the original prompt buffer view.
 */
export function routeCluster(prompt) {
    const len = prompt.length;
    let hasDigit = false;
    let hasMathOp = false;
    // scan once
    for (let i = 0; i < len; i++) {
        const c = prompt.charCodeAt(i);
        if (c >= 48 && c <= 57)
            hasDigit = true;
        else if (c === 43 || c === 45 || c === 42 || c === 47 || c === 61)
            hasMathOp = true;
    }
    if (hasDigit && hasMathOp)
        return 2 /* ClusterId.MATH */;
    // case-insensitive needle checks without toLowerCase() alloc of whole string
    if (includesInsensitive(prompt, 'math') || includesInsensitive(prompt, 'calc')) {
        return 2 /* ClusterId.MATH */;
    }
    if (includesInsensitive(prompt, 'code') || includesInsensitive(prompt, 'function')) {
        return 3 /* ClusterId.CODE */;
    }
    return 1 /* ClusterId.GENERAL */;
}
function includesInsensitive(hay, needle) {
    const nlen = needle.length;
    const hlen = hay.length;
    outer: for (let i = 0; i <= hlen - nlen; i++) {
        for (let j = 0; j < nlen; j++) {
            let a = hay.charCodeAt(i + j);
            let b = needle.charCodeAt(j);
            if (a >= 65 && a <= 90)
                a += 32;
            if (b >= 65 && b <= 90)
                b += 32;
            if (a !== b)
                continue outer;
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
export function createDynamicRouter(registry) {
    if (!registry)
        return routeCluster;
    return (prompt) => {
        // Try plugin registry first
        const pluginCluster = registry.route(prompt, -1);
        if (pluginCluster !== -1)
            return pluginCluster;
        // Fall back to static routing
        return routeCluster(prompt);
    };
}
//# sourceMappingURL=fault-tolerance.js.map