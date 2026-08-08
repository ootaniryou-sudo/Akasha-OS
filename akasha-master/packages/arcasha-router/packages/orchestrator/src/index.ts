/**
 * arcasha-orchestrator — 公開 API
 *
 * Belief-Driven AI Orchestration: Planner → LinUCB-Shadow Router → Verifier →
 * EpisodeMemory (Prior μ₀) → Self Reflection → Tree Search。
 * バックエンドは ComputeBackend (WS / Ollama / llama.cpp / WebGPU) で抽象化。
 */

// バックエンド抽象
export type { ComputeBackend } from './backend.js';

// Planner (タスク分解, EXP-0005A/B/C)
export {
  RuleBasedPlanner,
  LLMPlanner,
  llmDecomposePrompt,
  parseSubtasks,
} from './planner.js';
export type { Planner } from './planner.js';

// Verifier
export { Verifier } from './verifier.js';
export type { Verification } from './verifier.js';

// Memory (Episode + Vector + Prior)
export { EpisodeMemory, embedText, cosine } from './memory.js';
export type { Episode, EpisodeDecision } from './memory.js';

// Self Reflection
export { Reflector } from './reflect.js';
export type { Reflection, Remedy } from './reflect.js';

// Tree Search
export { PlanGenerator, TreeSearch } from './search.js';
export type { PlanOutcome, TreeSearchResult } from './search.js';

// Controller
export { ArcAshaController, planScore } from './controller.js';
export type {
  Decision,
  RunResult,
  ReflectiveIteration,
  ReflectiveRun,
} from './controller.js';

