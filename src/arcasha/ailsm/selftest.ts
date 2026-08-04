/**
 * AILSM Phase 0.5 — セルフテスト（Stage 1 決定論 + Stage 3 決定論Verifier）
 *
 * 実行: npx tsx src/arcasha/ailsm/selftest.ts
 */

import { Slot, Task } from '../ailsa/vocab.js';
import { MathOpcode } from '../ailsa/dialect.js';
import { compile, describeGraph, toHex } from './compiler.js';

let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${name} ${detail}`);
  }
}

function expectThrow(name: string, fn: () => unknown): void {
  try {
    fn();
    failed++;
    console.error(`  ✗ FAIL: ${name}（例外が投げられなかった）`);
  } catch (e) {
    console.log(`  ✓ ${name}（${(e as Error).message}）`);
  }
}

console.log('═'.repeat(60));
console.log('  AILSM Phase 0.5 — Self Test');
console.log('═'.repeat(60));

// [1] 方程式を解く
console.log('\n[1] 方程式');
const r1 = compile('x+2=5を解いて');
check('intent=solve', r1.normalized.intent === 'solve');
check('domain=math', r1.normalized.domain === 'math');
check('rawMath 抽出', r1.normalized.rawMath.includes('x+2=5'));
check('EQ 命令が含まれる', r1.instructions.some((i) => i.opcode === MathOpcode.EQ));
check('AILSA 検証 valid', r1.verification.valid);
check('バイト列が生成される', r1.bytes.length > 0);
console.log('  --- AILSM ---');
console.log(`  ${describeGraph(r1.semantic.graph).split('\n').join('\n  ')}`);
console.log(`  --- AILSA hex: ${toHex(r1.bytes)} ---`);

// [2] 円の面積（オブジェクト・属性・出力の抽出）
console.log('\n[2] 円の面積');
const r2 = compile('半径5の円の面積を求めて');
check('object=circle', r2.normalized.objects.includes('circle'));
check('attr radius=5', r2.normalized.attributes.some((a) => a.name === 'radius' && a.value === '5'));
check('output=area', r2.normalized.output === 'area');
check('domain=math', r2.normalized.domain === 'math');
check('valid', r2.verification.valid);

// [3] 同義語の正準化（Normalization）
console.log('\n[3] 同義語正準化');
const a3 = compile('足してください');
const b3 = compile('加えて');
const c3 = compile('和を求めよ');
check(
  '3表現とも ACTION_ADD',
  a3.normalized.actions[0] === 'ACTION_ADD' &&
    b3.normalized.actions[0] === 'ACTION_ADD' &&
    c3.normalized.actions[0] === 'ACTION_ADD',
);

// [4] 積分（Math Dialect オペコード）
console.log('\n[4] 積分');
const r4 = compile('x^2 を積分して');
check('intent=solve', r4.normalized.intent === 'solve');
check('ACTION_INTEGRAL', r4.normalized.actions.includes('ACTION_INTEGRAL'));
check('INTEGRAL 命令', r4.instructions.some((i) => i.opcode === MathOpcode.INTEGRAL));
check('valid', r4.verification.valid);

// [5] 要約（Registry v1.1.0 の TASK_SUMMARIZE）
console.log('\n[5] 要約');
const r5 = compile('この文章を要約して');
check('intent=summarize', r5.normalized.intent === 'summarize');
check('domain=reasoning', r5.normalized.domain === 'reasoning');
check('TASK_SUMMARIZE 命令', r5.instructions.some((i) => i.opcode === Task.SUMMARIZE));
check('valid', r5.verification.valid);

// [6] 検索（Back-End: expert=search へルーティング）
console.log('\n[6] 検索');
const r6 = compile('Webから記事を検索して');
check('intent=search', r6.normalized.intent === 'search');
const call = r6.instructions.find((i) => i.opcode === 0x30);
check('expert=search', call?.slots?.find((s) => s.slot === Slot.EXPERT)?.value === 'search');
check('valid', r6.verification.valid);

// [7] 失敗系（壊れない土台）
console.log('\n[7] 失敗系');
expectThrow('空入力は例外', () => compile(''));
expectThrow('解釈不能は例外（Stage 2 委譲点）', () => compile('こんにちは世界'));

// [8] 決定論
console.log('\n[8] 決定論');
const ra = compile('x+2=5を解いて').bytes;
const rb = compile('x+2=5を解いて').bytes;
check('同じ入力 → 同じバイト列', ra.every((v, i) => v === rb[i]));

console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log('  ✅ ALL PASS — AILSM Phase 0.5（Stage 1 決定論 + Stage 3 決定論Verifier）');
} else {
  console.error(`  ❌ ${failed} 件の失敗`);
  process.exitCode = 1;
}
console.log('═'.repeat(60));
