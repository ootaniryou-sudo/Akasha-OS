/**
 * AI Profiler（Phase 0.23）— Hot Expert / Hot Context / Hot Pages / Fault Hotspot
 *
 * どこが一番時間を食っているか、どこで Fault が集中しているかを可視化する。
 *   - Hot Expert   : 最も時間を消費した Expert
 *   - Hot Context  : 最もアクセスされた Context
 *   - Hot Pages    : アクセス回数上位のページ
 *   - Fault Hotspot: Fault が集中するページ
 */

export interface ExpertProfile {
  expert: string;
  ms: number;
  share: number; // 全 Expert 時間に対する割合
}

export interface PageProfile {
  pageId: number;
  contextId: number;
  accesses: number;
}

export interface FaultHotspot {
  pageId: number;
  faults: number;
}

export interface ProfileResult {
  hotExpert: ExpertProfile | null;
  hotContext: { contextId: number; accesses: number } | null;
  hotPages: PageProfile[];
  faultHotspots: FaultHotspot[];
  totalExpertMs: number;
  totalAccesses: number;
  totalFaults: number;
}

export class AiProfiler {
  private readonly expertMs = new Map<string, number>();
  private readonly pageAccess = new Map<number, { contextId: number; accesses: number }>();
  private readonly faults = new Map<number, number>();

  recordExpert(expert: string, ms: number): void {
    this.expertMs.set(expert, (this.expertMs.get(expert) ?? 0) + ms);
  }

  recordPageAccess(pageId: number, contextId: number): void {
    const s = this.pageAccess.get(pageId) ?? { contextId, accesses: 0 };
    s.accesses++;
    s.contextId = contextId;
    this.pageAccess.set(pageId, s);
  }

  recordFault(pageId: number): void {
    this.faults.set(pageId, (this.faults.get(pageId) ?? 0) + 1);
  }

  profile(): ProfileResult {
    const totalExpertMs = [...this.expertMs.values()].reduce((a, b) => a + b, 0);
    const hotExpertEntry = [...this.expertMs.entries()].sort((a, b) => b[1] - a[1])[0];
    const hotExpert: ExpertProfile | null = hotExpertEntry
      ? { expert: hotExpertEntry[0], ms: hotExpertEntry[1], share: totalExpertMs === 0 ? 0 : hotExpertEntry[1] / totalExpertMs }
      : null;

    const byContext = new Map<number, number>();
    let totalAccesses = 0;
    for (const { contextId, accesses } of this.pageAccess.values()) {
      byContext.set(contextId, (byContext.get(contextId) ?? 0) + accesses);
      totalAccesses += accesses;
    }
    const hotContextEntry = [...byContext.entries()].sort((a, b) => b[1] - a[1])[0];
    const hotContext = hotContextEntry ? { contextId: hotContextEntry[0], accesses: hotContextEntry[1] } : null;

    const hotPages: PageProfile[] = [...this.pageAccess.entries()]
      .map(([pageId, s]) => ({ pageId, contextId: s.contextId, accesses: s.accesses }))
      .sort((a, b) => b.accesses - a.accesses)
      .slice(0, 3);

    const faultHotspots: FaultHotspot[] = [...this.faults.entries()]
      .map(([pageId, f]) => ({ pageId, faults: f }))
      .sort((a, b) => b.faults - a.faults)
      .slice(0, 3);

    return {
      hotExpert,
      hotContext,
      hotPages,
      faultHotspots,
      totalExpertMs,
      totalAccesses,
      totalFaults: [...this.faults.values()].reduce((a, b) => a + b, 0),
    };
  }

  /** profiler テキスト表示（Hot Expert 等） */
  render(): string {
    const p = this.profile();
    const lines: string[] = ['=== aiperf profile ==='];
    lines.push(`Hot Expert   : ${p.hotExpert ? `${p.hotExpert.expert} (${p.hotExpert.ms}ms, ${(p.hotExpert.share * 100).toFixed(0)}%)` : '-'}`);
    lines.push(`Hot Context  : ${p.hotContext ? `#${p.hotContext.contextId} (${p.hotContext.accesses} accesses)` : '-'}`);
    lines.push('Hot Pages    :');
    for (const hp of p.hotPages) lines.push(`  Page#${hp.pageId} ${hp.accesses}回`);
    lines.push('Fault Hotspot:');
    for (const fh of p.faultHotspots) lines.push(`  Page#${fh.pageId} ${fh.faults}Faults`);
    return lines.join('\n');
  }
}

