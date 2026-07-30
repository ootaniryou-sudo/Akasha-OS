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
export declare const MAGIC = 1095455560;
export declare const PROTOCOL_VERSION = 1;
export declare const HEADER_SIZE = 48;
export declare const MAX_PAYLOAD_FLOATS = 65536;
export declare const MAX_PACKET_BYTES: number;
/** Wire command opcodes — single byte at offset 5. */
export declare const enum Cmd {
    REGISTER = 1,
    HEARTBEAT = 2,
    COMPUTE_TASK = 3,
    RESULT = 4,
    FAILOVER = 5,
    ACK = 6,
    DEREGISTER = 7
}
/** Packet flags (offset 6, u16 LE). */
export declare const enum Flag {
    NONE = 0,
    SHADOW = 1,// shadow / failover replica
    FINAL = 2,// last hop in pipeline
    URGENT = 4
}
/** Well-known semantic cluster IDs (u32). */
export declare const enum ClusterId {
    GENERAL = 1,
    MATH = 2,
    CODE = 3,
    LANGUAGE = 4,
    SHADOW_POOL = 99
}
export interface PacketHeaderView {
    magic: number;
    version: number;
    command: Cmd;
    flags: number;
    txId: bigint;
    nodeId: bigint;
    clusterId: number;
    payloadLen: number;
    timestampUs: bigint;
    expectedUs: number;
    seq: number;
}
export declare function nowUs(): bigint;
export declare function clusterName(id: number): string;
//# sourceMappingURL=protocol.d.ts.map