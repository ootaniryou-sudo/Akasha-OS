import { DoublyLinkedList } from './doubly-linked-list.js';
import { ObjectPool } from '../pool/object-pool.js';
export const STATUS_IDLE = 0;
export const STATUS_COMPUTING = 1;
export const STATUS_OFFLINE = 2;
/**
 * O(1) cluster idle pool:
 *  - HashMap<nodeId, record>         → O(1) lookup
 *  - HashMap<clusterId, DLL>         → O(1) pick idle head
 *  - Intrusive DLL splice            → O(1) mark busy / free
 */
export class IdleClusterPool {
    nodes = new Map();
    idleByCluster = new Map();
    linkPool;
    constructor(linkPoolSize = 65_536) {
        this.linkPool = new ObjectPool(() => ({ value: 0n, prev: null, next: null }), (n) => {
            n.value = 0n;
            n.prev = null;
            n.next = null;
        }, Math.min(1024, linkPoolSize), linkPoolSize);
    }
    key(nodeId) {
        return nodeId.toString();
    }
    listFor(clusterId) {
        let list = this.idleByCluster.get(clusterId);
        if (!list) {
            list = new DoublyLinkedList();
            this.idleByCluster.set(clusterId, list);
        }
        return list;
    }
    register(nodeId, clusterId, socketSlot, shadowNodeId = 0n) {
        const existing = this.nodes.get(this.key(nodeId));
        if (existing) {
            this.markOffline(nodeId);
        }
        const rec = {
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
    get(nodeId) {
        return this.nodes.get(this.key(nodeId));
    }
    /** O(1) — dequeue an IDLE node from the cluster FIFO. */
    acquireIdle(clusterId) {
        const list = this.idleByCluster.get(clusterId);
        if (!list || list.length === 0)
            return null;
        const link = list.popHead();
        if (!link)
            return null;
        const rec = this.nodes.get(this.key(link.value));
        this.linkPool.release(link);
        if (!rec || rec.status !== STATUS_IDLE)
            return this.acquireIdle(clusterId);
        rec.idleLink = null;
        rec.status = STATUS_COMPUTING;
        return rec;
    }
    /** O(1) — return node to idle list after RESULT / cancel. */
    releaseToIdle(nodeId) {
        const rec = this.nodes.get(this.key(nodeId));
        if (!rec || rec.status === STATUS_OFFLINE)
            return;
        if (rec.status === STATUS_IDLE && rec.idleLink)
            return;
        rec.status = STATUS_IDLE;
        this.markIdle(rec);
    }
    markOffline(nodeId) {
        const rec = this.nodes.get(this.key(nodeId));
        if (!rec)
            return;
        if (rec.idleLink) {
            const list = this.listFor(rec.clusterId);
            list.remove(rec.idleLink);
            this.linkPool.release(rec.idleLink);
            rec.idleLink = null;
        }
        rec.status = STATUS_OFFLINE;
        this.nodes.delete(this.key(nodeId));
    }
    updateHeartbeat(nodeId, us) {
        const rec = this.nodes.get(this.key(nodeId));
        if (rec)
            rec.lastHeartbeatUs = us;
    }
    /**
     * EWMA update: α = 0.2. Used by sliding-window fault tolerance.
     */
    observeLatency(nodeId, latencyUs) {
        const rec = this.nodes.get(this.key(nodeId));
        if (!rec)
            return latencyUs;
        const alpha = 0.2;
        if (rec.latencySamples === 0) {
            rec.ewmaLatencyUs = latencyUs;
        }
        else {
            rec.ewmaLatencyUs = alpha * latencyUs + (1 - alpha) * rec.ewmaLatencyUs;
        }
        rec.latencySamples++;
        return rec.ewmaLatencyUs;
    }
    /** Deadline = EWMA + marginUs (default +2000μs = +2ms). */
    deadlineUs(nodeId, marginUs = 2000) {
        const rec = this.nodes.get(this.key(nodeId));
        if (!rec)
            return 10_000 + marginUs;
        return Math.ceil(rec.ewmaLatencyUs + marginUs);
    }
    idleCount(clusterId) {
        return this.idleByCluster.get(clusterId)?.length ?? 0;
    }
    get size() {
        return this.nodes.size;
    }
    /** Pick shadow: explicit pairing, else another idle in SHADOW_POOL / same cluster. */
    acquireShadow(primary, shadowClusterId) {
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
    markIdle(rec) {
        if (rec.idleLink)
            return;
        const link = this.linkPool.acquire();
        link.value = rec.nodeId;
        link.prev = null;
        link.next = null;
        rec.idleLink = link;
        this.listFor(rec.clusterId).pushTail(link);
    }
}
//# sourceMappingURL=idle-cluster-pool.js.map