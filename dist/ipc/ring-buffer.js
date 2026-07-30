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
export const RING_CTRL_BYTES = 8;
export class SharedRingBuffer {
    sab;
    slotSize;
    slotCount;
    mask;
    ctrl;
    data;
    constructor(sab, config) {
        this.sab = sab;
        this.slotSize = config.slotSize;
        this.slotCount = config.slotCount;
        this.mask = config.slotCount - 1;
        if ((config.slotCount & this.mask) !== 0) {
            throw new Error('slotCount must be power of 2');
        }
        const need = RING_CTRL_BYTES + config.slotSize * config.slotCount;
        if (sab.byteLength < need) {
            throw new Error(`SAB too small: need ${need}, have ${sab.byteLength}`);
        }
        this.ctrl = new Int32Array(sab, 0, 2);
        this.data = new Uint8Array(sab, RING_CTRL_BYTES);
    }
    static create(config) {
        const bytes = RING_CTRL_BYTES + config.slotSize * config.slotCount;
        const sab = new SharedArrayBuffer(bytes);
        return new SharedRingBuffer(sab, config);
    }
    static byteLength(config) {
        return RING_CTRL_BYTES + config.slotSize * config.slotCount;
    }
    get head() {
        return Atomics.load(this.ctrl, 0);
    }
    get tail() {
        return Atomics.load(this.ctrl, 1);
    }
    get available() {
        return (this.head - this.tail) >>> 0;
    }
    get freeSlots() {
        return this.slotCount - this.available - 1; // leave one empty to distinguish full/empty
    }
    /**
     * Producer: copy `src[0..len)` into next slot. Returns false if full.
     * Slot format: [u32 LE length][payload...]
     */
    tryPush(src, len) {
        if (len + 4 > this.slotSize)
            return false;
        const head = Atomics.load(this.ctrl, 0);
        const tail = Atomics.load(this.ctrl, 1);
        if (((head - tail) >>> 0) >= this.slotCount - 1)
            return false;
        const slot = (head & this.mask) * this.slotSize;
        const view = new DataView(this.data.buffer, this.data.byteOffset + slot, this.slotSize);
        view.setUint32(0, len, true);
        this.data.set(src.subarray(0, len), slot + 4);
        Atomics.store(this.ctrl, 0, head + 1);
        Atomics.notify(this.ctrl, 0, 1);
        return true;
    }
    /**
     * Consumer: copy next slot into `dst`. Returns payload length, or -1 if empty.
     */
    tryPop(dst) {
        const head = Atomics.load(this.ctrl, 0);
        const tail = Atomics.load(this.ctrl, 1);
        if (head === tail)
            return -1;
        const slot = (tail & this.mask) * this.slotSize;
        const view = new DataView(this.data.buffer, this.data.byteOffset + slot, this.slotSize);
        const len = view.getUint32(0, true);
        if (len > dst.byteLength) {
            // skip corrupt / oversized — advance to avoid stuck ring
            Atomics.store(this.ctrl, 1, tail + 1);
            Atomics.notify(this.ctrl, 1, 1);
            return -2;
        }
        dst.set(this.data.subarray(slot + 4, slot + 4 + len), 0);
        Atomics.store(this.ctrl, 1, (tail + 1) >>> 0);
        Atomics.notify(this.ctrl, 1, 1);
        return len;
    }
    /** Block until data available or timeoutMs elapses. Returns true if data ready. */
    waitForData(timeoutMs) {
        const tail = Atomics.load(this.ctrl, 1);
        const head = Atomics.load(this.ctrl, 0);
        if (head !== tail)
            return true;
        const r = Atomics.wait(this.ctrl, 0, head, timeoutMs);
        return r !== 'timed-out';
    }
    waitForSpace(timeoutMs) {
        if (this.freeSlots > 0)
            return true;
        const tail = Atomics.load(this.ctrl, 1);
        const r = Atomics.wait(this.ctrl, 1, tail, timeoutMs);
        return r !== 'timed-out';
    }
}
//# sourceMappingURL=ring-buffer.js.map