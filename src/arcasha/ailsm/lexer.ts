/**
 * AILSM Lexer — 自然言語のトークン化（100% 決定論）
 *
 * 数値 / 変数 / 数式 / 単語 に分割する。数式（演算子を含むASCII連続）は
 * 単一トークンとして保持し、後段の Normalizer へ渡す。
 */

export type TokenType = 'number' | 'variable' | 'math' | 'word';

export interface Token {
  type: TokenType;
  value: string;
}

const NUMBER_RE = /^\d+(?:\.\d+)?/;
const ASCII_RUN_RE = /^[0-9a-zA-Z^+\-*/=().]+/;
const JAPANESE_RUN_RE = /^[\u3040-\u30ff\u3400-\u9fff]+/;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const rest = text.slice(i);

    const num = NUMBER_RE.exec(rest);
    if (num) {
      tokens.push({ type: 'number', value: num[0] });
      i += num[0].length;
      continue;
    }

    const ascii = ASCII_RUN_RE.exec(rest);
    if (ascii) {
      const s = ascii[0];
      if (/[+\-*/=^]/.test(s)) {
        tokens.push({ type: 'math', value: s });
      } else if (/^[a-zA-Z]$/.test(s)) {
        tokens.push({ type: 'variable', value: s });
      } else {
        tokens.push({ type: 'word', value: s });
      }
      i += s.length;
      continue;
    }

    const jp = JAPANESE_RUN_RE.exec(rest);
    if (jp) {
      tokens.push({ type: 'word', value: jp[0] });
      i += jp[0].length;
      continue;
    }

    i++; // 句読点・空白は読み飛ばす
  }
  return tokens;
}
