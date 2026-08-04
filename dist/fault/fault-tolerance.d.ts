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
export declare const TX_ACTIVE = 0;
export declare const TX_DONE = 1;
export declare const TX_FAILED = 2;
export declare const TX_FAILOVER = 3;
export declare function createTxPool(size: number): ObjectPool<InferenceTx>;
/**
 * fault-tolerance.ts — Shadow of Wisdom (Shadow Execution) + Divine Safeguard (Fault Protection)
 *
 * 同一計算を Primary Node と Shadow Node（Guardian Terminal）に同時送信し、
 * If now > start + (EWMA + margin), immediately fan-out the same binary tensor
 * to a shadow node — non-blocking, primary result wins (first RESULT completes).
 */
export declare class FaultToleranceEngine {
    private readonly pool;
    private readonly txPool;
    private readonly active;
    private readonly marginUs;
    private readonly shadowClusterId;
    private timer;
    private seqCounter;
    constructor(pool: IdleClusterPool, txPool: ObjectPool<InferenceTx>, opts?: {
        marginUs?: number;
        shadowClusterId?: number;
        tickMs?: number;
    });
    track(tx: InferenceTx): void;
    untrack(txId: bigint): InferenceTx | undefined;
    get(txId: bigint): InferenceTx | undefined;
    nextSeq(): number;
    /**
     * Allocate + arm a transaction against a primary node.
     */
    arm(txId: bigint, clusterId: number, primary: AkashaNodeRecord): InferenceTx;
    /**
     * Scan active txs; invoke onTimeout(tx, shadow) when deadline breached
     * and no shadow yet dispatched.
     */
    scan(onTimeout: (tx: InferenceTx, shadow: AkashaNodeRecord) => void): number;
    complete(txId: bigint, nodeId: bigint, latencyUs: number): InferenceTx | null;
    releaseTx(tx: InferenceTx): void;
    start(tickMs: number, onTimeout: (tx: InferenceTx, shadow: AkashaNodeRecord) => void): void;
    stop(): void;
    get inFlight(): number;
}
/**
 * Ultra-cheap semantic router — keyword / digit scan without allocating
 * intermediate strings beyond the original prompt buffer view.
 */
export declare function routeCluster(prompt: string): number;
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
export declare function createDynamicRouter(registry?: {
    route: (prompt: string, fallback: number) => number;
} | null): (prompt: string) => number;
//# sourceMappingURL=fault-tolerance.d.ts.map