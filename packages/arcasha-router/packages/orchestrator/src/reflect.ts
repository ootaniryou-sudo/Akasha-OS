/**
 * @arcasha/orchestrator — Self Reflection (Belief-Driven Self-Improvement)
 *
 * Verifier が失敗を検出 → Reflector が Belief (μ, n) から原因診断 →
 * Planner が次プラン生成 (re-route / committee / re-decompose) → 再実行 → 改善時のみ採用。
 */

import type { BeliefSnapshot } from '@arcasha/belief';
import type { Capability, Decomposition, Subtask } from '@arcasha/core';
import type { RunResult } from './controller.js';

type BeliefMap = Record<string, Record<Capability, BeliefSnapshot>>;

export type Remedy = 're-route' | 'committee' | 're-decompose' | 'none';

export interface Reflection {
  subtaskId: string;
  cause: string; // 'refusal' | 'expert-capability' | 'low-confidence' | 'task-hard' | 'unknown'
  remedy: Remedy;
  detail: string;
}

const REFUSAL_WORDS = ['sorry', 'cannot', 'unable', 'as an ai', 'i am'];

function argmaxBelief(beliefs: BeliefMap, cap: Capability): string {
  return Object.entries(beliefs).sort((a, b) => b[1][cap].mu - a[1][cap].mu)[0][0];
}

export class Reflector {
  constructor(private readonly beliefs: () => BeliefMap) {}

  reflect(run: RunResult): Reflection[] {
    const beliefs = this.beliefs();
    const out: Reflection[] = [];
    for (const v of run.verifications) {
      if (v.passed) continue;
      const d = run.decisions.find(x => x.subtask.id === v.subtask.id);
      const text = d?.result.text ?? '';
      const nodeId = d?.nodeId ?? '';
      const cap = v.subtask.capability;
      const nodeBelief = beliefs[nodeId]?.[cap];
      const all = Object.values(beliefs).map(b => b[cap]);
      const maxMu = Math.max(...all.map(b => b.mu));
      const bestNode = argmaxBelief(beliefs, cap);

      if (REFUSAL_WORDS.some(w => text.toLowerCase().includes(w))) {
        out.push({ subtaskId: v.subtask.id, cause: 'refusal', remedy: 're-route', detail: `${nodeId} refused; best-believed=${bestNode}` });
      } else if (nodeBelief && maxMu - nodeBelief.mu > 0.15 && maxMu > 0.3) {
        out.push({ subtaskId: v.subtask.id, cause: 'expert-capability', remedy: 're-route', detail: `${nodeId} μ=${nodeBelief.mu.toFixed(3)} < max ${maxMu.toFixed(3)} (${bestNode})` });
      } else if (nodeBelief && nodeBelief.n < 4) {
        out.push({ subtaskId: v.subtask.id, cause: 'low-confidence', remedy: 'committee', detail: `${nodeId} n=${nodeBelief.n}` });
      } else if (maxMu < 0.3) {
        out.push({ subtaskId: v.subtask.id, cause: 'task-hard', remedy: 're-decompose', detail: `max μ=${maxMu.toFixed(3)}` });
      } else {
        out.push({ subtaskId: v.subtask.id, cause: 'unknown', remedy: 'none', detail: 'no remedy' });
      }
    }
    return out;
  }

  remedyPlan(run: RunResult, plan: Decomposition): Decomposition | null {
    const reflections = this.reflect(run);
    const byId = new Map(reflections.map(r => [r.subtaskId, r]));
    const beliefs = this.beliefs();
    let changed = false;
    const subtasks: Subtask[] = [];
    for (const st of plan.subtasks) {
      const ref = byId.get(st.id);
      if (!ref || ref.remedy === 'none') { subtasks.push(st); continue; }
      changed = true;
      if (ref.remedy === 're-route') {
        const routed = run.decisions.find(x => x.subtask.id === st.id)?.nodeId;
        const bestNode = argmaxBelief(beliefs, st.capability);
        subtasks.push(bestNode === routed ? { ...st, expertPolicy: { topK: 2 } } : { ...st, expertPolicy: { force: bestNode } });
      } else if (ref.remedy === 'committee') {
        subtasks.push({ ...st, expertPolicy: { topK: 2 } });
      } else if (ref.remedy === 're-decompose') {
        subtasks.push(
          { ...st, id: `${st.id}-a`, order: st.order, role: `${st.role}:part1`, prompt: `Part 1 — ${st.prompt}` },
          { ...st, id: `${st.id}-b`, order: st.order + 1, role: `${st.role}:part2`, prompt: `Part 2 — ${st.prompt}` },
        );
      }
    }
    if (!changed) return null;
    return {
      ...plan,
      subtasks,
      rationale: `${plan.rationale} → reflect(${reflections.map(r => r.cause).join(',')})`,
    };
  }
}
