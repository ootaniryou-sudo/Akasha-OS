/**
 * AI Reasoning Scheduler — 優先度ベースの決定論スケジューラ（AI OS の CPU Scheduler 相当）
 *
 * Schedule SSA が「Expert 選択」なのに対し、Reasoning Scheduler は
 * 「どのプロセス/スレッドを実行するか」（実行順・プリエンプション）を決める。
 *
 * 決定論ルール:
 *   - pickNext: 最高優先度の ready プロセス（同点はプロセスID昇順）
 *   - pickRoundRobin: カーソル以降の next ready（公平性）
 */

export type RuntimeEventKind =
  | 'SPAWN' | 'CALL' | 'RETURN' | 'YIELD' | 'WAIT' | 'RESUME'
  | 'PREEMPT' | 'TIMEOUT' | 'FAIL' | 'FINISH';

export interface RuntimeEvent {
  seq: number;
  kind: RuntimeEventKind;
  processId?: number;
  threadId?: number;
  detail: string;
}

export interface ExecutionTrace {
  events: RuntimeEvent[];
}

export interface ScheduledUnit {
  processId: number;
  priority: number;
  owner: string;
  state: string; // created / ready / running / waiting / finished / failed
}

/** 最高優先度の ready プロセスを選択（同点はプロセスID昇順 — 100%決定論） */
export function pickNext(units: ScheduledUnit[]): ScheduledUnit | undefined {
  let best: ScheduledUnit | undefined;
  for (const u of units) {
    if (u.state !== 'ready') continue;
    if (
      best === undefined ||
      u.priority > best.priority ||
      (u.priority === best.priority && u.processId < best.processId)
    ) {
      best = u;
    }
  }
  return best;
}

/** ラウンドロビン: cursor より後ろの next ready（決定論） */
export function pickRoundRobin(
  units: ScheduledUnit[],
  cursor: number,
): { unit: ScheduledUnit; next: number } | undefined {
  const ready = units.filter((u) => u.state === 'ready').sort((a, b) => a.processId - b.processId);
  if (ready.length === 0) return undefined;
  let idx = ready.findIndex((u) => u.processId > cursor);
  if (idx === -1) idx = 0;
  const unit = ready[idx];
  return { unit, next: unit.processId };
}

