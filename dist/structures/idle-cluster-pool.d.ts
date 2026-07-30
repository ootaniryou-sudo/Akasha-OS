import { type DLLNode } from './doubly-linked-list.js';
export type NodeStatus = 0 | 1 | 2;
export declare const STATUS_IDLE: 0;
export declare const STATUS_COMPUTING: 1;
export declare const STATUS_OFFLINE: 2;
/**
 * Compact node record — numeric IDs only (no string allocs on hot path).
 * `socketSlot` indexes into the network worker's socket table.
 */
export interface AkashaNodeRecord {
    nodeId: bigint;
    clusterId: number;
    status: NodeStatus;
    socketSlot: number;
    lastHeartbeatUs: bigint;
    /** EWMA latency in microseconds */
    ewmaLatencyUs: number;
    /** sample count for EWMA warm-up */
    latencySamples: number;
    /** intrusive list handle when IDLE */
    idleLink: DLLNode<bigint> | null;
    /** paired shadow node in same room / fat-tree leaf */
    shadowNodeId: bigint;
}
/**
 * O(1) cluster idle pool:
 *  - HashMap<nodeId, record>         → O(1) lookup
 *  - HashMap<clusterId, DLL>         → O(1) pick idle head
 *  - Intrusive DLL splice            → O(1) mark busy / free
 */
export declare class IdleClusterPool {
    private readonly nodes;
    private readonly idleByCluster;
    private readonly linkPool;
    constructor(linkPoolSize?: number);
    private key;
    private listFor;
    register(nodeId: bigint, clusterId: number, socketSlot: number, shadowNodeId?: bigint): AkashaNodeRecord;
    get(nodeId: bigint): AkashaNodeRecord | undefined;
    /** O(1) — dequeue an IDLE node from the cluster FIFO. */
    acquireIdle(clusterId: number): AkashaNodeRecord | null;
    /** O(1) — return node to idle list after RESULT / cancel. */
    releaseToIdle(nodeId: bigint): void;
    markOffline(nodeId: bigint): void;
    updateHeartbeat(nodeId: bigint, us: bigint): void;
    /**
     * EWMA update: α = 0.2. Used by sliding-window fault tolerance.
     */
    observeLatency(nodeId: bigint, latencyUs: number): number;
    /** Deadline = EWMA + marginUs (default +2000μs = +2ms). */
    deadlineUs(nodeId: bigint, marginUs?: number): number;
    idleCount(clusterId: number): number;
    get size(): number;
    /** Pick shadow: explicit pairing, else another idle in SHADOW_POOL / same cluster. */
    acquireShadow(primary: AkashaNodeRecord, shadowClusterId: number): AkashaNodeRecord | null;
    private markIdle;
}
//# sourceMappingURL=idle-cluster-pool.d.ts.map