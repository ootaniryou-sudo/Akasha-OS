/**
 * AILSM Visualizer CLI — 自然言語 → AILSM を可視化する
 *
 * 実行:
 *   npx tsx src/arcasha/ailsm/visualize.ts "x+2=5を解いて"
 *   npx tsx src/arcasha/ailsm/visualize.ts "2+3を計算して" 2
 *
 * 出力: 最適化前後の AILSM グラフ（Mermaid / DOT / ASCIIツリー）+ AILSA バイト列
 */

import { compile, describeGraph, toHex } from './compiler.js';
import type { OptimizationLevel } from './optimizer.js';
import { toAsciiTree, toDot, toMermaid } from './visualizer.js';

const input = process.argv[2] ?? 'x+2=5を解いて';
const level = (process.argv[3] ? Number(process.argv[3]) : 2) as OptimizationLevel;

function line(label: string, body: string): void {
  console.log(`\n── ${label} ─${'─'.repeat(Math.max(0, 56 - label.length))}`);
  console.log(body.split('\n').map((l) => `  ${l}`).join('\n'));
}

console.log('═'.repeat(64));
console.log(`  AILSM Visualizer  (input: "${input}", -O${level})`);
console.log('═'.repeat(64));

const r = compile(input, level);

line('最適化前 AILSM（Semantic Graph）', describeGraph(r.semantic.graph));
line('最適化後 AILSM（Optimized Graph）', describeGraph(r.optimized.graph));
line('ASCII ツリー', toAsciiTree(r.optimized.graph));
line('Mermaid', toMermaid(r.optimized.graph));
line('Graphviz DOT', toDot(r.optimized.graph));
line(`AILSA 命令列 (${r.instructions.length})`, r.instructions.map((i) => JSON.stringify(i)).join('\n'));
line('AILSA バイト列', toHex(r.bytes));
console.log(`\n  capability: ${JSON.stringify(r.capability)}`);
console.log(`  notes: ${r.notes.join(' | ') || '(none)'}`);
console.log('═'.repeat(64));

