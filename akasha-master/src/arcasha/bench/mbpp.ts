/**
 * MBPP Suite（Phase 4.1）— 基本プログラミング（外部ベンチの再現用サブセット）
 */

import type { BenchSample, BenchSuite } from './types.js';

const s = (id: string, prompt: string, reference: string, difficulty: number): BenchSample => ({ id, prompt, reference, difficulty });

export const mbppSuite: BenchSuite = {
  id: 'mbpp',
  name: 'MBPP',
  category: 'coding',
  samples: [
    s('b1', '2 数の最大値を返す関数 max2 を実装せよ', 'max(a,b)', 0.2),
    s('b2', '偶数判定をする関数 is_even を実装せよ', 'n%2==0', 0.25),
    s('b3', 'リストの平均を返す関数 average を実装せよ', 'sum/len', 0.3),
    s('b4', '文字列の母音の数を数える関数 count_vowels を実装せよ', 'a,e,i,o,u', 0.35),
    s('b5', '階乗を計算する関数 factorial を実装せよ', '再帰/ループ', 0.4),
    s('b6', '回文判定をする関数 is_palindrome を実装せよ', 's==s[::-1]', 0.45),
    s('b7', 'リストを昇順にソートする関数 sort_list を実装せよ', 'sorted()', 0.5),
    s('b8', '文字列中の指定文字の出現回数を返す関数 count_char を実装せよ', 'count()', 0.55),
    s('b9', '2 つのリストの共通要素を返す関数 intersection を実装せよ', 'set&set', 0.6),
    s('b10', 'ネストした辞書の値を再帰的に合計する関数 deep_sum を実装せよ', '再帰', 0.65),
  ],
};

