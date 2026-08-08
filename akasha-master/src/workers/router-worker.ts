/**
 * Router worker — semantic routing, O(1) dispatch, fault tolerance.
 * Communicates with the network worker exclusively via SharedArrayBuffer rings.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { SharedRingBuffer, IpcKind } from '../ipc/ring-buffer.js';
import { BinaryCodec, buildComputeHeader } from '../binary/codec.js';
import {
  Cmd,
  ClusterId,
  Flag,
  HEADER_SIZE,
  MAX_PACKET_BYTES,
  clusterName,
  nowUs,
} from '../binary/protocol.js';
import { BufferPool } from '../pool/object-pool.js';
import { IdleClusterPool } from '../structures/idle-cluster-pool.js';
import {
  FaultToleranceEngine,
  createTxPool,
  routeCluster,
  type InferenceTx,
} from '../fault/fault-tolerance.js';
import type { AkashaNodeRecord } from '../structures/idle-cluster-pool.js';

interface RouterWorkerData {
  inboundSab: SharedArrayBuffer;
  outboundSab: SharedArrayBuffer;
  controlSab: SharedArrayBuffer;
  slotSize: number;
  slotCount: number;
  controlSlotSize: number;
  controlSlotCount: number;
  faultTickMs: number;
  marginUs: number;
}

const data = workerData as RouterWorkerData;

const inbound = new SharedRingBuffer(data.inboundSab, {
  slotSize: data.slotSize,
  slotCount: data.slotCount,
});
const outbound = new SharedRingBuffer(data.outboundSab, {
  slotSize: data.slotSize,
  slotCount: data.slotCount,
});
/** Main thread → router (submit prompt / admin). */
const control = new SharedRingBuffer(data.controlSab, {
  slotSize: data.controlSlotSize,
  slotCount: data.controlSlotCount,
});

const nodePool = new IdleClusterPool();
const txPool = createTxPool(16_384);
const fault = new FaultToleranceEngine(nodePool, txPool, {
  marginUs: data.marginUs,
  shadowClusterId: ClusterId.SHADOW_POOL,
});

const bufPool = new BufferPool(MAX_PACKET_BYTES, 512, 8192);
const scratchIn = new Uint8Array(MAX_PACKET_BYTES + 16);
const scratchCtrl = new Uint8Array(data.controlSlotSize);
/** socketSlot → nodeId */
const slotToNode = new Map<number, bigint>();
/** Cached activation vectors for in-flight failover (txId → pooled buffer view). */
const activationCache = new Map<string, { buf: ArrayBuffer; floats: number }>();

let txIdCounter = 1n;

function nextTxId(): bigint {
  txIdCounter += 1n;
  return (BigInt(Date.now()) << 20n) ^ txIdCounter;
}

function sendToSlot(socketSlot: number, packetBuf: ArrayBuffer, packetLen: number): boolean {
  const frame = bufPool.acquire();
  const u8 = new Uint8Array(frame);
  u8[0] = IpcKind.OUTBOUND_PACKET;
  new DataView(frame).setUint32(1, socketSlot, true);
  u8.set(new Uint8Array(packetBuf, 0, packetLen), 5);
  const len = 5 + packetLen;
  let ok = outbound.tryPush(u8.subarray(0, len), len);
  if (!ok) {
    outbound.waitForSpace(5);
    ok = outbound.tryPush(u8.subarray(0, len), len);
  }
  bufPool.release(frame);
  return ok;
}

function dispatchCompute(
  tx: InferenceTx,
  node: AkashaNodeRecord,
  activation: Float32Array,
  flags: number,
): void {
  const expectedUs = nodePool.deadlineUs(node.nodeId, data.marginUs);
  const buf = bufPool.acquire();
  const header = buildComputeHeader(
    tx.txId,
    node.nodeId,
    tx.clusterId,
    nowUs(),
    expectedUs,
    tx.seq,
    flags,
  );
  const len = BinaryCodec.encode(buf, { ...header, payload: activation });
  sendToSlot(node.socketSlot, buf, len);
  bufPool.release(buf);
}

function cacheActivation(txId: bigint, activation: Float32Array): void {
  const ab = bufPool.acquire();
  const dest = new Float32Array(ab, 0, activation.length);
  dest.set(activation);
  activationCache.set(txId.toString(), { buf: ab, floats: activation.length });
}

function getCachedActivation(txId: bigint): Float32Array | null {
  const entry = activationCache.get(txId.toString());
  if (!entry) return null;
  return new Float32Array(entry.buf, 0, entry.floats);
}

function dropActivation(txId: bigint): void {
  const key = txId.toString();
  const entry = activationCache.get(key);
  if (entry) {
    bufPool.release(entry.buf);
    activationCache.delete(key);
  }
}

function handleRegister(header: ReturnType<typeof BinaryCodec.decodeHeader>, socketSlot: number): void {
  const shadow =
    header.flags !== 0 && header.seq !== 0 ? BigInt(header.seq) : 0n; // seq may carry shadow hint
  nodePool.register(header.nodeId, header.clusterId, socketSlot, shadow);
  slotToNode.set(socketSlot, header.nodeId);
  nodePool.updateHeartbeat(header.nodeId, nowUs());
  parentPort?.postMessage({
    type: 'register',
    nodeId: header.nodeId.toString(),
    clusterId: header.clusterId,
    cluster: clusterName(header.clusterId),
  });
}

function handleResult(
  header: ReturnType<typeof BinaryCodec.decodeHeader>,
  buf: ArrayBuffer,
): void {
  const latencyUs = Number(nowUs() - header.timestampUs);
  const tx = fault.complete(header.txId, header.nodeId, latencyUs > 0 ? latencyUs : 1);
  if (!tx) {
    // Duplicate (losing shadow/primary) — still free the node
    nodePool.releaseToIdle(header.nodeId);
    return;
  }
  const payload = BinaryCodec.payloadView(buf, header.payloadLen);
  const sample = payload.length >= 3
    ? [payload[0], payload[1], payload[2]]
    : Array.from(payload);

  parentPort?.postMessage({
    type: 'result',
    txId: header.txId.toString(),
    nodeId: header.nodeId.toString(),
    latencyUs,
    sample,
    failover: tx.shadowNodeId !== 0n,
  });

  dropActivation(header.txId);
  fault.releaseTx(tx);
}

function handleInboundPacket(frame: Uint8Array, len: number): void {
  const socketSlot = new DataView(frame.buffer, frame.byteOffset, len).getUint32(1, true);
  const packetBytes = len - 5;
  const packetBuf = bufPool.acquire();
  new Uint8Array(packetBuf).set(frame.subarray(5, len));
  try {
    const header = BinaryCodec.decodeHeader(packetBuf, packetBytes);
    switch (header.command) {
      case Cmd.REGISTER:
        handleRegister(header, socketSlot);
        break;
      case Cmd.HEARTBEAT:
        nodePool.updateHeartbeat(header.nodeId, nowUs());
        break;
      case Cmd.RESULT:
        handleResult(header, packetBuf);
        break;
      default:
        break;
    }
  } finally {
    bufPool.release(packetBuf);
  }
}

function handleNodeGone(frame: Uint8Array): void {
  const socketSlot = new DataView(frame.buffer, frame.byteOffset, 5).getUint32(1, true);
  const nodeId = slotToNode.get(socketSlot);
  if (nodeId !== undefined) {
    nodePool.markOffline(nodeId);
    slotToNode.delete(socketSlot);
    parentPort?.postMessage({ type: 'node_gone', nodeId: nodeId.toString() });
  }
}

/** Control plane: submit prompt from main thread. */
function handleSubmitPrompt(frame: Uint8Array, len: number): void {
  // [u8 kind][u32 promptByteLen][utf8 prompt][u32 floatCount][f32...]
  const dv = new DataView(frame.buffer, frame.byteOffset, len);
  const promptLen = dv.getUint32(1, true);
  const prompt = new TextDecoder().decode(frame.subarray(5, 5 + promptLen));
  const floatCount = dv.getUint32(5 + promptLen, true);
  const actOffset = 5 + promptLen + 4;
  const activation = new Float32Array(
    frame.buffer,
    frame.byteOffset + actOffset,
    floatCount,
  );

  const clusterId = routeCluster(prompt);
  const node = nodePool.acquireIdle(clusterId);
  if (!node) {
    parentPort?.postMessage({
      type: 'queue',
      reason: 'saturated',
      clusterId,
      cluster: clusterName(clusterId),
    });
    return;
  }

  const txId = nextTxId();
  const tx = fault.arm(txId, clusterId, node);
  // copy activation for potential failover
  const owned = new Float32Array(activation.length);
  owned.set(activation);
  cacheActivation(txId, owned);

  dispatchCompute(tx, node, owned, Flag.NONE);
  parentPort?.postMessage({
    type: 'dispatch',
    txId: txId.toString(),
    nodeId: node.nodeId.toString(),
    clusterId,
    cluster: clusterName(clusterId),
    prompt,
  });
}

function onFaultTimeout(tx: InferenceTx, shadow: AkashaNodeRecord): void {
  const act = getCachedActivation(tx.txId);
  if (!act) return;
  dispatchCompute(tx, shadow, act, Flag.SHADOW);
  parentPort?.postMessage({
    type: 'failover',
    txId: tx.txId.toString(),
    primary: tx.primaryNodeId.toString(),
    shadow: shadow.nodeId.toString(),
  });
}

fault.start(data.faultTickMs, onFaultTimeout);

function drainInbound(): void {
  for (;;) {
    const n = inbound.tryPop(scratchIn);
    if (n < 0) break;
    const kind = scratchIn[0] as IpcKind;
    if (kind === IpcKind.INBOUND_PACKET) handleInboundPacket(scratchIn, n);
    else if (kind === IpcKind.NODE_GONE) handleNodeGone(scratchIn);
  }
}

function drainControl(): void {
  for (;;) {
    const n = control.tryPop(scratchCtrl);
    if (n < 0) break;
    const kind = scratchCtrl[0] as IpcKind;
    if (kind === IpcKind.SUBMIT_PROMPT) handleSubmitPrompt(scratchCtrl, n);
  }
}

function loop(): void {
  drainInbound();
  drainControl();
  if (inbound.available === 0 && control.available === 0) {
    // wait on whichever may wake first — prefer inbound
    inbound.waitForData(1);
  }
  setImmediate(loop);
}

parentPort?.postMessage({
  type: 'ready',
  nodes: 0,
  headerSize: HEADER_SIZE,
});
loop();

// periodic stats
setInterval(() => {
  parentPort?.postMessage({
    type: 'stats',
    nodes: nodePool.size,
    inFlight: fault.inFlight,
    idleGeneral: nodePool.idleCount(ClusterId.GENERAL),
    idleMath: nodePool.idleCount(ClusterId.MATH),
    idleShadow: nodePool.idleCount(ClusterId.SHADOW_POOL),
  });
}, 5_000).unref();

