/**
 * AILSM Capability Inference — SSAグラフから実行能力を推論する
 *
 * 「Equation + Integral → Math Expert」のように、グラフのノード型から
 * どのドメイン・エキスパートが必要かを決定論的に推論する（ODAR の入力）。
 */

import type { AilsmGraph } from './ailsm.js';
import { simpleTypes } from './types.js';

export interface CapabilityInference {
  domain: string;
  expert: string;
  requiredTypes: string[];
  confidence: number;
}

const EXPERT_OF_DOMAIN: Record<string, string> = {
  math: 'math',
  code: 'code',
  search: 'search',
  reasoning: 'reasoning',
};

export function inferCapability(g: AilsmGraph): CapabilityInference {
  const task = g.nodes.find((n) => n.kind === 'task');
  const domain = task ? String(task.attrs.domain ?? 'unknown') : 'unknown';

  const requiredTypes = [
    ...new Set(
      g.nodes
        .filter((n) => n.kind === 'object' || n.kind === 'value')
        .flatMap((n) => simpleTypes(n.type)),
    ),
  ];

  const signals = g.nodes.filter((n) => n.kind === 'object' || n.kind === 'value').length;
  return {
    domain,
    expert: EXPERT_OF_DOMAIN[domain] ?? 'general',
    requiredTypes,
    confidence: Math.min(1, 0.5 + signals * 0.1),
  };
}
