import { AkashaOrchestrator } from './core/orchestrator.js';
import { AkashaEdgeNode } from './client/node-client.js';
import { BinaryCodec } from './binary/codec.js';
import { IdleClusterPool } from './structures/idle-cluster-pool.js';
import { SharedRingBuffer } from './ipc/ring-buffer.js';
import { ObjectPool, BufferPool } from './pool/object-pool.js';
import { FaultToleranceEngine, createTxPool, routeCluster } from './fault/fault-tolerance.js';
import { DoublyLinkedList } from './structures/doubly-linked-list.js';
import { HEADER_SIZE, MAGIC, PROTOCOL_VERSION, MAX_PACKET_BYTES } from './binary/protocol.js';
export { AkashaOrchestrator, AkashaEdgeNode, BinaryCodec, IdleClusterPool, SharedRingBuffer, ObjectPool, BufferPool, FaultToleranceEngine, createTxPool, routeCluster, DoublyLinkedList, HEADER_SIZE, MAGIC, PROTOCOL_VERSION, MAX_PACKET_BYTES, };
/** CLI entry: `npm run dev` */
async function main() {
    if (process.argv[1] && /index\.(js|ts)$/.test(process.argv[1])) {
        const orch = new AkashaOrchestrator({
            port: Number(process.env.AKASHA_PORT ?? 8080),
            onEvent: (ev) => {
                if (ev.type === 'dispatch') {
                    console.log(`⚡ [${ev.txId}] "${ev.prompt}" → ${ev.cluster} @ node ${ev.nodeId}`);
                }
                else if (ev.type === 'result') {
                    console.log(`✅ [${ev.txId}] node=${ev.nodeId} ${ev.latencyUs}μs sample=[${ev.sample.map((x) => x.toFixed(3)).join(', ')}]${ev.failover ? ' (via shadow)' : ''}`);
                }
                else if (ev.type === 'failover') {
                    console.log(`🛡️  failover tx=${ev.txId} primary=${ev.primary} → shadow=${ev.shadow}`);
                }
                else if (ev.type === 'register') {
                    console.log(`📱 node ${ev.nodeId} joined ${ev.cluster}`);
                }
                else if (ev.type === 'stats') {
                    console.log(`📊 nodes=${ev.nodes} inFlight=${ev.inFlight} idle[G/M/S]=${ev.idleGeneral}/${ev.idleMath}/${ev.idleShadow}`);
                }
                else if (ev.type === 'error') {
                    console.error('⚠️', ev.err);
                }
            },
        });
        await orch.start();
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map