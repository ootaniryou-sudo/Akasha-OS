/**
 * Fixed-capacity object pool — eliminates per-transaction `new` / GC spikes.
 * Acquire → use → release. Never allocate on the hot path once warmed.
 */
export class ObjectPool {
    free;
    factory;
    reset;
    max;
    created = 0;
    constructor(factory, reset, initial, max) {
        this.factory = factory;
        this.reset = reset;
        this.max = max;
        this.free = new Array(initial);
        for (let i = 0; i < initial; i++) {
            this.free[i] = factory();
            this.created++;
        }
    }
    acquire() {
        const obj = this.free.pop();
        if (obj !== undefined)
            return obj;
        if (this.created >= this.max) {
            // Hard cap: still allocate to avoid deadlock, but rare under load sizing
            return this.factory();
        }
        this.created++;
        return this.factory();
    }
    release(obj) {
        this.reset(obj);
        if (this.free.length < this.max) {
            this.free.push(obj);
        }
    }
    get size() {
        return this.free.length;
    }
    get totalCreated() {
        return this.created;
    }
}
/** Pool of pre-sized ArrayBuffers for wire packets. */
export class BufferPool {
    free;
    byteLength;
    max;
    created = 0;
    constructor(byteLength, initial, max) {
        this.byteLength = byteLength;
        this.max = max;
        this.free = new Array(initial);
        for (let i = 0; i < initial; i++) {
            this.free[i] = new ArrayBuffer(byteLength);
            this.created++;
        }
    }
    acquire() {
        const buf = this.free.pop();
        if (buf)
            return buf;
        if (this.created < this.max) {
            this.created++;
            return new ArrayBuffer(this.byteLength);
        }
        return new ArrayBuffer(this.byteLength);
    }
    release(buf) {
        if (buf.byteLength !== this.byteLength)
            return;
        if (this.free.length < this.max)
            this.free.push(buf);
    }
    get capacity() {
        return this.byteLength;
    }
}
//# sourceMappingURL=object-pool.js.map