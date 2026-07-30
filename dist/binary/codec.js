import { HEADER_SIZE, MAGIC, MAX_PACKET_BYTES, PROTOCOL_VERSION, } from './protocol.js';
/**
 * Zero-allocation binary codec.
 * All encode/decode operate on pooled ArrayBuffers; Float32 views
 * alias the payload region directly (no JSON, no intermediate copies
 * of the activation vector when the buffer is already owned).
 */
export class BinaryCodec {
    /** Write a full packet into `buf`. Returns total byte length. */
    static encode(buf, header) {
        const payloadBytes = header.payload ? header.payload.byteLength : 0;
        const total = HEADER_SIZE + payloadBytes;
        if (total > buf.byteLength || total > MAX_PACKET_BYTES) {
            throw new RangeError(`packet ${total}B exceeds buffer ${buf.byteLength}B`);
        }
        const dv = new DataView(buf);
        dv.setUint32(0, MAGIC, false); // BE magic for easy sniffing
        dv.setUint8(4, PROTOCOL_VERSION);
        dv.setUint8(5, header.command);
        dv.setUint16(6, header.flags, true);
        dv.setBigUint64(8, header.txId, true);
        dv.setBigUint64(16, header.nodeId, true);
        dv.setUint32(24, header.clusterId, true);
        dv.setUint32(28, payloadBytes, true);
        dv.setBigUint64(32, header.timestampUs, true);
        dv.setUint32(40, header.expectedUs >>> 0, true);
        dv.setUint32(44, header.seq >>> 0, true);
        if (header.payload && payloadBytes > 0) {
            const dest = new Float32Array(buf, HEADER_SIZE, header.payload.length);
            dest.set(header.payload);
        }
        return total;
    }
    /** Validate magic/version and return a header view (no allocation of payload). */
    static decodeHeader(buf, byteLength = buf.byteLength) {
        if (byteLength < HEADER_SIZE) {
            throw new Error(`truncated packet: ${byteLength}B < ${HEADER_SIZE}B`);
        }
        const dv = new DataView(buf, 0, byteLength);
        const magic = dv.getUint32(0, false);
        if (magic !== MAGIC) {
            throw new Error(`bad magic 0x${magic.toString(16)}`);
        }
        const version = dv.getUint8(4);
        if (version !== PROTOCOL_VERSION) {
            throw new Error(`unsupported version ${version}`);
        }
        const payloadLen = dv.getUint32(28, true);
        if (HEADER_SIZE + payloadLen > byteLength) {
            throw new Error(`payload overrun: need ${HEADER_SIZE + payloadLen}, have ${byteLength}`);
        }
        return {
            magic,
            version,
            command: dv.getUint8(5),
            flags: dv.getUint16(6, true),
            txId: dv.getBigUint64(8, true),
            nodeId: dv.getBigUint64(16, true),
            clusterId: dv.getUint32(24, true),
            payloadLen,
            timestampUs: dv.getBigUint64(32, true),
            expectedUs: dv.getUint32(40, true),
            seq: dv.getUint32(44, true),
        };
    }
    /**
     * Zero-copy Float32 view over the payload region.
     * Caller must not retain the view past buffer recycle.
     */
    static payloadView(buf, payloadLen) {
        return new Float32Array(buf, HEADER_SIZE, payloadLen >>> 2);
    }
    static isShadow(flags) {
        return (flags & 1 /* Flag.SHADOW */) !== 0;
    }
    static withShadow(flags) {
        return flags | 1 /* Flag.SHADOW */;
    }
}
/** Compact helpers for building common packet kinds. */
export function buildComputeHeader(txId, nodeId, clusterId, timestampUs, expectedUs, seq, flags = 0 /* Flag.NONE */) {
    return {
        command: 3 /* Cmd.COMPUTE_TASK */,
        flags,
        txId,
        nodeId,
        clusterId,
        timestampUs,
        expectedUs,
        seq,
    };
}
//# sourceMappingURL=codec.js.map