import { Flag, type PacketHeaderView } from './protocol.js';
/**
 * Zero-allocation binary codec.
 * All encode/decode operate on pooled ArrayBuffers; Float32 views
 * alias the payload region directly (no JSON, no intermediate copies
 * of the activation vector when the buffer is already owned).
 */
export declare class BinaryCodec {
    /** Write a full packet into `buf`. Returns total byte length. */
    static encode(buf: ArrayBuffer, header: Omit<PacketHeaderView, 'magic' | 'version' | 'payloadLen'> & {
        payload?: Float32Array | null;
    }): number;
    /** Validate magic/version and return a header view (no allocation of payload). */
    static decodeHeader(buf: ArrayBuffer, byteLength?: number): PacketHeaderView;
    /**
     * Zero-copy Float32 view over the payload region.
     * Caller must not retain the view past buffer recycle.
     */
    static payloadView(buf: ArrayBuffer, payloadLen: number): Float32Array;
    static isShadow(flags: number): boolean;
    static withShadow(flags: number): number;
}
/** Compact helpers for building common packet kinds. */
export declare function buildComputeHeader(txId: bigint, nodeId: bigint, clusterId: number, timestampUs: bigint, expectedUs: number, seq: number, flags?: Flag): Omit<PacketHeaderView, 'magic' | 'version' | 'payloadLen'>;
//# sourceMappingURL=codec.d.ts.map