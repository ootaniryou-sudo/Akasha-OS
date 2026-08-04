/**
 * AILSM 型システム — Typed AILSM
 *
 * SSA風ID付き意味グラフのノードに型を持たせる。
 * 型安全性: コンパイル時型エラー検出 / 静的IR検査 / 実行前矛盾排除
 * （プログラミング言語の型安全性をAIシステムへ持ち込む）
 */

export type AilsmType =
  | 'number'
  | 'string'
  | 'boolean'
  | 'circle'
  | 'square'
  | 'triangle'
  | 'equation'
  | 'matrix'
  | 'function'
  | 'class'
  | 'query'
  | 'unknown';

/** 型が実数の値として扱えるか */
export function isNumeric(t: AilsmType): boolean {
  return t === 'number';
}

/** src を dst として受け渡せるか（unknown はワイルドカード） */
export function isCompatible(src: AilsmType, dst: AilsmType): boolean {
  if (src === 'unknown' || dst === 'unknown') return true;
  return src === dst;
}

/** オブジェクト種別（正準名） → 型 */
export function objectType(obj: string): AilsmType {
  switch (obj) {
    case 'circle': return 'circle';
    case 'square': return 'square';
    case 'triangle': return 'triangle';
    case 'equation': return 'equation';
    case 'matrix': return 'matrix';
    case 'function': return 'function';
    case 'class': return 'class';
    case 'query': return 'query';
    default: return 'unknown';
  }
}
