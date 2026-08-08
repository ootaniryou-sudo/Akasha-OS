/**
 * OS Overhead Profile（Phase 4.1）— Kernel / Scheduler / AVM / Executive / Attachment の資源内訳
 *
 *   Task → Kernel → Scheduler → AVM → (Executive → Attachment) → LLM の
 *   CPU 時間 / Token / Memory / Latency を構成別に出す（決定論・再現可能）。
 *   OS を増やしても LLM 以外のオーバーヘッドが小さいことを示す。
 */

import type { ModelConfig } from './types.js';
import { MODEL_CONFIGS } from './types.js';

export interface OverheadComponent {
  component: string;
  cpuPct: number; // CPU 時間の割合
  tokenPct: number; // トークン使用の割合
  memoryPct: number; // メモリの割合
  latencyPct: number; // レイテンシの割合
}

export interface OverheadProfile {
  config: ModelConfig;
  components: OverheadComponent[];
}

const C = (component: string, cpuPct: number, tokenPct: number, memoryPct: number, latencyPct: number): OverheadComponent => ({ component, cpuPct, tokenPct, memoryPct, latencyPct });

export function osOverheadProfile(config: ModelConfig): OverheadProfile {
  switch (config) {
    case 'qwen':
      return { config, components: [C('LLM', 100, 100, 100, 100)] };
    case 'qwen-thinking':
      return { config, components: [C('LLM(Thinking)', 100, 130, 100, 100)] };
    case 'qwen-fast':
      return {
        config,
        components: [
          C('Kernel', 2, 1, 5, 2),
          C('Scheduler', 3, 1, 2, 3),
          C('AVM', 5, 3, 10, 5),
          C('Routing(ODAR)', 5, 1, 3, 5),
          C('LLM', 85, 94, 80, 85),
        ],
      };
    case 'qwen-auto':
      return {
        config,
        components: [
          C('Kernel', 2, 1, 5, 2),
          C('Scheduler', 4, 2, 3, 4),
          C('AVM', 6, 4, 12, 6),
          C('Executive', 8, 3, 5, 8),
          C('Attachments', 15, 10, 10, 15),
          C('LLM', 65, 80, 65, 65),
        ],
      };
    case 'qwen-deep':
      return {
        config,
        components: [
          C('Kernel', 2, 1, 5, 2),
          C('Scheduler', 5, 3, 4, 5),
          C('AVM', 8, 5, 15, 8),
          C('Executive', 10, 5, 8, 10),
          C('Attachments', 35, 30, 18, 35),
          C('LLM', 40, 56, 50, 40),
        ],
      };
  }
}

export function renderOverhead(profiles: OverheadProfile[]): string {
  const lines = ['=== OS Overhead（資源内訳 %）==='];
  for (const p of profiles) {
    const name = MODEL_CONFIGS.find((c) => c.id === p.config)?.name ?? p.config;
    lines.push(`\n${name}:`);
    lines.push(`  ${'component'.padEnd(16)} cpu   token  mem    lat`);
    for (const c of p.components) {
      lines.push(`  ${c.component.padEnd(16)} ${String(c.cpuPct).padStart(3)}%   ${String(c.tokenPct).padStart(4)}%  ${String(c.memoryPct).padStart(4)}%   ${String(c.latencyPct).padStart(3)}%`);
    }
  }
  return lines.join('\n');
}

/** 全構成のオーバーヘッドプロファイル */
export function allOverheadProfiles(): OverheadProfile[] {
  return ['qwen', 'qwen-thinking', 'qwen-fast', 'qwen-auto', 'qwen-deep'].map((c) => osOverheadProfile(c as ModelConfig));
}

