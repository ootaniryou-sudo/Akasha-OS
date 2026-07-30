/**
 * Fixed-capacity object pool — eliminates per-transaction `new` / GC spikes.
 * Acquire → use → release. Never allocate on the hot path once warmed.
 */
export declare class ObjectPool<T> {
    private readonly free;
    private readonly factory;
    private readonly reset;
    private readonly max;
    private created;
    constructor(factory: () => T, reset: (obj: T) => void, initial: number, max: number);
    acquire(): T;
    release(obj: T): void;
    get size(): number;
    get totalCreated(): number;
}
/** Pool of pre-sized ArrayBuffers for wire packets. */
export declare class BufferPool {
    private readonly free;
    private readonly byteLength;
    private readonly max;
    private created;
    constructor(byteLength: number, initial: number, max: number);
    acquire(): ArrayBuffer;
    release(buf: ArrayBuffer): void;
    get capacity(): number;
}
//# sourceMappingURL=object-pool.d.ts.map