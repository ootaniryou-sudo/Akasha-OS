/**
 * model-cache.ts
 *
 * Akasha OS — IndexedDB Model Weight Cache Manager
 * ─────────────────────────────────────────────────
 * Caches quantised model weights in the browser's persistent IndexedDB
 * storage.  On subsequent starts, loads weights directly from local
 * storage into WebGPU buffers — zero network traffic, sub-second startup.
 *
 * NOTE: This module uses browser-only APIs (IndexedDB, WebGPU).
 * In a Node.js context, these operations will gracefully no-op.
 * All DOM types are accessed via `(globalThis as any)` to avoid
 * requiring DOM lib in the tsconfig.
 */

// ═════════════════════════════════════════════════════════════════════════════
// 0. Browser API shims (type-safe access without DOM lib)
// ═════════════════════════════════════════════════════════════════════════════

const G = globalThis as any;

function _indexedDB(): any | undefined {
  return G.indexedDB;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Types
// ═════════════════════════════════════════════════════════════════════════════

export interface CacheManifest {
  modelId: string;
  totalChunks: number;
  chunkSize: number;
  totalBytes: number;
  crc32Root: string;
  /** Timestamp of when this model was cached (epoch ms). */
  cachedAt: number;
  /** Estimated time saved vs network download (ms). */
  timeSavedMs: number;
}

export interface CacheProgress {
  modelId: string;
  chunksCached: number;
  totalChunks: number;
  percentComplete: number;
  bytesCached: number;
  totalBytes: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Model Cache Manager
// ═════════════════════════════════════════════════════════════════════════════

export class ModelCache {
  private readonly dbName: string;
  private readonly storeName = 'chunks';
  private db: any = null; // IDBDatabase

  constructor(modelId: string) {
    this.dbName = `akasha-model-${modelId}`;
  }

  // ─── Open / initialise ──────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this.db) return;
    const idb = _indexedDB();
    if (!idb) return; // Node.js — no-op

    this.db = await new Promise<any>((resolve, reject) => {
      const req = idb.open(this.dbName, 2);

      req.onupgradeneeded = (ev: any) => {
        const db = ev.target.result;
        if (ev.oldVersion < 1) {
          db.createObjectStore(this.storeName, { keyPath: 'chunkIndex' });
        }
        if (ev.oldVersion < 2) {
          const tx = ev.target.transaction;
          const store = tx.objectStore(this.storeName);
          if (!store.indexNames.contains('crc32')) {
            store.createIndex('crc32', 'crc32', { unique: false });
          }
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  // ─── Write ──────────────────────────────────────────────────────────────

  async putChunk(chunkIndex: number, data: ArrayBuffer, crc32: number): Promise<boolean> {
    if (!this.db) return false;
    const db = this.db;

    return new Promise<boolean>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.put({ chunkIndex, data, crc32, storedAt: Date.now() });
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      } catch (err) { reject(err); }
    });
  }

  async putChunks(
    chunks: { chunkIndex: number; data: ArrayBuffer; crc32: number }[],
  ): Promise<boolean> {
    if (!this.db || chunks.length === 0) return false;
    const db = this.db;

    return new Promise<boolean>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        for (const c of chunks) {
          store.put({ chunkIndex: c.chunkIndex, data: c.data, crc32: c.crc32, storedAt: Date.now() });
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      } catch (err) { reject(err); }
    });
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  async getChunk(chunkIndex: number): Promise<{ chunkIndex: number; data: ArrayBuffer; crc32: number } | null> {
    if (!this.db) return null;
    const db = this.db;

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(chunkIndex);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      } catch (err) { reject(err); }
    });
  }

  async isFullyCached(totalChunks: number): Promise<boolean> {
    const count = await this.count();
    return count >= totalChunks;
  }

  async count(): Promise<number> {
    if (!this.db) return 0;
    const db = this.db;

    return new Promise<number>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (err) { reject(err); }
    });
  }

  async loadFullModel(totalChunks: number): Promise<ArrayBuffer | null> {
    if (!this.db) return null;
    const count = await this.count();
    if (count < totalChunks) return null;

    const chunks = await this._loadAllChunks();
    if (chunks.length !== totalChunks) return null;

    let totalSize = 0;
    for (const c of chunks) totalSize += c.data.byteLength;

    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const c of chunks) {
      result.set(new Uint8Array(c.data), offset);
      offset += c.data.byteLength;
    }

    return result.buffer;
  }

  async loadAllChunks(_totalChunks: number): Promise<{ chunkIndex: number; data: ArrayBuffer; crc32: number }[]> {
    if (!this.db) return [];
    return this._loadAllChunks();
  }

  private async _loadAllChunks(): Promise<{ chunkIndex: number; data: ArrayBuffer; crc32: number }[]> {
    const db = this.db;
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.openCursor();
        const results: { chunkIndex: number; data: ArrayBuffer; crc32: number }[] = [];

        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            results.push(cursor.value);
            cursor.continue();
          } else {
            results.sort((a: any, b: any) => a.chunkIndex - b.chunkIndex);
            resolve(results);
          }
        };
        req.onerror = () => reject(req.error);
      } catch (err) { reject(err); }
    });
  }

  // ─── Delete ─────────────────────────────────────────────────────────────

  async deleteChunk(chunkIndex: number): Promise<void> {
    if (!this.db) return;
    const db = this.db;
    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete(chunkIndex);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) { reject(err); }
    });
  }

  async clearAll(): Promise<void> {
    if (!this.db) return;
    const db = this.db;
    return new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) { reject(err); }
    });
  }

  async dropDatabase(): Promise<void> {
    this.close();
    const idb = _indexedDB();
    if (!idb) return;
    return new Promise<void>((resolve, reject) => {
      const req = idb.deleteDatabase(this.dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ─── Progress ───────────────────────────────────────────────────────────

  async getProgress(totalChunks: number, totalBytes: number): Promise<CacheProgress> {
    const chunksCached = await this.count();
    return {
      modelId: this.dbName.replace('akasha-model-', ''),
      chunksCached,
      totalChunks,
      percentComplete: totalChunks > 0 ? Math.round((chunksCached / totalChunks) * 100) : 0,
      bytesCached: 0,
      totalBytes,
    };
  }

  estimateTimeSaved(networkSpeedBytesPerSec: number, totalBytes: number): number {
    const downloadTimeMs = (totalBytes / networkSpeedBytesPerSec) * 1000;
    const localLoadTimeMs = 100;
    return Math.max(0, downloadTimeMs - localLoadTimeMs);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. WebGPU Direct Upload Helper
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Upload a cached ArrayBuffer directly to a WebGPU storage buffer.
 * Uses `(navigator as any).gpu` to avoid DOM lib dependency.
 */
export function uploadToWebGPU(
  device: any, // GPUDevice
  data: ArrayBuffer,
  label: string,
): any /* GPUBuffer */ {
  const buffer = device.createBuffer({
    label,
    size: data.byteLength,
    usage: 0x80 | 0x08 | 0x04, // STORAGE | COPY_DST | COPY_SRC
    mappedAtCreation: true,
  });

  const mapped = new Uint8Array(buffer.getMappedRange());
  mapped.set(new Uint8Array(data));
  buffer.unmap();

  return buffer;
}

/**
 * Stream chunks directly from IndexedDB into WebGPU buffers.
 */
export async function streamToWebGPU(
  cache: ModelCache,
  device: any, // GPUDevice
  totalChunks: number,
  labelPrefix: string,
): Promise<any[] /* GPUBuffer[] */> {
  const chunks = await cache.loadAllChunks(totalChunks);
  const buffers: any[] = [];

  for (const chunk of chunks) {
    const buf = uploadToWebGPU(device, chunk.data, `${labelPrefix}-chunk-${chunk.chunkIndex}`);
    buffers.push(buf);
  }

  return buffers;
}
