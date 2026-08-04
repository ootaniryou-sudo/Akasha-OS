/**
 * AILSA Phase 0 — セルフテスト（土台の完全性を検証）
 *
 * 実行: npx tsx src/arcasha/ailsa/selftest.ts
 */

import { Domain, Slot, Task, registry } from './vocab.js';
import { Opcode } from './opcode.js';
import { CODE, MATH, getDialect } from './dialect.js';
import { Instruction } from './encoder.js';
import { CodeOpcode, MathOpcode } from './dialect.js';
import { compile, decode, encode, version } from './codec.js';
import { validateProgram } from './validator.js';

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
console.log('  AILSA Phase 0 — Self Test');
console.log('═'.repeat(60));

// ── 1. Registry ──
console.log('\n[1] Registry');
const reg = registry();
check('バージョン 1.0.0', version() === '1.0.0', `got ${version()}`);
check('命令数 >= 50', reg.instructions.length >= 50, `got ${reg.instructions.length}`);
check('TASK_SOLVE=0x04', reg.instructions.some((e) => e.name === 'TASK_SOLVE' && e.opcode === 0x04));
check('DOMAIN_MATH=0x12', reg.instructions.some((e) => e.name === 'DOMAIN_MATH' && e.opcode === 0x12));
check('CALL=0x30', reg.instructions.some((e) => e.name === 'CALL' && e.opcode === 0x30));

// ── 2. 語彙ミラーと整合 ──
console.log('\n[2] Vocabulary mirrors (enum ⇄ registry)');
check('Task.SOLVE = 0x04', Task.SOLVE === 0x04);
check('Slot.CONF = 0x23', Slot.CONF === 0x23);
check('Domain.MATH = 0x12', Domain.MATH === 0x12);
check('Opcode.CALL = 0x30', Opcode.CALL === 0x30);
check('Opcode.RETURN = 0x31', Opcode.RETURN === 0x31);

// ── 3. Dialect ──
console.log('\n[3] Dialect');
check('MathDialect supports CALL', MATH.supports(Opcode.CALL));
check('MathDialect supports EQ', MATH.supports(MathOpcode.EQ));
check('MathDialect rejects CLASS', !MATH.supports(CodeOpcode.CLASS));
check('CodeDialect supports CLASS', CODE.supports(CodeOpcode.CLASS));
check('CodeDialect rejects EQ', !CODE.supports(MathOpcode.EQ));
check('getDialect(math) === MATH', getDialect('math') === MATH);

// ── 4. Encode / Decode roundtrip ──
console.log('\n[4] Codec roundtrip');
const prog: Instruction[] = [
  {
    opcode: Opcode.CALL,
    slots: [
      { slot: Slot.EXPERT, value: 'math' },
      { slot: Slot.TASK_ID, value: '35' },
      { slot: Slot.DOMAIN, value: 'math' },
    ],
  },
  { opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: 'x^2-4=0' }] },
  {
    opcode: Opcode.RETURN,
    slots: [
      { slot: Slot.TASK_ID, value: '35' },
      { slot: Slot.OUTPUT, value: 'x=2' },
      { slot: Slot.CONF, value: 0.92 },
    ],
  },
];
const bytes = encode(prog);
const decoded = decode(bytes);
check('バイト列が生成される', bytes.length > 0, `len=${bytes.length}`);
check('roundtrip 一致', JSON.stringify(decoded) === JSON.stringify(prog));
check('compile === encode', compile(prog).every((b, i) => b === bytes[i]));
check('CONF が number で復元', (decoded[2].slots?.find((s) => s.slot === Slot.CONF)?.value as number) === 0.92);

// 日本語もスロット値として可搬（CALL → RETURN の妥当なプログラム）
const jaBytes = encode([
  { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'reasoning' }, { slot: Slot.TASK_ID, value: '1' }] },
  { opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: '1' }, { slot: Slot.OUTPUT, value: 'AIです。' }] },
]);
const jaDecoded = decode(jaBytes);
check('日本語値の roundtrip', jaDecoded[1].slots?.find((s) => s.slot === Slot.OUTPUT)?.value === 'AIです。');

// 不正バイト列は大声で失敗
expectThrow('切り詰めバイト列でエラー', () => decode(Uint8Array.from([0x30, 0x29, 0x05])));
expectThrow('不正 varint でエラー', () => decode(Uint8Array.from([0x30, 0x29, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01])));

// ── 5. Validator ──
console.log('\n[5] Validator');
const call = (id: string): Instruction => ({
  opcode: Opcode.CALL,
  slots: [{ slot: Slot.EXPERT, value: 'math' }, { slot: Slot.TASK_ID, value: id }],
});
const ret = (id: string): Instruction => ({
  opcode: Opcode.RETURN,
  slots: [{ slot: Slot.TASK_ID, value: id }, { slot: Slot.OUTPUT, value: 'ok' }],
});

check('CALL CALL CALL RETURN → valid', validateProgram([call('1'), call('2'), call('3'), ret('1')]).valid);
check('RETURN RETURN → invalid', !validateProgram([ret('1'), ret('2')]).valid);
check('未登録 opcode → invalid', !validateProgram([{ opcode: 0x99 }]).valid);
check('必須スロット不足 CALL → invalid', !validateProgram([{ opcode: Opcode.CALL }]).valid);
check('許可外スロット → invalid', !validateProgram([{ opcode: Opcode.CALL, slots: [{ slot: Slot.TASK_ID, value: '1' }, { slot: Slot.EXPERT, value: 'm' }, { slot: Slot.REASON, value: 'x' }] }]).valid);
check('空プログラム → invalid', !validateProgram([]).valid);

// CONF 範囲外の単体検証
const confBad = validateProgram([
  { opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: '1' }, { slot: Slot.CONF, value: 1.5 }] },
]);
check('CONF=1.5 → invalid', !confBad.valid, confBad.issues.map((i) => i.message).join(' | '));

// エンコード前に検証が走る（codec は不正を絶対に通さない）
expectThrow('不正プログラムを encode → 例外', () => encode([ret('1'), ret('2')]));

// ── 6. 決定論 ──
console.log('\n[6] Determinism');
const bytesA = encode(prog);
const bytesB = encode(prog);
check('同じ入力 → 同じバイト列', bytesA.every((b, i) => b === bytesB[i]));

console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log('  ✅ ALL PASS — AILSA Phase 0 土台は完全一致・決定論・検証可能');
} else {
  console.error(`  ❌ ${failed} 件の失敗`);
  process.exitCode = 1;
}
console.log('═'.repeat(60));
