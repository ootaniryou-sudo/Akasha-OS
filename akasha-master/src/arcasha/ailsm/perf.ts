/**
 * AI Performance Monitor（Phase 0.23）— aiperf
 *
 * CPU の perf / top / vmstat / htop に相当する AI OS 版モニタ。
 * 標準メトリクス:
 *   - Context Fault Rate（ページ要求のうち Fault した割合）
 *   - TLB Hit Rate（Context 翻訳キャッシュの効率）
 *   - Memory Tier 使用率（HOT / WARM / COLD）
 *   - CALL 統計（Expert ごとの呼び出し回数・時間）
 *   - Expert 利用率（全 CALL 時間に占める割合）
 */

import type { ContextTlb } from './context-tlb.js';
import type { TierCounts, TierManager } from './tier.js';

export interface PerfCallStat {
  expert: string;
  count: number;
  totalMs: number;
  share: number; // 全 CALL 時間に対する割合
}

export interface PerfSnapshot {
  calls: PerfCallStat[];
  pageRequests: number;
  faults: number;
  faultRate: number; // Context Fault Rate
  tlbHitRate: number;
  tiers: TierCounts;
  totalMs: number;
  expertUtilization: Record<string, number>; // %
}

export class AiPerf {
  private readonly callStats = new Map<string, { count: number; totalMs: number }>();
  private pageRequests = 0;
  private faults = 0;
  private totalMs = 0;
  private tlb: ContextTlb | null = null;
  private tier: TierManager | null = null;

  attach(tlb: ContextTlb, tier: TierManager): void {
    this.tlb = tlb;
    this.tier = tier;
  }

  /** Expert CALL を記録 */
  beginCall(expert: string, ms: number): void {
    const s = this.callStats.get(expert) ?? { count: 0, totalMs: 0 };
    s.count++;
    s.totalMs += ms;
    this.callStats.set(expert, s);
    this.totalMs += ms;
  }

  /** ページ要求（Context Fault の有無）を記録 */
  recordPageRequest(faulted: boolean): void {
    this.pageRequests++;
    if (faulted) this.faults++;
  }

  faultRate(): number {
    return this.pageRequests === 0 ? 0 : this.faults / this.pageRequests;
  }

  snapshot(): PerfSnapshot {
    const calls: PerfCallStat[] = [...this.callStats.entries()]
      .map(([expert, s]) => ({
        expert,
        count: s.count,
        totalMs: s.totalMs,
        share: this.totalMs === 0 ? 0 : s.totalMs / this.totalMs,
      }))
      .sort((a, b) => b.totalMs - a.totalMs);
    const expertUtilization: Record<string, number> = {};
    for (const c of calls) expertUtilization[c.expert] = Math.round(c.share * 1000) / 10;
    return {
      calls,
      pageRequests: this.pageRequests,
      faults: this.faults,
      faultRate: this.faultRate(),
      tlbHitRate: this.tlb?.hitRate() ?? 0,
      tiers: this.tier?.counts() ?? { hot: 0, warm: 0, cold: 0 },
      totalMs: this.totalMs,
      expertUtilization,
    };
  }

  /** aiperf コマンド風のテキスト表示（vmstat / top 相当） */
  render(): string {
    const s = this.snapshot();
    const lines: string[] = ['=== aiperf ==='];
    lines.push(`Page Requests : ${s.pageRequests}`);
    lines.push(`Context Faults: ${s.faults} (${(s.faultRate * 100).toFixed(1)}%)`);
    lines.push(`TLB Hit Rate  : ${(s.tlbHitRate * 100).toFixed(1)}%`);
    lines.push(`Memory Tier   : HOT=${s.tiers.hot} WARM=${s.tiers.warm} COLD=${s.tiers.cold}`);
    lines.push(`Total CALL ms : ${s.totalMs}`);
    lines.push('CALL          :');
    for (const c of s.calls) {
      lines.push(`  ${c.expert.padEnd(10)} ${String(c.count).padStart(3)}回  ${String(c.totalMs).padStart(5)}ms  ${(c.share * 100).toFixed(0).padStart(3)}%`);
    }
    return lines.join('\n');
  }
}
