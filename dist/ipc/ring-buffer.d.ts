/**
 * Lock-free SPSC ring buffer over SharedArrayBuffer.
 *
 * Layout:
 *   [0..3]   head  (Uint32, producer writes)
 *   [4..7]   tail  (Uint32, consumer writes)
 *   [8..]    slots — fixed-size binary frames
 *
 * Memory ordering uses Atomics on head/tail. Payload bytes are written
 * before head is advanced (producer) / read before tail is advanced (consumer).
 * Single-producer / single-consumer → no CAS loops on the data plane.
 */
export declare const RING_CTRL_BYTES = 8;
export interface RingConfig {
    slotSize: number;
    slotCount: number;
}
export declare class SharedRingBuffer {
    readonly sab: SharedArrayBuffer;
    readonly slotSize: number;
    readonly slotCount: number;
    readonly mask: number;
    private readonly ctrl;
    private readonly data;
    constructor(sab: SharedArrayBuffer, config: RingConfig);
    static create(config: RingConfig): SharedRingBuffer;
    static byteLength(config: RingConfig): number;
    get head(): number;
    get tail(): number;
    get available(): number;
    get freeSlots(): number;
    /**
     * Producer: copy `src[0..len)` into next slot. Returns false if full.
     * Slot format: [u32 LE length][payload...]
     */
    tryPush(src: Uint8Array, len: number): boolean;
    /**
     * Consumer: copy next slot into `dst`. Returns payload length, or -1 if empty.
     */
    tryPop(dst: Uint8Array): number;
    /** Block until data available or timeoutMs elapses. Returns true if data ready. */
    waitForData(timeoutMs: number): boolean;
    waitForSpace(timeoutMs: number): boolean;
}
/** IPC message kinds stuffed into the first byte of a ring payload (control plane). */
export declare const enum IpcKind {
    INBOUND_PACKET = 1,
    OUTBOUND_PACKET = 2,
    REGISTER_NODE = 3,
    NODE_GONE = 4,
    DISPATCH_TASK = 5,
    SUBMIT_PROMPT = 6,
    STATS = 7
}
//# sourceMappingURL=ring-buffer.d.ts.map