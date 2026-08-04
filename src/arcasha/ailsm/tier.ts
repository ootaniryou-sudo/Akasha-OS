/**
 * Hot / Warm / Cold Memory Tier（Phase 0.22）— AI メモリ階層の最上位
 *
 * CPU のキャッシュ階層（L1/L2/Memory/Disk）に相当するアクセス頻度ベースの階層。
 *
 *   HOT  : 頻繁にアクセス（resident 維持）— アクセス回数 >= HOT_ACCESS
 *   WARM : 最近アクセス（resident 維持候補）
 *   COLD : ほぼ未使用（必要になったら Demand Paging でロード）
 *
 * Touch するたびに昇格し、未使用ページは COLD へ降格して evict（resident から除外）できる。
 */

export type MemoryTier = 'hot' | 'warm' | 'cold';

export const HOT_ACCESS = 3; // 3回以上アクセスで HOT

export interface TierCounts {
  hot: number;
  warm: number;
  cold: number;
}

export class TierManager {
  private readonly access = new Map<number, number>();
  private readonly tier = new Map<number, MemoryTier>();

  /** ページへアクセス（回数を増やし昇格）。返り値は更新後の階層 */
  touch(pageId: number): MemoryTier {
    const count = (this.access.get(pageId) ?? 0) + 1;
    this.access.set(pageId, count);
    const t: MemoryTier = count >= HOT_ACCESS ? 'hot' : 'warm';
    this.tier.set(pageId, t);
    return t;
  }

  tierOf(pageId: number): MemoryTier {
    return this.tier.get(pageId) ?? 'cold';
  }

  accessCount(pageId: number): number {
    return this.access.get(pageId) ?? 0;
  }

  counts(): TierCounts {
    const out: TierCounts = { hot: 0, warm: 0, cold: 0 };
    for (const t of this.tier.values()) out[t]++;
    return out;
  }

  /** COLD ページを列挙（resident set から evict する候補） */
  evictCold(): number[] {
    return [...this.tier.entries()]
      .filter(([, t]) => t === 'cold')
      .map(([id]) => id);
  }

  /** 未アクセスページ（tier 未登録 = COLD 扱い）を列挙 */
  untrackedPages(allPageIds: number[]): number[] {
    return allPageIds.filter((id) => !this.tier.has(id));
  }
}
