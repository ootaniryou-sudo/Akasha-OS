/**
 * LiveCodeBench Suite（Phase 4.1）— 競技プログラミング（外部ベンチの再現用サブセット）
 */

import type { BenchSample, BenchSuite } from './types.js';

const s = (id: string, prompt: string, reference: string, difficulty: number): BenchSample => ({ id, prompt, reference, difficulty });

export const livecodebenchSuite: BenchSuite = {
  id: 'livecodebench',
  name: 'LiveCodeBench',
  category: 'coding',
  samples: [
    s('l1', '区間の最大重複数を O(n log n) で求める関数 max_overlap を実装せよ', 'ソート+スイープ', 0.55),
    s('l2', '二分木の直径を O(n) で求める関数 tree_diameter を実装せよ', 'DFS', 0.6),
    s('l3', '文字列の最小部分列で回文を構成する関数 min_palindrome を実装せよ', 'DP', 0.65),
    s('l4', '行列の累乗を O(n^3 log k) で計算する関数 mat_pow を実装せよ', '高速冪乗', 0.7),
    s('l5', '負の辺を含むグラフの最短経路（ベルマンフォード）を実装せよ', 'O(VE)', 0.75),
    s('l6', '最大フロー（フォードファルカーソン）を実装せよ', '増加パス', 0.8),
    s('l7', 'セグメント木で範囲最小クエリと点更新を実装せよ', 'O(log n)', 0.85),
    s('l8', '木の重心分解で距離が k 以下の組を数える関数 count_pairs を実装せよ', '重心分解', 0.9),
    s('l9', '連結グラフの橋を線形時間で列挙する関数 find_bridges を実装せよ', 'Lowlink', 0.93),
    s('l10', '平面グラフの最大独立集合の近似を実装せよ', '近似アルゴリズム', 0.98),
  ],
};
