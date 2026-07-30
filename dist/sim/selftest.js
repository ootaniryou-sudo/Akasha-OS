/**
 * Self-check for hot-path primitives (no network).
 * Run: npx tsx src/sim/selftest.ts
 */
import { BinaryCodec } from '../binary/codec.js';
import { HEADER_SIZE, MAGIC, nowUs } from '../binary/protocol.js';
import { IdleClusterPool, STATUS_COMPUTING } from '../structures/idle-cluster-pool.js';
import { SharedRingBuffer } from '../ipc/ring-buffer.js';
import { BufferPool, ObjectPool } from '../pool/object-pool.js';
import { routeCluster } from '../fault/fault-tolerance.js';
function assert(cond, msg) {
    if (!cond)
        throw new Error(msg);
}
const buf = new ArrayBuffer(HEADER_SIZE + 16);
const payload = new Float32Array([0.1, 0.2, 0.3, 0.4]);
const len = BinaryCodec.encode(buf, {
    command: 3 /* Cmd.COMPUTE_TASK */,
    flags: 0,
    txId: 42n,
    nodeId: 7n,
    clusterId: 2 /* ClusterId.MATH */,
    timestampUs: nowUs(),
    expectedUs: 5000,
    seq: 9,
    payload,
});
assert(len === HEADER_SIZE + 16, 'encode length');
const h = BinaryCodec.decodeHeader(buf, len);
assert(h.magic === MAGIC, 'magic');
assert(h.command === 3 /* Cmd.COMPUTE_TASK */, 'cmd');
assert(h.txId === 42n, 'tx');
assert(h.clusterId === 2 /* ClusterId.MATH */, 'cluster');
const view = BinaryCodec.payloadView(buf, h.payloadLen);
assert(Math.abs(view[2] - 0.3) < 1e-6, 'payload zero-copy');
const pool = new IdleClusterPool();
pool.register(1n, 2 /* ClusterId.MATH */, 1);
pool.register(2n, 2 /* ClusterId.MATH */, 2);
pool.register(3n, 1 /* ClusterId.GENERAL */, 3);
const a = pool.acquireIdle(2 /* ClusterId.MATH */);
assert(a && a.nodeId === 1n && a.status === STATUS_COMPUTING, 'FIFO idle');
const b = pool.acquireIdle(2 /* ClusterId.MATH */);
assert(b && b.nodeId === 2n, 'second idle');
assert(pool.acquireIdle(2 /* ClusterId.MATH */) === null, 'exhausted');
pool.releaseToIdle(1n);
const c = pool.acquireIdle(2 /* ClusterId.MATH */);
assert(c && c.nodeId === 1n, 'reacquired');
const ring = SharedRingBuffer.create({ slotSize: 256, slotCount: 8 });
const msg = new Uint8Array([1, 2, 3, 4, 5]);
assert(ring.tryPush(msg, msg.length), 'push');
const out = new Uint8Array(64);
assert(ring.tryPop(out) === 5, 'pop len');
assert(out[0] === 1 && out[4] === 5, 'pop data');
const op = new ObjectPool(() => ({ x: 0 }), (o) => { o.x = 0; }, 2, 4);
const o1 = op.acquire();
o1.x = 5;
op.release(o1);
assert(op.acquire().x === 0, 'pool reset');
const bp = new BufferPool(128, 2, 4);
const b1 = bp.acquire();
bp.release(b1);
assert(routeCluster('Solve 256 * 4') === 2 /* ClusterId.MATH */, 'route math');
assert(routeCluster('hello world') === 1 /* ClusterId.GENERAL */, 'route general');
assert(routeCluster('write a function please') === 3 /* ClusterId.CODE */, 'route code');
console.log('✅ selftest passed — binary / O(1) pool / ring / router OK');
//# sourceMappingURL=selftest.js.map