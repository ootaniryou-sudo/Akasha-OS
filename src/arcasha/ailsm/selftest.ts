/**
 * AILSM Phase 0.5 — セルフテスト（Stage 1 決定論 + Stage 3 決定論Verifier）
 *
 * 実行: npx tsx src/arcasha/ailsm/selftest.ts
 */

import { Slot, Task } from '../ailsa/vocab.js';
import { MathOpcode } from '../ailsa/dialect.js';
import { compile, compileAndRun, describeGraph, toHex } from './compiler.js';
import { execute } from './executor.js';
import { run } from './runtime.js';
import { believe, plan, reflect, remember } from './state.js';
import { toAsciiTree, toDot, toMermaid, toStateDiagram } from './visualizer.js';

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

// [9] Optimizer / Capability / 定数畳み込み / 制約
console.log('\n[9] Optimizer / Capability / Fold');
const r9 = compile('2+3を計算して');
check('定数畳み込みノート', r9.notes.some((n) => n.includes('constant fold')));
check('fold 結果が INPUT=5', r9.instructions.some((i) => i.slots?.some((s) => s.slot === Slot.INPUT && s.value === '5')));
check('能力推論 expert=math', r9.capability.expert === 'math');
check('能力推論 requiredTypes に number', r9.capability.requiredTypes.includes('number'));

const r9b = compile('x^2を積分して', 0); // -O0
const r9c = compile('x^2を積分して', 2); // -O2
check('-O0 / -O2 で命令列が一致（畳み込み対象なし）', r9b.instructions.length === r9c.instructions.length);

const r10 = compile('半径3の円の面積を求めて');
const radiusNode = r10.semantic.graph.nodes.find((n) => n.kind === 'value' && n.label === 'radius');
check('制約 min=0 が付与', radiusNode?.constraints?.min === 0);

// [10] Visualizer（見えるIR）
console.log('\n[10] Visualizer');
const rv = compile('x+2=5を解いて');
const mm = toMermaid(rv.optimized.graph);
const dot = toDot(rv.optimized.graph);
const tree = toAsciiTree(rv.optimized.graph);
check('Mermaid に Task#1 が含まれる', mm.includes('Task#1'));
check('Mermaid に uses エッジ', mm.includes('-->|uses|'));
check('DOT に digraph 宣言', dot.includes('digraph AILSM'));
check('ASCII ツリーに Object#2', tree.includes('Object#2'));
console.log('  --- Mermaid ---');
console.log(mm.split('\n').map((l) => `  ${l}`).join('\n'));

// [11] AILSM Executor（IRをLLM無しで実行）
console.log('\n[11] AILSM Executor');
const e1 = execute(compile('2と3を足して').optimized.graph);
check('ADD 解決 2+3=5', e1.resolved && e1.value === 5, String(e1.value));
check('Result ノード追加', e1.after.nodes.some((n) => n.kind === 'value' && n.label === 'result' && n.attrs.value === 5));
check('needsExpert=false', e1.needsExpert === false);
check('ステップ記録', e1.steps.some((s) => s.includes('ACTION_ADD')));

const e2 = execute(compile('20を4で割って').optimized.graph);
check('DIVIDE 解決 20÷4=5', e2.resolved && e2.value === 5, String(e2.value));
const e3 = execute(compile('9の平方根を求めて').optimized.graph);
check('SQRT 解決 √9=3', e3.resolved && e3.value === 3, String(e3.value));
const e4 = execute(compile('x^2を積分して').optimized.graph);
check('積分は Expert 委譲（needsExpert）', e4.needsExpert === true && e4.resolved === false);

const cr = compileAndRun('7と6を掛けて');
check('compileAndRun で 7×6=42', cr.execution.resolved && cr.execution.value === 42);

// [12] AI State SSA（Memory / Belief / Plan / Reflection）
console.log('\n[12] AI State SSA');
const gbase = compile('x^2を積分して').optimized.graph;
const taskId0 = gbase.nodes.find((n) => n.kind === 'task')?.id ?? 0;

const mem = remember(gbase, taskId0, 'result', 5);
check('Memory# ノード追加', mem.graph.nodes.some((n) => n.kind === 'memory' && n.attrs.key === 'result' && n.attrs.value === 5));
const bel = believe(mem.graph, taskId0, 'math', 0.82);
check('Belief# ノード追加（confidence=0.82）', bel.graph.nodes.some((n) => n.kind === 'belief' && n.attrs.confidence === 0.82 && n.attrs.expert === 'math'));
const pln = plan(bel.graph, taskId0, ['DECOMPOSE', 'CALL math']);
check('Plan# ノード追加', pln.graph.nodes.some((n) => n.kind === 'plan'));
const refl = reflect(pln.graph, taskId0, 'precision', 'switch backend');
check('Reflection# ノード追加', refl.graph.nodes.some((n) => n.kind === 'reflection' && n.attrs.cause === 'precision'));

// Runtime: ローカル解決 → Memory SSA
const rt1 = run('2と3を足して');
check('runtime: ローカル解決 → Memory SSA', rt1.graph.nodes.some((n) => n.kind === 'memory'));
check('runtime: resolvedValue=5', rt1.resolvedValue === 5);
check('runtime: needsExpert=false', rt1.needsExpert === false);

// Runtime: Expert委譲 → Belief SSA → CALL
const rt2 = run('x^2を積分して');
check('runtime: 積分 → Belief SSA（expert=math）', rt2.graph.nodes.some((n) => n.kind === 'belief' && n.attrs.expert === 'math'));
check('runtime: needsExpert=true', rt2.needsExpert === true);
check('runtime: CALL step 記録', rt2.steps.some((s) => s.kind === 'call'));

// 状態遷移図
const sd = toStateDiagram(rt2.steps);
check('stateDiagram-v2 出力', sd.includes('stateDiagram-v2'));
check('stateDiagram に Belief', sd.includes('Belief:'));
console.log('  --- State Diagram ---');
console.log(sd.split('\n').map((l) => `  ${l}`).join('\n'));

// [13] Scheduler / Capability SSA（ODAR = SSA）
console.log('\n[13] Scheduler / Capability SSA');
const rt3 = run('x^2を積分して');
check(
  'Capability# ノード（acc/latency/cost）',
  rt3.graph.nodes.some((n) => n.kind === 'capability' && n.attrs.expert === 'math' && typeof n.attrs.accuracy === 'number'),
);
check(
  'Schedule# ノード（priority/ETA）',
  rt3.graph.nodes.some((n) => n.kind === 'schedule' && typeof n.attrs.priority === 'number' && typeof n.attrs.eta === 'number'),
);
check(
  'トレース: Belief→Capability→Schedule→CALL',
  rt3.steps.map((s) => s.kind).join(',') === 'input,compile,belief,capability,schedule,call',
  rt3.steps.map((s) => s.kind).join(','),
);
const sd3 = toStateDiagram(rt3.steps);
check('stateDiagram に Schedule', sd3.includes('Schedule:'));

console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log('  ✅ ALL PASS — AILSM Phase 0.5（Stage 1 決定論 + Stage 3 決定論Verifier）');
} else {
  console.error(`  ❌ ${failed} 件の失敗`);
  process.exitCode = 1;
}
console.log('═'.repeat(60));
