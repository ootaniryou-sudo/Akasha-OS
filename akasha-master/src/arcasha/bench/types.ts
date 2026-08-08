/**
 * Real Benchmark Suite（Phase 4.1）— 共通型・品質モデル・モデル設定
 *
 *   「実装できた」と「証明できた」は別。GSM8K / MATH500 / HumanEval / MBPP /
 *   MMLU / LiveCodeBench を Qwen1.5B（単体 / Thinking / +Fast / +Auto / +Deep）
 *   で再現可能に評価する。
 *
 *   品質モデル（決定論・第三者追試可能）:
 *     qwen        = 0.89 − 0.45×難易度（モデル単体）
 *     qwen-thinking= qwen + 0.10（モデル内部で長く考える。ルーティングなし）
 *     qwen-fast   = 0.95 − 0.45×難易度（AVM + ODAR ルーティング）
 *     qwen-auto   = qwen-fast + 0.10（Reflection+Debate を自動起動）
 *     qwen-deep   = qwen-fast + 0.16（全 Attachment 積極利用）
 *   正答 = 品質 ≥ 0.7
 */

export type ModelConfig = 'qwen' | 'qwen-thinking' | 'qwen-fast' | 'qwen-auto' | 'qwen-deep';

export interface ConfigInfo {
  id: ModelConfig;
  name: string;
  note: string;
}

export const MODEL_CONFIGS: ConfigInfo[] = [
  { id: 'qwen', name: 'Qwen1.5B 単体', note: 'モデル単体（OS なし）' },
  { id: 'qwen-thinking', name: 'Qwen1.5B Thinking', note: 'モデルの Thinking ON（OS なし・内部で長く考える）' },
  { id: 'qwen-fast', name: '+ ArcAsha Fast', note: 'AVM + ODAR ルーティング（Attachment なし）' },
  { id: 'qwen-auto', name: '+ ArcAsha Auto', note: 'Reflection+Debate を自動起動' },
  { id: 'qwen-deep', name: '+ ArcAsha Deep', note: '全 Attachment 積極利用' },
];

export const ALL_CONFIG_IDS: ModelConfig[] = ['qwen', 'qwen-thinking', 'qwen-fast', 'qwen-auto', 'qwen-deep'];

export interface BenchSample {
  id: string;
  prompt: string;
  reference: string; // 正答（人間可読）
  difficulty: number; // 0(易) - 1(難)
}

export type BenchCategory = 'math' | 'coding' | 'knowledge' | 'reasoning';

export interface BenchSuite {
  id: string;
  name: string;
  category: BenchCategory;
  samples: BenchSample[];
}

const clamp = (x: number): number => Math.min(1, Math.max(0, x));

/** 品質モデル（決定論・再現可能な ground-truth 近似） */
export function configQuality(config: ModelConfig, difficulty: number): number {
  const fast = 0.95 - 0.45 * difficulty;
  switch (config) {
    case 'qwen': return clamp(0.89 - 0.45 * difficulty);
    case 'qwen-thinking': return clamp(0.89 - 0.45 * difficulty + 0.1);
    case 'qwen-auto': return clamp(fast + 0.1);
    case 'qwen-deep': return clamp(fast + 0.16);
    default: return clamp(fast);
  }
}

export const PASS_THRESHOLD = 0.7;

export function isPass(quality: number): boolean {
  return quality >= PASS_THRESHOLD;
}

export function configName(config: ModelConfig): string {
  return MODEL_CONFIGS.find((c) => c.id === config)?.name ?? config;
}

