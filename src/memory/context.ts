/**
 * memory/context.ts — Endless Knowledge (Long-Context Engine) + Memory Page (Context Page)
 *
 * Context を OS の Memory Page のように扱う階層型コンテキスト管理。
 * ───────────────────────────
 * Context を OS の Memory Page のように扱う階層型コンテキスト管理。
 *
 * ## Design
 *
 *   Hot Context   → GPU VRAM（直近の重要部分, full/rich KV）
 *   Warm Context  → CPU RAM（圧縮 KV / selected KV）
 *   Cold Context  → SSD / Object Storage（chunks / summaries / retrieval）
 *
 * ## Context Paging
 *
 *   Context
 *    ├─ Page 0  (tokens 0..4095)
 *    ├─ Page 1  (tokens 4096..8191)
 *    ├─ Page 2  (tokens 8192..12287)
 *    └─ Page N
 *
 * ## Future
 *
 *   Remote Akasha Node への Context 移動・共有も可能な API を想定。
 */

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

export const enum PageTier {
  /** GPU VRAM — full KV, instant access. */
  HOT = 0,
  /** CPU RAM — compressed or partial KV. */
  WARM = 1,
  /** SSD / Object Storage — chunks only, retrieval-based. */
  COLD = 2,
}

export interface ContextPage {
  pageId: number;
  /** Token range [startToken, endToken). */
  tokenStart: number;
  tokenEnd: number;
  /** Current storage tier. */
  tier: PageTier;
  /** Raw token IDs in this page. */
  tokenIds: number[];
  /** KV cache for this page (if HOT or WARM). */
  kvCache: ArrayBuffer | null;
  /** Compressed representation (if WARM). */
  compressedKV: ArrayBuffer | null;
  /** Text summary (if COLD). */
  summary: string | null;
  /** Last access timestamp (for LRU eviction). */
  lastAccess: number;
  /** Hash of the page content (for dedup). */
  contentHash: string;
}

export interface ContextConfig {
  /** Page size in tokens (default: 4096). */
  pageSize: number;
  /** Max HOT pages (default: 4 = 16K tokens). */
  maxHotPages: number;
  /** Max WARM pages (default: 16 = 64K tokens). */
  maxWarmPages: number;
  /** Max COLD pages (default: unlimited). */
  maxColdPages: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Context Manager
// ═════════════════════════════════════════════════════════════════════════════

export class ContextManager {
  private readonly config: Required<ContextConfig>;
  private pages: ContextPage[] = [];
  private nextPageId = 0;
  private totalTokens = 0;

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = {
      pageSize: config.pageSize ?? 4096,
      maxHotPages: config.maxHotPages ?? 4,
      maxWarmPages: config.maxWarmPages ?? 16,
      maxColdPages: config.maxColdPages ?? Number.MAX_SAFE_INTEGER,
    };
  }

  /**
   * Append new tokens to the context.
   * Automatically creates new pages as needed.
   */
  append(tokenIds: number[], kvCache: ArrayBuffer | null = null): void {
    let remaining = [...tokenIds];
    while (remaining.length > 0) {
      // Find or create the last page
      let page = this.pages[this.pages.length - 1];
      if (!page || page.tokenEnd - page.tokenStart >= this.config.pageSize) {
        page = this._createPage();
        this.pages.push(page);
      }

      const space = this.config.pageSize - (page.tokenEnd - page.tokenStart);
      const chunk = remaining.splice(0, space);
      page.tokenIds.push(...chunk);
      page.tokenEnd += chunk.length;
      this.totalTokens += chunk.length;

      // Attach KV cache to the first page that receives it
      if (kvCache && !page.kvCache) {
        page.kvCache = kvCache;
        page.tier = PageTier.HOT;
      }

      page.lastAccess = Date.now();
    }

    this._enforceTierLimits();
  }

  /**
   * Get all token IDs in the context window.
   */
  getTokenIds(): number[] {
    return this.pages.flatMap((p) => p.tokenIds);
  }

  /**
   * Get token IDs within a range.
   */
  getTokenRange(start: number, end: number): number[] {
    const all = this.getTokenIds();
    return all.slice(start, end);
  }

  /**
   * Get a specific page by ID.
   */
  getPage(pageId: number): ContextPage | undefined {
    return this.pages.find((p) => p.pageId === pageId);
  }

  /**
   * Promote a page to a higher tier.
   */
  promotePage(pageId: number, tier: PageTier): void {
    const page = this.getPage(pageId);
    if (!page) return;
    page.tier = tier;
    page.lastAccess = Date.now();
  }

  /**
   * Demote a page to a lower tier (compress KV).
   */
  demotePage(pageId: number, tier: PageTier, compressedKV?: ArrayBuffer | null): void {
    const page = this.getPage(pageId);
    if (!page) return;
    page.tier = tier;
    if (compressedKV !== undefined) {
      page.compressedKV = compressedKV;
    }
    if (tier === PageTier.COLD) {
      page.kvCache = null;
      page.compressedKV = null;
    }
    page.lastAccess = Date.now();
  }

  /**
   * Truncate context to a maximum number of tokens (from the end).
   */
  truncate(maxTokens: number): void {
    while (this.totalTokens > maxTokens && this.pages.length > 0) {
      const oldest = this.pages[0];
      const removed = oldest.tokenIds.length;
      this.pages.shift();
      this.totalTokens -= removed;
    }
  }

  /** Total tokens in context. */
  get length(): number {
    return this.totalTokens;
  }

  /** Number of pages. */
  get pageCount(): number {
    return this.pages.length;
  }

  /** Tier breakdown. */
  get tierStats(): { hot: number; warm: number; cold: number } {
    return {
      hot: this.pages.filter((p) => p.tier === PageTier.HOT).length,
      warm: this.pages.filter((p) => p.tier === PageTier.WARM).length,
      cold: this.pages.filter((p) => p.tier === PageTier.COLD).length,
    };
  }

  /** Clear all context. */
  clear(): void {
    this.pages = [];
    this.totalTokens = 0;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private _createPage(): ContextPage {
    return {
      pageId: this.nextPageId++,
      tokenStart: this.totalTokens,
      tokenEnd: this.totalTokens,
      tier: PageTier.HOT,
      tokenIds: [],
      kvCache: null,
      compressedKV: null,
      summary: null,
      lastAccess: Date.now(),
      contentHash: '',
    };
  }

  /**
   * Enforce tier capacity limits by demoting least-recently-used pages.
   */
  private _enforceTierLimits(): void {
    const hotPages = this.pages.filter((p) => p.tier === PageTier.HOT);
    if (hotPages.length > this.config.maxHotPages) {
      // Demote oldest HOT pages to WARM
      hotPages.sort((a, b) => a.lastAccess - b.lastAccess);
      for (let i = 0; i < hotPages.length - this.config.maxHotPages; i++) {
        this.demotePage(hotPages[i].pageId, PageTier.WARM);
      }
    }

    const warmPages = this.pages.filter((p) => p.tier === PageTier.WARM);
    if (warmPages.length > this.config.maxWarmPages) {
      warmPages.sort((a, b) => a.lastAccess - b.lastAccess);
      for (let i = 0; i < warmPages.length - this.config.maxWarmPages; i++) {
        this.demotePage(warmPages[i].pageId, PageTier.COLD);
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Hash helper (for prefix cache keys)
// ═════════════════════════════════════════════════════════════════════════════

export function hashTokenIds(tokenIds: number[]): string {
  // Simple FNV-1a hash for prefix identification
  let hash = 0x811c9dc5;
  for (const t of tokenIds) {
    hash ^= t & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (t >> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (t >> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (t >> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
