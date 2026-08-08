/**
 * MMLU Suite（Phase 4.1）— 知識・多分野（外部ベンチの再現用サブセット）
 */

import type { BenchSample, BenchSuite } from './types.js';

const s = (id: string, prompt: string, reference: string, difficulty: number): BenchSample => ({ id, prompt, reference, difficulty });

export const mmluSuite: BenchSuite = {
  id: 'mmlu',
  name: 'MMLU',
  category: 'knowledge',
  samples: [
    s('k1', '水の化学式は？', 'H2O', 0.3),
    s('k2', '日本の首都は？', '東京', 0.35),
    s('k3', '光速度はおよそ何 km/s？', '30万 km/s', 0.4),
    s('k4', 'DNA の 4 つの塩基を答えよ', 'A,T,G,C', 0.45),
    s('k5', 'フランス革命が起きた年は？', '1789', 0.5),
    s('k6', '相対性理論を提唱した物理学者は？', 'アインシュタイン', 0.55),
    s('k7', '気候変動の主因とされる温室効果ガスは？', 'CO2', 0.6),
    s('k8', 'デカルトの「我思う、ゆえに我あり」の原語は？', 'Cogito ergo sum', 0.65),
    s('k9', '不完全性定理を証明した数学者は？', 'ゲーデル', 0.7),
    s('k10', '量子もつれの実証実験（2022 ノーベル賞）の受賞者は？', 'アスペ・クラウザー・ザイリンガー', 0.75),
  ],
};

