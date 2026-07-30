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
