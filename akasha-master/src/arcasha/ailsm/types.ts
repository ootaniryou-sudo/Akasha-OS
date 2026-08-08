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

/**
 * 拡張型参照 — Union 型 / Optional 型に対応
 *   Value#12 : number
 *   Object#3  : optional(circle)
 *   Value#9   : union(number|string)
 */
export type AilsmTypeRef =
  | AilsmType
  | { kind: 'union'; types: AilsmType[] }
  | { kind: 'optional'; type: AilsmType };

export function isSimpleType(t: AilsmTypeRef): t is AilsmType {
  return typeof t === 'string';
}

export function simpleTypes(t: AilsmTypeRef): AilsmType[] {
  if (typeof t === 'string') return [t];
  if (t.kind === 'union') return t.types;
  return [t.type];
}

/** 型が実数の値として扱えるか */
export function isNumeric(t: AilsmTypeRef): boolean {
  return simpleTypes(t).includes('number');
}

/** src を dst として受け渡せるか（unknown はワイルドカード） */
export function isCompatible(src: AilsmTypeRef, dst: AilsmTypeRef): boolean {
  const ss = simpleTypes(src);
  const ds = simpleTypes(dst);
  if (ss.includes('unknown') || ds.includes('unknown')) return true;
  return ss.some((s) => ds.includes(s));
}

/** ノード制約（半径 > 0 等）— 値の静的検査に使う */
export interface NodeConstraints {
  min?: number;
  max?: number;
  pattern?: string;
  optional?: boolean;
}

export function satisfiesConstraints(
  value: string | number | boolean,
  c: NodeConstraints | undefined,
): boolean {
  if (!c) return true;
  if (typeof value === 'number') {
    if (c.min !== undefined && value < c.min) return false;
    if (c.max !== undefined && value > c.max) return false;
  }
  if (typeof value === 'string' && c.pattern !== undefined) {
    try {
      if (!new RegExp(c.pattern).test(value)) return false;
    } catch {
      return false;
    }
  }
  return true;
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
