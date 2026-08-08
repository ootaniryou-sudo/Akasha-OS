/**
 * AI Trace（Phase 0.23）— Chrome Trace 互換の実行タイムライン
 *
 * LLVM / TensorBoard に相当する可視化基盤。Runtime Timeline（コンパイル→CALL→RETURN→
 * Reflection→Finish）と Scheduler Timeline（プロセス別）を Chrome Trace 形式
 * （{ traceEvents: [...] }）で出力し、ブラウザの chrome://tracing や Perfetto で見られる。
 */

export type TracePhase = 'B' | 'E' | 'X' | 'i';

export interface TraceEvent {
  name: string;
  ph: TracePhase;
  ts: number; // microseconds
  pid: number;
  tid: number;
  dur?: number;
  args?: Record<string, string | number>;
}

export class AiTrace {
  private readonly events: TraceEvent[] = [];
  private clock = 0; // μs
  private readonly open = new Map<string, { ts: number; pid: number; tid: number }>();

  /** 時間を進める（決定論） */
  advance(us: number): void {
    this.clock += us;
  }

  now(): number {
    return this.clock;
  }

  begin(name: string, pid = 0, tid = 0): void {
    this.open.set(`${pid}:${tid}:${name}`, { ts: this.clock, pid, tid });
  }

  end(name: string, pid = 0, tid = 0): void {
    const o = this.open.get(`${pid}:${tid}:${name}`);
    if (!o) return;
    this.events.push({ name, ph: 'X', ts: o.ts, pid, tid, dur: Math.max(1, this.clock - o.ts) });
    this.open.delete(`${pid}:${tid}:${name}`);
  }

  instant(name: string, pid = 0, tid = 0, args?: Record<string, string | number>): void {
    this.events.push({ name, ph: 'i', ts: this.clock, pid, tid, args });
  }

  /** complete イベント（ts から dur だけ進める） */
  complete(name: string, durUs: number, pid = 0, tid = 0, args?: Record<string, string | number>): void {
    this.events.push({ name, ph: 'X', ts: this.clock, pid, tid, dur: Math.max(1, durUs), args });
    this.clock += durUs;
  }

  eventsList(): TraceEvent[] {
    return [...this.events];
  }

  /** Chrome Trace JSON（chrome://tracing / Perfetto 互換） */
  toChromeTrace(): string {
    return JSON.stringify({ traceEvents: this.events }, null, 2);
  }
}

export interface TraceStepLike {
  kind: string;
  label: string;
}

export interface TraceEventLike {
  kind: string;
  processId?: number;
  threadId?: number;
  detail: string;
}

/** RuntimeStep 列 → Chrome Trace タイムライン（1 ステップ = 1ms = 1000μs） */
export function buildRuntimeTrace(steps: TraceStepLike[]): TraceEvent[] {
  const tr = new AiTrace();
  for (const s of steps) {
    tr.complete(s.kind, 1000, 0, 0, { step: s.label });
  }
  return tr.eventsList();
}

/** Scheduler イベント列 → Chrome Trace タイムライン（プロセス別・1 イベント = 500μs） */
export function buildSchedulerTrace(events: TraceEventLike[]): TraceEvent[] {
  const tr = new AiTrace();
  for (const e of events) {
    tr.complete(e.kind, 500, e.processId ?? 0, e.threadId ?? 0, { detail: e.detail });
  }
  return tr.eventsList();
}

/** タイムラインの人間可読表示（Timeline 0ms Compile / 1ms Parse ...） */
export function renderTimeline(events: TraceEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    const ms = (e.ts / 1000).toFixed(1);
    const dur = e.dur !== undefined ? ` (${(e.dur / 1000).toFixed(1)}ms)` : '';
    lines.push(`${ms.padStart(7)}ms ${e.name}${dur}`);
  }
  return lines.join('\n');
}

