/**
 * Network worker thread — owns the WebSocket mesh.
 * Never runs semantic routing; only socket I/O ↔ SharedArrayBuffer rings.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { WebSocketServer, WebSocket } from 'ws';
import { SharedRingBuffer, IpcKind } from '../ipc/ring-buffer.js';
import { BinaryCodec } from '../binary/codec.js';
import { Cmd, HEADER_SIZE, MAX_PACKET_BYTES, nowUs } from '../binary/protocol.js';
import { BufferPool } from '../pool/object-pool.js';

interface NetWorkerData {
  port: number;
  inboundSab: SharedArrayBuffer;
  outboundSab: SharedArrayBuffer;
  slotSize: number;
  slotCount: number;
}

const data = workerData as NetWorkerData;
const inbound = new SharedRingBuffer(data.inboundSab, {
  slotSize: data.slotSize,
  slotCount: data.slotCount,
});
const outbound = new SharedRingBuffer(data.outboundSab, {
  slotSize: data.slotSize,
  slotCount: data.slotCount,
});

/** socketSlot → WebSocket. Slot 0 is unused (null sentinel). */
const sockets: (WebSocket | null)[] = new Array(65_536).fill(null);
const nodeToSlot = new Map<string, number>();
let nextSlot = 1;

const bufPool = new BufferPool(MAX_PACKET_BYTES, 256, 4096);
const scratch = new Uint8Array(MAX_PACKET_BYTES + 16);

function allocSlot(): number {
  // linear probe — rare; connection rate << dispatch rate
  for (let i = 0; i < sockets.length; i++) {
    const s = nextSlot;
    nextSlot = nextSlot + 1 < sockets.length ? nextSlot + 1 : 1;
    if (!sockets[s]) return s;
  }
  throw new Error('socket table exhausted');
}

function pushInbound(kind: IpcKind, packet: Uint8Array, meta?: { socketSlot: number }): void {
  // Frame: [u8 kind][u32 socketSlot][packet...]
  const metaSize = 1 + 4;
  const frame = bufPool.acquire();
  const u8 = new Uint8Array(frame);
  u8[0] = kind;
  const dv = new DataView(frame);
  dv.setUint32(1, meta?.socketSlot ?? 0, true);
  u8.set(packet, metaSize);
  const len = metaSize + packet.byteLength;
  let pushed = inbound.tryPush(u8.subarray(0, len), len);
  if (!pushed) {
    inbound.waitForSpace(1);
    pushed = inbound.tryPush(u8.subarray(0, len), len);
  }
  bufPool.release(frame);
}

function handleBinary(socketSlot: number, raw: Buffer): void {
  try {
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const header = BinaryCodec.decodeHeader(ab, raw.byteLength);
    if (header.command === Cmd.REGISTER) {
      // payload[0] unused; node/cluster already in header
      nodeToSlot.set(header.nodeId.toString(), socketSlot);
    }
    const packet = new Uint8Array(ab, 0, raw.byteLength);
    pushInbound(IpcKind.INBOUND_PACKET, packet, { socketSlot });
  } catch (err) {
    parentPort?.postMessage({ type: 'error', err: String(err) });
  }
}

const wss = new WebSocketServer({
  port: data.port,
  perMessageDeflate: false, // never compress on hot path
  maxPayload: MAX_PACKET_BYTES,
});

wss.on('connection', (socket: WebSocket) => {
  const socketSlot = allocSlot();
  sockets[socketSlot] = socket;
  socket.binaryType = 'nodebuffer';

  socket.on('message', (message: Buffer | ArrayBuffer | Buffer[], isBinary) => {
    if (!isBinary) return; // JSON rejected by policy
    const buf = Buffer.isBuffer(message)
      ? message
      : Array.isArray(message)
        ? Buffer.concat(message)
        : Buffer.from(message);
    handleBinary(socketSlot, buf);
  });

  socket.on('close', () => {
    // Notify router of gone slot
    const frame = bufPool.acquire();
    const u8 = new Uint8Array(frame);
    u8[0] = IpcKind.NODE_GONE;
    new DataView(frame).setUint32(1, socketSlot, true);
    inbound.tryPush(u8.subarray(0, 5), 5);
    bufPool.release(frame);
    sockets[socketSlot] = null;
    for (const [k, v] of nodeToSlot) {
      if (v === socketSlot) nodeToSlot.delete(k);
    }
  });

  socket.on('error', () => {
    try {
      socket.terminate();
    } catch {
      /* ignore */
    }
  });
});

/** Drain outbound ring → sockets (router → network). */
function drainOutbound(): void {
  for (;;) {
    const n = outbound.tryPop(scratch);
    if (n < 0) break;
    // Frame: [u8 kind][u32 socketSlot][packet...]
    const kind = scratch[0];
    if (kind !== IpcKind.OUTBOUND_PACKET && kind !== IpcKind.DISPATCH_TASK) continue;
    const slot = new DataView(scratch.buffer, scratch.byteOffset, n).getUint32(1, true);
    const packet = scratch.subarray(5, n);
    const ws = sockets[slot];
    if (ws && ws.readyState === WebSocket.OPEN) {
      // copy once into a Buffer ws can own (ws may queue async)
      ws.send(Buffer.from(packet), { binary: true });
    }
  }
}

function loop(): void {
  drainOutbound();
  // sleep briefly if idle — Atomics.wait on outbound head
  if (outbound.available === 0) {
    outbound.waitForData(2);
  }
  setImmediate(loop);
}

parentPort?.postMessage({ type: 'ready', port: data.port, at: nowUs().toString() });
loop();

// Keep HEADER_SIZE referenced for tree-shaking clarity in build
void HEADER_SIZE;
