/**
 * ArcAsha — Benchmark Tasks (評価用保持タスク)
 *
 * ウォームアップ (EXP-0003 prompts.jsonl 24 件) には含まれない保持タスク。
 * coding / math / reasoning を各 3 件。フレームワーク比較実験 (benchmark.ts) で使用。
 *
 * 論文化の際は HumanEval / MBPP (coding), GSM8K (math), 論理推論セットに置き換え可能。
 */

import type { Capability, Task } from '../core/types.js';

interface RawTask {
  capability: Capability;
  prompt: string;
}

export const BENCHMARK_TASKS: RawTask[] = [
  // ── coding (HumanEval/MBPP 風) ─────────────────────────────
  { capability: 'coding', prompt: 'Write a Python function that finds the longest common prefix among a list of strings.' },
  { capability: 'coding', prompt: 'Write a Python function that returns the nth Fibonacci number using iteration (no recursion).' },
  { capability: 'coding', prompt: 'Write a Python function that counts how many vowels are in a given string.' },
  // ── math (GSM8K 風) ────────────────────────────────────────
  { capability: 'math', prompt: 'What is the sum of all integers from 1 to 50?' },
  { capability: 'math', prompt: 'If 3 apples cost $2.40, how much do 5 apples cost?' },
  { capability: 'math', prompt: 'Solve for x: 2(x + 3) = 16' },
  // ── reasoning (論理/常識) ──────────────────────────────────
  { capability: 'reasoning', prompt: 'A farmer has 17 sheep. All but 9 run away. How many are left?' },
  { capability: 'reasoning', prompt: 'If all roses are flowers, and some flowers fade quickly, can we conclude that some roses fade quickly? Explain.' },
  { capability: 'reasoning', prompt: 'In a race, you pass the person in second place. What place are you in now? Explain.' },
];

export function benchmarkTasks(): Task[] {
  return BENCHMARK_TASKS.map((t, i) => ({ id: `bench-${i}`, capability: t.capability, prompt: t.prompt }));
}
