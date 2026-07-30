import { type PacketHeaderView } from '../binary/protocol.js';
/** Minimal WebSocket surface shared by browser + `ws`. */
export interface WsLike {
    binaryType: string;
    readyState: number;
    send: (data: ArrayBuffer | Buffer | Uint8Array) => void;
    close: () => void;
    onopen: ((ev?: unknown) => void) | null;
    onerror: ((ev?: unknown) => void) | null;
    onmessage: ((ev: {
        data: ArrayBuffer | Buffer | Blob | string;
    }) => void) | null;
    onclose: ((ev?: unknown) => void) | null;
}
export type WsConstructor = new (url: string) => WsLike;
export type EdgeComputeHandler = (header: PacketHeaderView, activation: Float32Array) => Float32Array | Promise<Float32Array>;
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
export declare class AkashaEdgeNode {
    private ws;
    private readonly bufPool;
    private readonly opts;
    private heartbeatTimer;
    constructor(opts: EdgeNodeOptions);
    connect(): Promise<void>;
    close(): void;
    private sendRegister;
    private sendHeartbeat;
    private onPacket;
    private sendBuf;
}
export declare function defaultExpertForward(input: Float32Array, clusterId: number): Float32Array;
//# sourceMappingURL=node-client.d.ts.map