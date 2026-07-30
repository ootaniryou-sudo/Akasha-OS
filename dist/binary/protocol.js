/**
 * Akasha Wire Protocol — fixed-offset binary packet layout.
 *
 * ┌────────┬──────┬──────────────────────────────────────────────┐
 * │ Offset │ Size │ Field                                        │
 * ├────────┼──────┼──────────────────────────────────────────────┤
 * │ 0      │ 4    │ MAGIC          u32 BE  0x414B5348 ("AKSH")   │
 * │ 4      │ 1    │ VERSION        u8      protocol version      │
 * │ 5      │ 1    │ COMMAND        u8      Cmd enum              │
 * │ 6      │ 2    │ FLAGS          u16 LE  bitfield              │
 * │ 8      │ 8    │ TX_ID          u64 LE  transaction id        │
 * │ 16     │ 8    │ NODE_ID        u64 LE  node id               │
 * │ 24     │ 4    │ CLUSTER_ID     u32 LE  semantic cluster      │
 * │ 28     │ 4    │ PAYLOAD_LEN    u32 LE  float32 byte length   │
 * │ 32     │ 8    │ TIMESTAMP_US   u64 LE  dispatch timestamp μs │
 * │ 40     │ 4    │ EXPECTED_MS    u32 LE  timeout hint (ms×1000)│
 * │ 44     │ 4    │ SEQ            u32 LE  sequence / checksum   │
 * │ 48     │ N    │ PAYLOAD        Float32Array (zero-copy view) │
 * └────────┴──────┴──────────────────────────────────────────────┘
 *
 * Total header = 48 bytes. Payload starts at HEADER_SIZE and is
 * always a multiple of 4 (raw f32 activations for WebGPU upload).
 */
export const MAGIC = 0x414b5348; // "AKSH"
export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 48;
export const MAX_PAYLOAD_FLOATS = 65_536; // 256 KiB f32
export const MAX_PACKET_BYTES = HEADER_SIZE + MAX_PAYLOAD_FLOATS * 4;
export function nowUs() {
    // process.hrtime.bigint() is ns → convert to μs
    return process.hrtime.bigint() / 1000n;
}
export function clusterName(id) {
    switch (id) {
        case 1 /* ClusterId.GENERAL */:
            return 'general_expert';
        case 2 /* ClusterId.MATH */:
            return 'math_expert';
        case 3 /* ClusterId.CODE */:
            return 'code_expert';
        case 4 /* ClusterId.LANGUAGE */:
            return 'language_expert';
        case 99 /* ClusterId.SHADOW_POOL */:
            return 'shadow_pool';
        default:
            return `cluster_${id}`;
    }
}
//# sourceMappingURL=protocol.js.map