import { DoublyLinkedList, type DLLNode } from './doubly-linked-list.js';
import { ObjectPool } from '../pool/object-pool.js';

export type NodeStatus = 0 | 1 | 2; // IDLE | COMPUTING | OFFLINE
export const STATUS_IDLE = 0 as const;
export const STATUS_COMPUTING = 1 as const;
export const STATUS_OFFLINE = 2 as const;

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
export class IdleClusterPool {
  private readonly nodes = new Map<string, AkashaNodeRecord>();
  private readonly idleByCluster = new Map<number, DoublyLinkedList<bigint>>();
  private readonly linkPool: ObjectPool<DLLNode<bigint>>;

  constructor(linkPoolSize = 65_536) {
    this.linkPool = new ObjectPool<DLLNode<bigint>>(
      () => ({ value: 0n, prev: null, next: null }),
      (n) => {
        n.value = 0n;
        n.prev = null;
        n.next = null;
      },
      Math.min(1024, linkPoolSize),
      linkPoolSize,
    );
  }

  private key(nodeId: bigint): string {
    return nodeId.toString();
  }

  private listFor(clusterId: number): DoublyLinkedList<bigint> {
    let list = this.idleByCluster.get(clusterId);
    if (!list) {
      list = new DoublyLinkedList<bigint>();
      this.idleByCluster.set(clusterId, list);
    }
    return list;
  }

  register(
    nodeId: bigint,
    clusterId: number,
    socketSlot: number,
    shadowNodeId = 0n,
  ): AkashaNodeRecord {
    const existing = this.nodes.get(this.key(nodeId));
    if (existing) {
      this.markOffline(nodeId);
    }
    const rec: AkashaNodeRecord = {
      nodeId,
      clusterId,
      status: STATUS_IDLE,
      socketSlot,
      lastHeartbeatUs: 0n,
      ewmaLatencyUs: 5_000, // 5ms default seed
      latencySamples: 0,
      idleLink: null,
      shadowNodeId,
    };
    this.nodes.set(this.key(nodeId), rec);
    this.markIdle(rec);
    return rec;
  }

  get(nodeId: bigint): AkashaNodeRecord | undefined {
    return this.nodes.get(this.key(nodeId));
  }

  /** O(1) — dequeue an IDLE node from the cluster FIFO. */
  acquireIdle(clusterId: number): AkashaNodeRecord | null {
    const list = this.idleByCluster.get(clusterId);
    if (!list || list.length === 0) return null;
    const link = list.popHead();
    if (!link) return null;
    const rec = this.nodes.get(this.key(link.value));
    this.linkPool.release(link);
    if (!rec || rec.status !== STATUS_IDLE) return this.acquireIdle(clusterId);
    rec.idleLink = null;
    rec.status = STATUS_COMPUTING;
    return rec;
  }

  /** O(1) — return node to idle list after RESULT / cancel. */
  releaseToIdle(nodeId: bigint): void {
    const rec = this.nodes.get(this.key(nodeId));
    if (!rec || rec.status === STATUS_OFFLINE) return;
    if (rec.status === STATUS_IDLE && rec.idleLink) return;
    rec.status = STATUS_IDLE;
    this.markIdle(rec);
  }

  markOffline(nodeId: bigint): void {
    const rec = this.nodes.get(this.key(nodeId));
    if (!rec) return;
    if (rec.idleLink) {
      const list = this.listFor(rec.clusterId);
      list.remove(rec.idleLink);
      this.linkPool.release(rec.idleLink);
      rec.idleLink = null;
    }
    rec.status = STATUS_OFFLINE;
    this.nodes.delete(this.key(nodeId));
  }

  updateHeartbeat(nodeId: bigint, us: bigint): void {
    const rec = this.nodes.get(this.key(nodeId));
    if (rec) rec.lastHeartbeatUs = us;
  }

  /**
   * EWMA update: α = 0.2. Used by sliding-window fault tolerance.
   */
  observeLatency(nodeId: bigint, latencyUs: number): number {
    const rec = this.nodes.get(this.key(nodeId));
    if (!rec) return latencyUs;
    const alpha = 0.2;
    if (rec.latencySamples === 0) {
      rec.ewmaLatencyUs = latencyUs;
    } else {
      rec.ewmaLatencyUs = alpha * latencyUs + (1 - alpha) * rec.ewmaLatencyUs;
    }
    rec.latencySamples++;
    return rec.ewmaLatencyUs;
  }

  /** Deadline = EWMA + marginUs (default +2000μs = +2ms). */
  deadlineUs(nodeId: bigint, marginUs = 2000): number {
    const rec = this.nodes.get(this.key(nodeId));
    if (!rec) return 10_000 + marginUs;
    return Math.ceil(rec.ewmaLatencyUs + marginUs);
  }

  idleCount(clusterId: number): number {
    return this.idleByCluster.get(clusterId)?.length ?? 0;
  }

  get size(): number {
    return this.nodes.size;
  }

  /** Pick shadow: explicit pairing, else another idle in SHADOW_POOL / same cluster. */
  acquireShadow(primary: AkashaNodeRecord, shadowClusterId: number): AkashaNodeRecord | null {
    if (primary.shadowNodeId !== 0n) {
      const shadow = this.nodes.get(this.key(primary.shadowNodeId));
      if (shadow && shadow.status === STATUS_IDLE) {
        if (shadow.idleLink) {
          this.listFor(shadow.clusterId).remove(shadow.idleLink);
          this.linkPool.release(shadow.idleLink);
          shadow.idleLink = null;
        }
        shadow.status = STATUS_COMPUTING;
        return shadow;
      }
    }
    return this.acquireIdle(shadowClusterId) ?? this.acquireIdle(primary.clusterId);
  }

  private markIdle(rec: AkashaNodeRecord): void {
    if (rec.idleLink) return;
    const link = this.linkPool.acquire();
    link.value = rec.nodeId;
    link.prev = null;
    link.next = null;
    rec.idleLink = link;
    this.listFor(rec.clusterId).pushTail(link);
  }
}
