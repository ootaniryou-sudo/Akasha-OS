/**
 * Fixed-capacity object pool — eliminates per-transaction `new` / GC spikes.
 * Acquire → use → release. Never allocate on the hot path once warmed.
 */
export class ObjectPool<T> {
  private readonly free: T[];
  private readonly factory: () => T;
  private readonly reset: (obj: T) => void;
  private readonly max: number;
  private created = 0;

  constructor(factory: () => T, reset: (obj: T) => void, initial: number, max: number) {
    this.factory = factory;
    this.reset = reset;
    this.max = max;
    this.free = new Array(initial);
    for (let i = 0; i < initial; i++) {
      this.free[i] = factory();
      this.created++;
    }
  }

  acquire(): T {
    const obj = this.free.pop();
    if (obj !== undefined) return obj;
    if (this.created >= this.max) {
      // Hard cap: still allocate to avoid deadlock, but rare under load sizing
      return this.factory();
    }
    this.created++;
    return this.factory();
  }

  release(obj: T): void {
    this.reset(obj);
    if (this.free.length < this.max) {
      this.free.push(obj);
    }
  }

  get size(): number {
    return this.free.length;
  }

  get totalCreated(): number {
    return this.created;
  }
}

/** Pool of pre-sized ArrayBuffers for wire packets. */
export class BufferPool {
  private readonly free: ArrayBuffer[];
  private readonly byteLength: number;
  private readonly max: number;
  private created = 0;

  constructor(byteLength: number, initial: number, max: number) {
    this.byteLength = byteLength;
    this.max = max;
    this.free = new Array(initial);
    for (let i = 0; i < initial; i++) {
      this.free[i] = new ArrayBuffer(byteLength);
      this.created++;
    }
  }

  acquire(): ArrayBuffer {
    const buf = this.free.pop();
    if (buf) return buf;
    if (this.created < this.max) {
      this.created++;
      return new ArrayBuffer(this.byteLength);
    }
    return new ArrayBuffer(this.byteLength);
  }

  release(buf: ArrayBuffer): void {
    if (buf.byteLength !== this.byteLength) return;
    if (this.free.length < this.max) this.free.push(buf);
  }

  get capacity(): number {
    return this.byteLength;
  }
}
