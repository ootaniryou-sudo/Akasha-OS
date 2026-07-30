/**
 * End-to-end mesh simulation:
 *  - Boots Akasha OS (network worker + router worker)
 *  - Connects math / general / shadow edge nodes over binary WebSocket
 *  - Submits a math prompt
 *  - Optionally demonstrates shadow failover with a blackhole primary
 */
import WebSocket from 'ws';
import { AkashaOrchestrator } from '../core/orchestrator.js';
import { AkashaEdgeNode } from '../client/node-client.js';
const PORT = Number(process.env.AKASHA_PORT ?? 8080);
const DEMO_FAILOVER = process.env.AKASHA_DEMO_FAILOVER === '1';
async function main() {
    const orch = new AkashaOrchestrator({
        port: PORT,
        faultTickMs: 1,
        marginUs: DEMO_FAILOVER ? 500 : 2_000, // tight budget to force failover in demo
        onEvent: (ev) => {
            switch (ev.type) {
                case 'ready':
                    console.log(`📡 listening :${ev.port}`);
                    break;
                case 'register':
                    console.log(`📱 Node [${ev.nodeId}] → Cluster [${ev.cluster}]`);
                    break;
                case 'dispatch':
                    console.log(`\n🔮 Task [${ev.txId}]: "${ev.prompt}" → [${ev.cluster}] @ ${ev.nodeId}`);
                    break;
                case 'failover':
                    console.log(`🛡️  Shadow failover [${ev.txId}]: ${ev.primary} → ${ev.shadow}`);
                    break;
                case 'result':
                    console.log(`✅ [${ev.txId}] by ${ev.nodeId} in ${ev.latencyUs}μs | [${ev.sample.map((x) => x.toFixed(4)).join(', ')}...]${ev.failover ? ' [SHADOW]' : ''}`);
                    break;
                case 'queue':
                    console.log(`⚠️  Cluster [${ev.cluster}] saturated — queued`);
                    break;
                case 'stats':
                    console.log(`📊 mesh nodes=${ev.nodes} inFlight=${ev.inFlight} idle G/M/S=${ev.idleGeneral}/${ev.idleMath}/${ev.idleShadow}`);
                    break;
                case 'error':
                    console.error('⚠️', ev.err);
                    break;
                default:
                    break;
            }
        },
    });
    await orch.start();
    const url = `ws://127.0.0.1:${PORT}`;
    // `ws` constructor is compatible with our WsConstructor surface
    const WS = WebSocket;
    const mathPrimary = new AkashaEdgeNode({
        url,
        nodeId: 1001n,
        clusterId: 2 /* ClusterId.MATH */,
        shadowNodeId: 1099n,
        simulateLatencyMs: DEMO_FAILOVER ? 50 : 2,
        blackhole: DEMO_FAILOVER,
        WebSocketImpl: WS,
    });
    const mathShadow = new AkashaEdgeNode({
        url,
        nodeId: 1099n,
        clusterId: 99 /* ClusterId.SHADOW_POOL */,
        simulateLatencyMs: 3,
        WebSocketImpl: WS,
    });
    const general = new AkashaEdgeNode({
        url,
        nodeId: 2001n,
        clusterId: 1 /* ClusterId.GENERAL */,
        simulateLatencyMs: 2,
        WebSocketImpl: WS,
    });
    const mathSpare = new AkashaEdgeNode({
        url,
        nodeId: 1002n,
        clusterId: 2 /* ClusterId.MATH */,
        simulateLatencyMs: 2,
        WebSocketImpl: WS,
    });
    await Promise.all([
        mathPrimary.connect(),
        mathShadow.connect(),
        general.connect(),
        mathSpare.connect(),
    ]);
    console.log('🕸️  Edge mesh online — submitting inference…');
    await sleep(200);
    orch.submitPrompt('Solve this expression: 256 * 4 + 12', new Float32Array([0.12, -0.45, 0.89, 0.33, 1.02, -0.77]));
    await sleep(DEMO_FAILOVER ? 2000 : 800);
    await orch.stop();
    mathPrimary.close();
    mathShadow.close();
    general.close();
    mathSpare.close();
    console.log('⏻ Akasha demo complete.');
    process.exit(0);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=demo.js.map