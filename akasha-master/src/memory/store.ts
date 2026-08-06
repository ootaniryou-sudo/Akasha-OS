/**
 * memory/store.ts — Realm of Knowledge (Memory Fabric)
 *
 * ArcAsha 全体の Memory / Context / Cache を統合管理する基盤。
 * ────────────────────────────────────
 * 会話履歴・長期記憶・KV Cache を同一概念として扱わない
 * Memory subsystem の基盤インターフェース。
 *
 * ## 3層構造
 *
 *   Conversation Store  → 永続（SQLite / IndexedDB）
 *   Context Memory      → 意味検索可能（Vector DB 将来対応）
 *   Runtime KV Cache    → 高速メモリ（GPU VRAM / CPU RAM）
 *
 * ## 設計原則
 *
 *   - 会話履歴を LLM の KV Cache に直接保存しない
 *   - 永続層・検索層・キャッシュ層を分離
 *   - Repository Interface で実装交換可能に
 */

// ═════════════════════════════════════════════════════════════════════════════
// 1. Conversation Store
// ═════════════════════════════════════════════════════════════════════════════

export interface Message {
  conversationId: string;
  messageId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  parentMessageId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface Conversation {
  conversationId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  metadata: Record<string, unknown> | null;
}

export interface ConversationRepository {
  createConversation(title?: string): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  addMessage(msg: Omit<Message, 'messageId'>): Promise<Message>;
  getMessages(conversationId: string, limit?: number): Promise<Message[]>;
  deleteConversation(id: string): Promise<void>;
}

// Common patterns that MUST be allowed across the repository:
export interface SearchRequest {
  query: string;
  maxResults?: number;
  minScore?: number;
  filters?: Record<string, unknown>;
}

export interface SearchMemory {
  id: string;
  type: 'fact' | 'summary' | 'code' | 'document' | 'chunk';
  content: string;
  embedding: Float32Array | null;
  metadata: Record<string, unknown>;
  score?: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Context / Semantic Memory
// ═════════════════════════════════════════════════════════════════════════════

export interface MemoryIndexer {
  /** Index a new memory item. */
  index(item: SearchMemory): Promise<void>;
  /** Search indexed memories. */
  search(req: SearchRequest): Promise<SearchMemory[]>;
  /** Remove a memory by ID. */
  delete(id: string): Promise<void>;
}

export interface MemoryRetriever {
  /** Retrieve memories relevant to a query. */
  retrieve(query: string, maxResults?: number): Promise<SearchMemory[]>;
  /** Retrieve by exact ID. */
  getById(id: string): Promise<SearchMemory | null>;
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Echo (Runtime KV Cache) + Echo Prime (Prefix KV Cache)
// ═════════════════════════════════════════════════════════════════════════════

export interface KVCachePage {
  pageId: number;
  tokenStart: number;
  tokenEnd: number;
  /** Raw KV cache bytes (layout: model-specific). */
  data: ArrayBuffer;
  /** Hash of the prefix for cache key matching. */
  prefixHash: string;
}

export interface PrefixCache {
  /** Store KV pages for a prefix. */
  store(prefixHash: string, pages: KVCachePage[]): void;
  /** Lookup KV pages by prefix hash. */
  lookup(prefixHash: string): KVCachePage[] | null;
  /** Evict least-recently-used pages. */
  evict(maxPages: number): void;
  /** Number of cached pages. */
  size(): number;
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. In-Memory Conversation Store (MVP implementation)
// ═════════════════════════════════════════════════════════════════════════════

let _idCounter = 0;
function _nextId(): string {
  return `msg_${Date.now()}_${(_idCounter++).toString(36)}`;
}

/**
 * Minimal in-memory conversation store.
 * Production: replace with SQLite / IndexedDB / PostgreSQL.
 */
export class InMemoryConversationStore implements ConversationRepository {
  private conversations = new Map<string, Conversation>();

  async createConversation(title = 'New Chat'): Promise<Conversation> {
    const id = `conv_${Date.now()}_${(_idCounter++).toString(36)}`;
    const conv: Conversation = {
      conversationId: id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      metadata: null,
    };
    this.conversations.set(id, conv);
    return conv;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async addMessage(msg: Omit<Message, 'messageId'>): Promise<Message> {
    const conv = this.conversations.get(msg.conversationId);
    if (!conv) throw new Error(`Conversation ${msg.conversationId} not found`);

    const fullMsg: Message = { ...msg, messageId: _nextId() };
    conv.messages.push(fullMsg);
    conv.updatedAt = Date.now();
    return fullMsg;
  }

  async getMessages(conversationId: string, limit = 50): Promise<Message[]> {
    const conv = this.conversations.get(conversationId);
    if (!conv) return [];
    return conv.messages.slice(-limit);
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. In-Memory Prefix Cache (MVP)
// ═════════════════════════════════════════════════════════════════════════════

export class InMemoryPrefixCache implements PrefixCache {
  private cache = new Map<string, { pages: KVCachePage[]; lastAccess: number }>();
  private maxPages: number;

  constructor(maxPages = 1024) {
    this.maxPages = maxPages;
  }

  store(prefixHash: string, pages: KVCachePage[]): void {
    this.cache.set(prefixHash, { pages, lastAccess: Date.now() });
    if (this.cache.size > this.maxPages) {
      this.evict(this.maxPages);
    }
  }

  lookup(prefixHash: string): KVCachePage[] | null {
    const entry = this.cache.get(prefixHash);
    if (!entry) return null;
    entry.lastAccess = Date.now();
    return entry.pages;
  }

  evict(maxPages: number): void {
    if (this.cache.size <= maxPages) return;
    const sorted = [...this.cache.entries()].sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess,
    );
    for (let i = 0; i < sorted.length - maxPages; i++) {
      this.cache.delete(sorted[i][0]);
    }
  }

  size(): number {
    return this.cache.size;
  }
}
