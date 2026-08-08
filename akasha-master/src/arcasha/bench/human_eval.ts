/**
 * HumanEval Suite（Phase 4.1）— 関数実装（外部ベンチの再現用サブセット）
 */

import type { BenchSample, BenchSuite } from './types.js';

const s = (id: string, prompt: string, reference: string, difficulty: number): BenchSample => ({ id, prompt, reference, difficulty });

export const humanEvalSuite: BenchSuite = {
  id: 'human_eval',
  name: 'HumanEval',
  category: 'coding',
  samples: [
    s('h1', '与えられたリストの合計を返す関数 sum_list を実装せよ', 'sum()', 0.4),
    s('h2', '文字列を反転する関数 reverse を実装せよ', 's[::-1]', 0.45),
    s('h3', 'FizzBuzz を返す関数 fizzbuzz(n) を実装せよ', 'Fizz/Buzz/FizzBuzz', 0.5),
    s('h4', '二分探索で要素の有無を返す関数 binary_search を実装せよ', 'O(log n)', 0.55),
    s('h5', '連結リストを逆順にする関数 reverse_list を実装せよ', 'O(n)', 0.6),
    s('h6', '有向グラフでトポロジカルソートする関数 topo_sort を実装せよ', 'DFS/Kahn', 0.65),
    s('h7', '二分木を BFS で走査する関数 bfs を実装せよ', 'キュー', 0.7),
    s('h8', '最長共通部分列の長さを返す関数 lcs を実装せよ', 'DP', 0.75),
    s('h9', 'ダイクストラ法で最短経路を返す関数 dijkstra を実装せよ', '優先度付きキュー', 0.8),
    s('h10', 'メモ化されたフィボナッチの並列版を実装せよ', '並列 DP', 0.85),
  ],
};
