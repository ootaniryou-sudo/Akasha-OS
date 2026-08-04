import { AkashaOrchestrator } from './core/orchestrator.js';
import { AkashaInferenceLoop } from './core/inference-loop.js';
import { LogitTournament, HubAggregator, MasterSampler } from './core/logit-aggregator.js';
import { ShardAllocator } from './core/shard-allocator.js';
import { TorrentDistributor, StreamPipe, ChunkScheduler } from './core/torrent-distributor.js';
import { NicMonitor, ClusterHandover, EmergencyDisconnect } from './core/cluster-guardian.js';
import { ModelCache } from './core/model-cache.js';
import { AkashaRouter } from './core/router.js';
import { QwenAdapter } from './llm/adapters/qwen.js';
import { InMemoryConversationStore, InMemoryPrefixCache } from './memory/store.js';
import { ContextManager, hashTokenIds } from './memory/context.js';
import { ExperimentLogger } from './experiments/logger.js';
import { AkashaBootstrapper } from './bootstrap/akasha-bootstrapper.js';
import { AkashaEdgeNode } from './client/node-client.js';
import { BinaryCodec } from './binary/codec.js';
import { IdleClusterPool } from './structures/idle-cluster-pool.js';
import { SharedRingBuffer } from './ipc/ring-buffer.js';
import { ObjectPool, BufferPool } from './pool/object-pool.js';
import { FaultToleranceEngine, createTxPool, routeCluster, createDynamicRouter } from './fault/fault-tolerance.js';
import { DoublyLinkedList } from './structures/doubly-linked-list.js';
import { HEADER_SIZE, MAGIC, PROTOCOL_VERSION, MAX_PACKET_BYTES, EX_HEADER_SIZE, decodeExtendedHeader, fletcher32 } from './binary/protocol.js';
import { PluginRegistry } from './plugin/registry.js';
import { isLifecyclePlugin } from './plugin/types.js';
export { AkashaOrchestrator, AkashaInferenceLoop, LogitTournament, HubAggregator, MasterSampler, ShardAllocator, TorrentDistributor, StreamPipe, ChunkScheduler, NicMonitor, ClusterHandover, EmergencyDisconnect, ModelCache, AkashaRouter, QwenAdapter, InMemoryConversationStore, InMemoryPrefixCache, ContextManager, ExperimentLogger, hashTokenIds, AkashaBootstrapper, AkashaEdgeNode, BinaryCodec, IdleClusterPool, SharedRingBuffer, ObjectPool, BufferPool, FaultToleranceEngine, createTxPool, routeCluster, createDynamicRouter, PluginRegistry, isLifecyclePlugin, DoublyLinkedList, HEADER_SIZE, MAGIC, PROTOCOL_VERSION, MAX_PACKET_BYTES, EX_HEADER_SIZE, decodeExtendedHeader, fletcher32, };
export { SHARD_TYPE_NAMES, layerBytes, totalModelBytes, buildNodeToShards, shardsForNode } from './core/shard-allocator.js';
export { crc32, buildDistributionTree, DEFAULT_CHUNK_SIZE } from './core/torrent-distributor.js';
export { uploadToWebGPU, streamToWebGPU } from './core/model-cache.js';
// ═════════════════════════════════════════════════════════════════════════════
// Akasha-OS Master Entry Point — WebTransport / QUIC receiver
// ═════════════════════════════════════════════════════════════════════════════
import http from 'node:http';
/** Circular buffer of recent latency metrics (for Prometheus/CSV export). */
class MetricsRing {
    ring;
    cursor = 0;
    max;
    constructor(maxEntries = 1024) {
        this.max = maxEntries;
        this.ring = new Array(maxEntries);
    }
    push(m) {
        this.ring[this.cursor % this.max] = m;
        this.cursor++;
    }
    /** Export as Prometheus text format. */
    prometheus() {
        const lines = [
            '# HELP akasha_latency_us Round-trip latency in microseconds',
            '# TYPE akasha_latency_us histogram',
        ];
        const count = Math.min(this.cursor, this.max);
        for (let i = 0; i < count; i++) {
            const m = this.ring[i];
            if (!m)
                continue;
            const latency = Number(m.recvTimeUs - m.sendTimeUs);
            lines.push(`akasha_latency_us{tx="${m.txId}",layer="${m.layerId}",node="${m.nodeId}"} ${latency}`);
        }
        lines.push(`# HELP akasha_packets_total Total datagrams received`);
        lines.push(`# TYPE akasha_packets_total counter`);
        lines.push(`akasha_packets_total ${this.cursor}`);
        return lines.join('\n') + '\n';
    }
    /** Export as CSV. */
    csv() {
        const lines = ['txId,layerId,nodeId,sendUs,recvUs,latencyUs,payloadBytes'];
        const count = Math.min(this.cursor, this.max);
        for (let i = 0; i < count; i++) {
            const m = this.ring[i];
            if (!m)
                continue;
            const lat = Number(m.recvTimeUs - m.sendTimeUs);
            lines.push(`${m.txId},${m.layerId},${m.nodeId},${m.sendTimeUs},${m.recvTimeUs},${lat},${m.payloadBytes}`);
        }
        return lines.join('\n') + '\n';
    }
}
/** O(1) sequence number tracker per txId → expected next seq. */
class SeqTracker {
    expected = new Map();
    outOfOrder = 0;
    /**
     * Validate a sequence number. Returns true if the packet should be processed.
     * Detects: duplicate (same seq), out-of-order (seq < expected), gap (seq > expected).
     */
    validate(txId, seq) {
        const exp = this.expected.get(txId) ?? 0;
        if (seq < exp)
            return 'duplicate';
        if (seq > exp) {
            this.outOfOrder++;
            // Accept gaps but log them (QUIC handles reordering at transport layer)
        }
        this.expected.set(txId, seq + 1);
        return 'ok';
    }
    get outOfOrderCount() { return this.outOfOrder; }
    /** Cleanup old txIds (call periodically). */
    gc(_maxAge = 60_000) {
        // Simple: keep last 1000 txIds
        if (this.expected.size > 1000) {
            const keys = [...this.expected.keys()];
            for (let i = 0; i < keys.length - 1000; i++) {
                this.expected.delete(keys[i]);
            }
        }
    }
}
/** CLI entry — start the master with WebTransport receiver. */
async function main() {
    if (!process.argv[1] || !/index\.(js|ts)$/.test(process.argv[1]))
        return;
    const port = Number(process.env.AKASHA_PORT ?? 8080);
    const metricsPort = Number(process.env.AKASHA_METRICS_PORT ?? 9090);
    const metrics = new MetricsRing(4096);
    const seqTracker = new SeqTracker();
    // ── Core subsystems ──────────────────────────────────────────────────
    const router = new AkashaRouter({
        port,
        maxRegistrationsPerSec: Number(process.env.AKASHA_MAX_REG_SEC ?? '200'),
        hubIds: (process.env.AKASHA_HUB_IDS ?? '1,2,3,4').split(',').map(Number),
    });
    router.setSend((_slot, _buf, _len) => {
        // In production: SharedArrayBuffer ring → network worker → WebSocket/QUIC
    });
    router.start();
    // ── Prometheus metrics HTTP endpoint ──────────────────────────────────
    const metricsServer = http.createServer((_req, res) => {
        const accept = _req.headers.accept ?? '';
        if (accept.includes('text/csv')) {
            res.writeHead(200, { 'Content-Type': 'text/csv' });
            res.end(metrics.csv());
        }
        else {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(metrics.prometheus());
        }
    });
    metricsServer.listen(metricsPort, () => {
        console.log(`📊 Metrics exporter on :${metricsPort} (Prometheus /metrics, CSV /metrics?accept=text/csv)`);
    });
    // ── WebTransport / WebSocket gateway ──────────────────────────────────
    console.log(`
  ╔══════════════════════════════════════════════╗
  ║         Akasha-OS Master v1.0                ║
  ║  Protocol: 48B header + 36B ext. header      ║
  ║  Transport: WebSocket (→ QUIC ready)         ║
  ║  Checksum: Fletcher32 (O(N), inline)         ║
  ║  Seq validation: O(1) per txId              ║
  ║  Metrics: Prometheus :${String(metricsPort).padEnd(21)}║
  ╚══════════════════════════════════════════════╝
  `);
    // Start the legacy orchestrator (WebSocket-based)
    const orch = new AkashaOrchestrator({
        port,
        onEvent: (ev) => {
            const ts = process.hrtime.bigint();
            switch (ev.type) {
                case 'dispatch':
                    console.log(`⚡ [${ev.txId}] "${ev.prompt.slice(0, 40)}" → ${ev.cluster} @ node ${ev.nodeId}`);
                    break;
                case 'result': {
                    const latencyUs = ev.latencyUs;
                    metrics.push({
                        txId: ev.txId,
                        sendTimeUs: ts,
                        recvTimeUs: ts + BigInt(latencyUs),
                        layerId: 0,
                        nodeId: ev.nodeId,
                        payloadBytes: 0,
                    });
                    console.log(`✅ [${ev.txId}] node=${ev.nodeId} ${latencyUs}μs${ev.failover ? ' (shadow)' : ''}`);
                    break;
                }
                case 'failover':
                    console.log(`🛡️  failover tx=${ev.txId} primary=${ev.primary} → shadow=${ev.shadow}`);
                    break;
                case 'register':
                    console.log(`📱 node ${ev.nodeId} joined ${ev.cluster}`);
                    break;
                case 'stats':
                    console.log(`📊 nodes=${ev.nodes} inFlight=${ev.inFlight} idle[G/M/S]=${ev.idleGeneral}/${ev.idleMath}/${ev.idleShadow}`);
                    break;
                case 'error':
                    console.error('⚠️', ev.err);
                    break;
            }
        },
    });
    await orch.start();
    // ── Periodic cleanup ──────────────────────────────────────────────────
    setInterval(() => {
        seqTracker.gc();
        router.handover.gc(60_000);
    }, 30_000).unref();
    // ── Graceful shutdown ─────────────────────────────────────────────────
    process.on('SIGINT', () => {
        console.log('\n⬡ Shutting down...');
        router.stop();
        metricsServer.close();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        router.stop();
        metricsServer.close();
        process.exit(0);
    });
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map