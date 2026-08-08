/**
 * Akasha Wire Protocol — Knowledge Edict (Binary Wire Protocol)
 *
 * ArcAsha Node 間で使用する共通バイナリプロトコル。
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
 * │ 40     │ 4    │ EXPECTED_US    u32 LE  timeout / GPU budget μs│
 * │ 44     │ 4    │ SEQ            u32 LE  sequence / checksum   │
 * │ 48     │ N    │ PAYLOAD        Float32Array (zero-copy view) │
 * └────────┴──────┴──────────────────────────────────────────────┘
 *
 * Total header = 48 bytes. Payload starts at HEADER_SIZE and is
 * always a multiple of 4 (raw f32 activations for WebGPU upload).
 *
 * Bootstrap lifecycle:
 *  - A socket MUST REGISTER (Cmd=0x01) before the master promotes it to
 *    BENCHMARK. REGISTER for an unknown socket is rejected (FAIL_BAD_REGISTER).
 *  - A nodeId may be owned by exactly one live socket; a duplicate REGISTER
 *    evicts the prior owner (FAIL_DUP_REGISTER).
 *  - On RESULT (Cmd=0x04), EXPECTED_US carries the edge-reported GPU kernel µs;
 *    RTT is derived server-side from TIMESTAMP_US echo.
 */

export const MAGIC = 0x414b5348; // "AKSH"
export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 48;
export const MAX_PAYLOAD_FLOATS = 65_536; // 256 KiB f32
export const MAX_PACKET_BYTES = HEADER_SIZE + MAX_PAYLOAD_FLOATS * 4;

/** Wire command opcodes — single byte at offset 5. */
export const enum Cmd {
  REGISTER = 0x01,
  HEARTBEAT = 0x02,
  COMPUTE_TASK = 0x03,
  RESULT = 0x04,
  FAILOVER = 0x05,
  ACK = 0x06,
  DEREGISTER = 0x07,
  /** Bootstrap: master → edge lightweight matmul probe */
  BENCHMARK = 0x08,
  /** Bootstrap: master → edge role + cluster appointment */
  ASSIGN = 0x09,
  /** Inference: inter-band activation relay (P2P or master-proxied) */
  RELAY = 0x0a,
  /** Inference: tail band → master streaming token output */
  TOKEN_OUT = 0x0b,
}

/** Packet flags (offset 6, u16 LE). */
export const enum Flag {
  NONE = 0,
  SHADOW = 1 << 0, // shadow / failover replica
  FINAL = 1 << 1, // last hop in pipeline
  URGENT = 1 << 2,
}

/** Well-known semantic cluster IDs (u32). */
export const enum ClusterId {
  GENERAL = 1,
  MATH = 2,
  CODE = 3,
  LANGUAGE = 4,
  /** High-APS nodes: LLM head / context-critical layers */
  HEAD_LAYER = 10,
  SHADOW_POOL = 99,
}

/** Bootstrap role appointment (carried in ASSIGN.seq). */
export const enum NodeRole {
  UNASSIGNED = 0,
  CORE_ROUTER = 1,
  ACTIVE_COMPUTE = 2,
  SHADOW_BACKUP = 3,
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
  expectedUs: number; // microsecond timeout budget (stored as u32)
  seq: number;
}

export function nowUs(): bigint {
  // process.hrtime.bigint() is ns → convert to μs
  return process.hrtime.bigint() / 1000n;
}

export function clusterName(id: number): string {
  switch (id) {
    case ClusterId.GENERAL:
      return 'general_expert';
    case ClusterId.MATH:
      return 'math_expert';
    case ClusterId.CODE:
      return 'code_expert';
    case ClusterId.LANGUAGE:
      return 'language_expert';
    case ClusterId.HEAD_LAYER:
      return 'head_layer';
    case ClusterId.SHADOW_POOL:
      return 'shadow_pool';
    default:
      return `cluster_${id}`;
  }
}

export function roleName(role: NodeRole): string {
  switch (role) {
    case NodeRole.CORE_ROUTER:
      return 'core_router';
    case NodeRole.ACTIVE_COMPUTE:
      return 'active_compute';
    case NodeRole.SHADOW_BACKUP:
      return 'shadow_backup';
    default:
      return 'unassigned';
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Extended 36-byte datagram header (WebTransport / QUIC P2P)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 36-byte extended datagram header for QUIC P2P relay.
 *
 * ┌────────┬──────┬──────────┬──────────────────────────────────────────────┐
 * │ Offset │ Size │ Type     │ Field                                        │
 * ├────────┼──────┼──────────┼──────────────────────────────────────────────┤
 * │  0     │ 16   │ u128 LE  │ TX_ID        transaction id                   │
 * │ 16     │  4   │ u32 LE   │ LAYER_ID     assigned layer index             │
 * │ 20     │  8   │ u64 LE   │ SEQ          monotonic sequence number        │
 * │ 28     │  4   │ u32 LE   │ PAYLOAD_LEN  Float32Array byte length         │
 * │ 32     │  4   │ u32 LE   │ CHECKSUM     Fletcher32 over payload          │
 * │ 36     │  N   │ f32[]    │ PAYLOAD      raw Float32Array                 │
 * └────────┴──────┴──────────┴──────────────────────────────────────────────┘
 */

export const EX_HEADER_SIZE = 36;

export interface ExtendedHeader {
  txId: bigint;
  layerId: number;
  seq: number;
  payloadLen: number;
  checksum: number;
}

export function decodeExtendedHeader(buf: Uint8Array, offset = 0): ExtendedHeader {
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, EX_HEADER_SIZE);
  const txLo = dv.getBigUint64(0, true);
  const txHi = dv.getBigUint64(8, true);
  const txId = (txHi << 64n) | txLo;
  return {
    txId,
    layerId: dv.getUint32(16, true),
    seq: Number(dv.getBigUint64(20, true)),
    payloadLen: dv.getUint32(28, true),
    checksum: dv.getUint32(32, true),
  };
}

export function encodeExtendedHeader(hdr: ExtendedHeader, dst: Uint8Array, offset = 0): number {
  const dv = new DataView(dst.buffer, dst.byteOffset + offset, EX_HEADER_SIZE);
  dv.setBigUint64(0, hdr.txId & 0xffffffffffffffffn, true);
  dv.setBigUint64(8, hdr.txId >> 64n, true);
  dv.setUint32(16, hdr.layerId, true);
  dv.setBigUint64(20, BigInt(hdr.seq), true);
  dv.setUint32(28, hdr.payloadLen, true);
  dv.setUint32(32, hdr.checksum, true);
  return EX_HEADER_SIZE;
}

/**
 * Fletcher-32 checksum (two 16-bit running sums mod 65535).
 * Fast, detects all single-bit errors. O(N), zero allocation.
 */
export function fletcher32(data: Uint8Array, offset = 0, length = data.length - offset): number {
  let sum1 = 0xffff, sum2 = 0xffff;
  const end = offset + length;
  let i = offset;
  while (i < end) {
    const blockLen = Math.min(360, end - i);
    for (let j = 0; j < blockLen; j++) {
      sum1 = (sum1 + data[i + j]) % 65535;
      sum2 = (sum2 + sum1) % 65535;
    }
    i += blockLen;
  }
  return ((sum2 << 16) | sum1) >>> 0;
}

