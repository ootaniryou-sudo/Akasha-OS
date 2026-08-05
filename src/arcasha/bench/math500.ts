/**
 * MATH500 Suite（Phase 4.1）— 競技数学（外部ベンチの再現用サブセット）
 */

import type { BenchSample, BenchSuite } from './types.js';

const s = (id: string, prompt: string, reference: string, difficulty: number): BenchSample => ({ id, prompt, reference, difficulty });

export const math500Suite: BenchSuite = {
  id: 'math500',
  name: 'MATH500',
  category: 'math',
  samples: [
    s('m1', 'x^2 - 5x + 6 = 0 の解を求めよ', 'x=2,3', 0.5),
    s('m2', 'sin(2θ) = 2 sin(θ) cos(θ) を示せ', '恒等式', 0.55),
    s('m3', '行列 [[1,2],[3,4]] の行列式を求めよ', '-2', 0.6),
    s('m4', '円 x^2+y^2=25 上の点 (3,4) における接線を求めよ', '3x+4y=25', 0.65),
    s('m5', '∫ x e^x dx を計算せよ', '(x-1)e^x + C', 0.7),
    s('m6', '3 次方程式 x^3-6x^2+11x-6=0 のすべての解を求めよ', 'x=1,2,3', 0.75),
    s('m7', 'フーリエ級数展開の収束条件を述べよ', 'ディリクレ条件', 0.8),
    s('m8', 'ガロア群が可解でない 5 次方程式の例を挙げよ', 'x^5-x-1=0', 0.85),
    s('m9', 'リーマンゼータ関数の関数等式を述べよ', 'ζ(s)=2^s π^(s-1) sin(πs/2) Γ(1-s) ζ(1-s)', 0.9),
    s('m10', 'ポアンカレ予想の解決に用いた手法を説明せよ', 'リッチフロー', 0.95),
  ],
};
