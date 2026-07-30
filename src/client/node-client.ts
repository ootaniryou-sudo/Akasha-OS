import { BinaryCodec } from '../binary/codec.js';
import {
  Cmd,
  ClusterId,
  HEADER_SIZE,
  MAX_PACKET_BYTES,
  type PacketHeaderView,
} from '../binary/protocol.js';
import { BufferPool } from '../pool/object-pool.js';

/** Minimal WebSocket surface shared by browser + `ws`. */
export interface WsLike {
  binaryType: string;
  readyState: number;
  send: (data: ArrayBuffer | Buffer | Uint8Array) => void;
  close: () => void;
  onopen: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: ArrayBuffer | Buffer | Blob | string }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
}

export type WsConstructor = new (url: string) => WsLike;

export type EdgeComputeHandler = (
  header: PacketHeaderView,
  activation: Float32Array,
) => Float32Array | Promise<Float32Array>;

export interface EdgeNodeOptions {
  url: string;
  nodeId: bigint;
  clusterId: number;
  shadowNodeId?: bigint;
  simulateLatencyMs?: number;
  blackhole?: boolean;
  onCompute?: EdgeComputeHandler;
  WebSocketImpl?: WsConstructor;
}

/**
 * Edge node client — Node sim or browser. Binary protocol only.
 */
export class AkashaEdgeNode {
  private ws: WsLike | null = null;
  private readonly bufPool = new BufferPool(MAX_PACKET_BYTES, 8, 64);
  private readonly opts: EdgeNodeOptions;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: EdgeNodeOptions) {
    this.opts = opts;
  }

  connect(): Promise<void> {
    const WS = this.opts.WebSocketImpl;
    if (!WS) {
      throw new Error('WebSocketImpl required in Node; pass `ws` or browser WebSocket');
    }
    return new Promise((resolve, reject) => {
      const ws = new WS(this.opts.url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        this.sendRegister();
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 500);
        resolve();
      };
      ws.onerror = (e) => reject(e ?? new Error('WebSocket error'));
      ws.onmessage = (ev) => {
        const data = ev.data;
        if (data instanceof ArrayBuffer) {
          void this.onPacket(data);
        } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
          const ab = data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
          ) as ArrayBuffer;
          void this.onPacket(ab);
        }
      };
      ws.onclose = () => {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      };
    });
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close();
    this.ws = null;
  }

  private sendRegister(): void {
    const buf = this.bufPool.acquire();
    const len = BinaryCodec.encode(buf, {
      command: Cmd.REGISTER,
      flags: 0,
      txId: 0n,
      nodeId: this.opts.nodeId,
      clusterId: this.opts.clusterId,
      timestampUs: nowUsSafe(),
      expectedUs: 0,
      seq: this.opts.shadowNodeId ? Number(this.opts.shadowNodeId & 0xffffffffn) : 0,
      payload: null,
    });
    this.sendBuf(buf, len);
    this.bufPool.release(buf);
  }

  private sendHeartbeat(): void {
    const buf = this.bufPool.acquire();
    const len = BinaryCodec.encode(buf, {
      command: Cmd.HEARTBEAT,
      flags: 0,
      txId: 0n,
      nodeId: this.opts.nodeId,
      clusterId: this.opts.clusterId,
      timestampUs: nowUsSafe(),
      expectedUs: 0,
      seq: 0,
      payload: null,
    });
    this.sendBuf(buf, len);
    this.bufPool.release(buf);
  }

  private async onPacket(ab: ArrayBuffer): Promise<void> {
    const header = BinaryCodec.decodeHeader(ab);
    if (header.command !== Cmd.COMPUTE_TASK && header.command !== Cmd.FAILOVER) return;
    if (this.opts.blackhole) return;

    const activation = BinaryCodec.payloadView(ab, header.payloadLen);
    const input = new Float32Array(activation.length);
    input.set(activation);

    const delay = this.opts.simulateLatencyMs ?? 0;
    if (delay > 0) await sleep(delay);

    let output: Float32Array;
    if (this.opts.onCompute) {
      output = await this.opts.onCompute(header, input);
    } else {
      output = defaultExpertForward(input, this.opts.clusterId);
    }

    const outBuf = this.bufPool.acquire();
    const len = BinaryCodec.encode(outBuf, {
      command: Cmd.RESULT,
      flags: header.flags,
      txId: header.txId,
      nodeId: this.opts.nodeId,
      clusterId: header.clusterId,
      timestampUs: header.timestampUs,
      expectedUs: 0,
      seq: header.seq,
      payload: output,
    });
    this.sendBuf(outBuf, len);
    this.bufPool.release(outBuf);
  }

  private sendBuf(buf: ArrayBuffer, len: number): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(buf.byteLength === len ? buf : buf.slice(0, len));
  }
}

export function defaultExpertForward(input: Float32Array, clusterId: number): Float32Array {
  const out = new Float32Array(input.length);
  const bias = clusterId === ClusterId.MATH ? 0.17 : 0.03;
  for (let i = 0; i < input.length; i++) {
    const x = input[i]!;
    out[i] = Math.tanh(x * 1.13 + bias) * (1.0 - 0.01 * (i & 7));
  }
  return out;
}

function nowUsSafe(): bigint {
  if (typeof process !== 'undefined' && process.hrtime?.bigint) {
    return process.hrtime.bigint() / 1000n;
  }
  return BigInt(Math.floor(performance.now() * 1000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

void HEADER_SIZE;
