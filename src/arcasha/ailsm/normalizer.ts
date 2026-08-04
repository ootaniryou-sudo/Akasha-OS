/**
 * AILSM Normalizer — Stage 1: 同義語を正準語へ畳み込む（100% 決定論）
 *
 * 足してください / 加えて / 和を求めよ  →  ACTION_ADD
 * 円 / 円形 / Circle                  →  circle
 *
 * 辞書で判定できない部分だけが Stage 2（LLM残差）へ委譲される。
 */

import type { Token } from './lexer.js';

export type Intent = 'solve' | 'summarize' | 'search' | 'verify' | 'code' | 'unknown';
export type Domain = 'math' | 'code' | 'search' | 'reasoning' | 'unknown';

export type CanonicalAction =
  | 'ACTION_ADD' | 'ACTION_SUBTRACT' | 'ACTION_MULTIPLY' | 'ACTION_DIVIDE'
  | 'ACTION_SQRT' | 'ACTION_SQUARE'
  | 'ACTION_INTEGRAL' | 'ACTION_DERIVE' | 'ACTION_LIMIT' | 'ACTION_EQUATION' | 'ACTION_MATRIX';

export interface NormalizedInput {
  intent: Intent;
  domain: Domain;
  actions: CanonicalAction[];
  objects: string[];
  attributes: { name: string; value: string }[];
  numbers: number[];
  variables: string[];
  rawMath: string[];
  output: string | null;
  inputText: string;
  confidence: number; // 0..1
}

export const ACTION_SYNONYMS: Record<CanonicalAction, readonly string[]> = {
  ACTION_ADD: ['足し算', '足す', '足して', '足してください', '加える', '加えて', 'たす', 'たし算', '加算', '合計', '和を求める', '和を求めよ'],
  ACTION_SUBTRACT: ['引き算', '引く', '引いて', '減算', '差を求める', '減らす'],
  ACTION_MULTIPLY: ['掛け算', '掛ける', '掛けて', 'かける', 'かけて', '乗算', '積を求める'],
  ACTION_DIVIDE: ['割り算', '割って', '割り', '割る', '除算', '商を求める'],
  ACTION_SQRT: ['平方根', 'ルート', '√'],
  ACTION_SQUARE: ['二乗', '平方'],
  ACTION_INTEGRAL: ['積分', 'インテグラル'],
  ACTION_DERIVE: ['微分', 'デリバティブ', '導関数'],
  ACTION_LIMIT: ['極限', 'リミット'],
  ACTION_EQUATION: ['方程式', '等式'],
  ACTION_MATRIX: ['行列', 'マトリックス'],
};

const INTENT_WORDS: { intent: Intent; words: readonly string[] }[] = [
  { intent: 'solve', words: ['解いて', '解け', '求めよ', '求めて', '計算して', '計算', '積分', '微分', '極限', '方程式', 'solve', 'calculate'] },
  { intent: 'summarize', words: ['要約', 'まとめて', '要旨', 'summarize'] },
  { intent: 'search', words: ['検索', '探して', '調べて', 'search'] },
  { intent: 'verify', words: ['検証', '確認して', 'verify'] },
  { intent: 'code', words: ['コード', 'プログラム', '関数を書いて', 'バグ修正', '修正して'] },
];

const OBJECT_SYNONYMS: Record<string, readonly string[]> = {
  circle: ['円形', '円', 'サークル'],
  square: ['正方形', '四角形'],
  triangle: ['三角形', '三角'],
  matrix: ['行列'],
  function: ['関数', 'ファンクション'],
};

const ATTRIBUTE_SYNONYMS: Record<string, readonly string[]> = {
  radius: ['半径'],
  diameter: ['直径'],
  area: ['面積'],
  perimeter: ['周囲', '周長', '外周'],
  side: ['一辺', '辺'],
};

const OUTPUT_SYNONYMS: Record<string, readonly string[]> = {
  area: ['面積'],
  perimeter: ['周囲', '周長', '外周'],
};

export function normalize(text: string, tokens: Token[]): NormalizedInput {
  const t = text.trim();

  let intent: Intent = 'unknown';
  for (const p of INTENT_WORDS) {
    if (p.words.some((w) => t.includes(w))) {
      intent = p.intent;
      break;
    }
  }

  const actions: CanonicalAction[] = [];
  for (const [action, words] of Object.entries(ACTION_SYNONYMS) as [CanonicalAction, readonly string[]][]) {
    if (words.some((w) => t.includes(w))) actions.push(action);
  }

  const objects: string[] = [];
  for (const [obj, words] of Object.entries(OBJECT_SYNONYMS)) {
    if (words.some((w) => t.includes(w))) objects.push(obj);
  }

  const attributes: { name: string; value: string }[] = [];
  for (const [name, words] of Object.entries(ATTRIBUTE_SYNONYMS)) {
    let pos = -1;
    let matched = '';
    for (const w of words) {
      const idx = t.indexOf(w);
      if (idx >= 0 && idx > pos) {
        pos = idx;
        matched = w;
      }
    }
    if (pos >= 0) {
      const m = /^\s*(\d+(?:\.\d+)?)/.exec(t.slice(pos + matched.length));
      attributes.push({ name, value: m ? m[1] : '' });
    }
  }

  const numbers = tokens.filter((tk) => tk.type === 'number').map((tk) => Number(tk.value));
  const variables = [...new Set(tokens.filter((tk) => tk.type === 'variable').map((tk) => tk.value))];
  const rawMath = tokens.filter((tk) => tk.type === 'math').map((tk) => tk.value);

  let output: string | null = null;
  for (const [outName, words] of Object.entries(OUTPUT_SYNONYMS)) {
    if (words.some((w) => t.includes(w))) {
      output = outName;
      break;
    }
  }

  let domain: Domain = 'unknown';
  if (actions.length > 0 || rawMath.length > 0 || intent === 'solve' || objects.some((o) => o !== 'function')) {
    domain = 'math';
  }
  if (intent === 'code') domain = 'code';
  if (intent === 'search') domain = 'search';
  if (intent === 'summarize') domain = 'reasoning';
  if (intent === 'verify' && domain === 'unknown') domain = 'reasoning';

  const signals =
    (intent !== 'unknown' ? 1 : 0) +
    actions.length +
    objects.length +
    attributes.length +
    rawMath.length +
    (numbers.length > 0 ? 1 : 0);
  const confidence = Math.min(1, signals / 3);

  return {
    intent,
    domain,
    actions,
    objects,
    attributes,
    numbers,
    variables,
    rawMath,
    output,
    inputText: t,
    confidence,
  };
}
