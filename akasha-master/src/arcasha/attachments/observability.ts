/**
 * Attachment Monitor（Phase 3.0）— Attachment の計測器
 *
 *   AI Monitor を拡張し、Attachment ごとに
 *     Timeline / Cost / Latency / Accuracy / Calls を表示する。
 *   （Core には触れず、Attachment 層だけで完結するオプションの観測器）
 */

export interface AttachmentCall {
  id: string;
  name: string;
  latencyMs: number;
  quality: number;
  cost: number;
  calls: number;
  tokens: number;
  at: number; // 呼び出し順
}

export class AttachmentMonitor {
  private calls: AttachmentCall[] = [];
  private seq = 0;

  record(c: Omit<AttachmentCall, 'at'>): void {
    this.calls.push({ ...c, at: this.seq++ });
  }

  all(): AttachmentCall[] {
    return [...this.calls];
  }

  byId(id: string): AttachmentCall[] {
    return this.calls.filter((c) => c.id === id);
  }

  totals(): { calls: number; avgLatency: number; avgQuality: number; cost: number; tokens: number } {
    const n = this.calls.length;
    return {
      calls: n,
      avgLatency: n === 0 ? 0 : this.calls.reduce((s, c) => s + c.latencyMs, 0) / n,
      avgQuality: n === 0 ? 0 : this.calls.reduce((s, c) => s + c.quality, 0) / n,
      cost: this.calls.reduce((s, c) => s + c.cost, 0),
      tokens: this.calls.reduce((s, c) => s + c.tokens, 0),
    };
  }

  /** Attachment Timeline（時系列） */
  timeline(): string {
    const lines = ['=== Attachment Timeline ==='];
    for (const c of this.calls) {
      lines.push(`  t=${String(c.at).padStart(2)} ${c.id.padEnd(12)} lat=${c.latencyMs}ms q=${c.quality.toFixed(2)} calls=${c.calls} tok=${c.tokens}`);
    }
    return lines.join('\n');
  }

  /** 集計表示（Cost / Latency / Accuracy / Calls） */
  render(): string {
    const lines = ['=== Attachment Monitor ==='];
    const t = this.totals();
    lines.push(`  Calls     : ${t.calls}`);
    lines.push(`  AvgLatency: ${t.avgLatency.toFixed(0)}ms`);
    lines.push(`  AvgAccuracy: ${t.avgQuality.toFixed(2)}`);
    lines.push(`  TotalCost : ${t.cost.toFixed(2)}`);
    lines.push(`  Tokens    : ${t.tokens}`);
    lines.push('');
    lines.push(this.timeline());
    return lines.join('\n');
  }
}

