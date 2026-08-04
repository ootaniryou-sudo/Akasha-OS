/**
 * AILSM Phase 0.5 — セルフテスト（Stage 1 決定論 + Stage 3 決定論Verifier）
 *
 * 実行: npx tsx src/arcasha/ailsm/selftest.ts
 */

import { Slot, Task } from '../ailsa/vocab.js';
import { MathOpcode } from '../ailsa/dialect.js';
import { Opcode, SyscallOpcode } from '../ailsa/opcode.js';
import type { Instruction } from '../ailsa/encoder.js';
import { AiProgram } from './program.js';
import { link } from './linker.js';
import { optimizeInstructions } from './optimizer.js';
import { compile, compileAndRun, describeGraph, toHex } from './compiler.js';
import { execute } from './executor.js';
import { run } from './runtime.js';
import { canTransition, believe, plan, reflect, remember } from './state.js';
import { pickNext } from './scheduler.js';
import type { ScheduledUnit } from './scheduler.js';
import { AIKernel, isKernelNode } from './kernel.js';
import { assignNamespace, canAccessMemory, createNamespace, loadPage, pageMemory } from './namespace.js';
import { ABI_VERSION_1_0, buildContextArgument, supportsAbi } from './abi.js';
import type { AbiArgument } from './abi.js';
import { MockExpertDriver } from './driver.js';
import { DeviceTree } from './device-tree.js';
import { boot, execute as runtimeExecute } from './expert-runtime.js';
import { toAsciiTree, toDot, toMermaid, toStateDiagram } from './visualizer.js';
import { createContext, contextOf, pagesOf, splitContext } from './context.js';
import { loadPage as loadContextPage } from './context.js';
import { hasEquation, selectPages } from './slice.js';
import { cacheArtifact, getCached } from './cache.js';
import { requestSlice, runAvmDemo, storeContext, cacheResult } from './avm.js';

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
  'トレース: Process→Thread→Belief→Capability→Schedule→CALL→WAIT',
  rt3.steps.map((s) => s.kind).join(',') === 'input,compile,process,thread,belief,capability,schedule,call,wait',
  rt3.steps.map((s) => s.kind).join(','),
);
const sd3 = toStateDiagram(rt3.steps);
check('stateDiagram に Schedule', sd3.includes('Schedule:'));

// [14] AI Process / Thread / Reasoning Scheduler（AI OS）
console.log('\n[14] AI Process / Thread / Scheduler');
const rt4 = run('x^2を積分して');
check('Process# ノード（owner=math）', rt4.graph.nodes.some((n) => n.kind === 'process' && n.attrs.owner === 'math'));
check('Thread# ノード', rt4.graph.nodes.some((n) => n.kind === 'thread'));
check('CALL中は Process waiting', rt4.graph.nodes.some((n) => n.kind === 'process' && n.attrs.state === 'waiting'));
check(
  'Runtime Events: SPAWN/CALL/WAIT',
  rt4.events.some((e) => e.kind === 'SPAWN') && rt4.events.some((e) => e.kind === 'CALL') && rt4.events.some((e) => e.kind === 'WAIT'),
);

const rt5 = run('2と3を足して');
check('ローカル解決は Process finished', rt5.graph.nodes.some((n) => n.kind === 'process' && n.attrs.state === 'finished'));
check('FINISH イベント', rt5.events.some((e) => e.kind === 'FINISH'));

const units: ScheduledUnit[] = [
  { processId: 1, priority: 0.4, owner: 'code', state: 'ready' },
  { processId: 2, priority: 0.9, owner: 'math', state: 'ready' },
  { processId: 3, priority: 0.9, owner: 'search', state: 'ready' },
  { processId: 4, priority: 0.7, owner: 'code', state: 'waiting' },
];
check('pickNext: 最高優先度（同点は低ID）', pickNext(units)?.processId === 2);
check('created→ready 遷移可', canTransition('created', 'ready'));
check('finished→running 遷移不可', !canTransition('finished', 'running'));

// [15] AI Kernel / System Call（Kernel-mediated AI Runtime）
console.log('\n[15] AI Kernel / System Call');
const rtK = run('x^2を積分して');
const pidK = rtK.processId!;
const k = new AIKernel();

const ms = k.memoryStore(rtK.graph, pidK, 'answer', 42);
check('SYSCALL_MEMORY_STORE granted', ms.granted);
check('Memory ノード追加（Kernel経由）', ms.graph.nodes.some((n) => n.kind === 'memory' && n.attrs.key === 'answer' && n.attrs.value === 42));
check('SYSCALL_MEMORY_LOAD value=42', k.memoryLoad(ms.graph, pidK, 'answer').value === 42);
check('SYSCALL_MEMORY_QUERY で answer 検出', (k.memoryQuery(ms.graph, pidK, 'answ').value as string[]).includes('answer'));
check('同owner の MEMORY_DELETE は granted', k.memoryDelete(ms.graph, pidK, 'answer', 'math').granted);
const mdDenied = k.memoryDelete(ms.graph, pidK, 'answer', 'code');
check('別owner への DELETE は拒否', mdDenied.granted === false && mdDenied.detail.includes('permission denied'));
const rfK = k.reflectRequest(ms.graph, pidK, 'precision', 'switch backend');
check('SYSCALL_REFLECT granted + Reflection ノード', rfK.granted && rfK.graph.nodes.some((n) => n.kind === 'reflection'));
const ucK = k.updateCapability(rfK.graph, pidK, 'math', 0.05, 'math');
check('UPDATE_CAPABILITY granted', ucK.granted);
check('memory は Kernel Space', isKernelNode('memory'));
check('task は User Space', !isKernelNode('task'));

// [16] Namespace / Virtual Memory（Process Isolation）
console.log('\n[16] Namespace / Virtual Memory');
let gn = rtK.graph;
const nsA = createNamespace(gn, 'spaceA');
gn = nsA.graph;
const nsB = createNamespace(gn, 'spaceB');
gn = nsB.graph;
gn = assignNamespace(gn, pidK, nsA.id).graph;

// gn 内に第2プロセスを Kernel 経由で生成（SYSCALL_SPAWN）
const taskK = gn.nodes.find((n) => n.kind === 'task')?.id ?? 0;
const spawnRes = k.spawnRequest(gn, taskK, 'code', 0.7);
gn = spawnRes.graph;
const pidP2 = spawnRes.value as number;
gn = assignNamespace(gn, pidP2, nsB.id).graph;

gn = k.memoryStore(gn, pidK, 'secretA', 1, 'spaceA').graph;
gn = k.memoryStore(gn, pidP2, 'secretB', 2, 'spaceB').graph;

check('spaceA の記憶は processA から可読', canAccessMemory(gn, pidK, 'secretA') === true);
check('spaceA の記憶は processB から不可読（Isolation）', canAccessMemory(gn, pidP2, 'secretA') === false);
check('spaceB の記憶は processB から可読', canAccessMemory(gn, pidP2, 'secretB') === true);
const pages = pageMemory(gn);
check('Memory Page 分割', pages.length >= 1);
const page1 = loadPage(pages, 1);
check('LOAD PAGE 1 でエントリ取得', page1 !== undefined && page1.entries.length >= 1);

// [17] AI Program（AILSM で直接プログラムを書く）
console.log('\n[17] AI Program');
const prog = new AiProgram('solve-and-verify')
  .plan('solve x^2-4=0')
  .call('math', 'x^2-4=0')
  .math(MathOpcode.EQ, 'x^2-4=0')
  .verify()
  .reflect('precision', 'retry fp64')
  .call('math', 'x^2-4=0')
  .returns('x=2');
const progInstrs = prog.assemble();
check('AI Program が AILSA 命令列を生成', progInstrs.length >= 5, `len=${progInstrs.length}`);
check('CALL が含まれる', progInstrs.some((i) => i.opcode === Opcode.CALL));
check('SYSCALL_REFLECT が含まれる', progInstrs.some((i) => i.opcode === SyscallOpcode.REFLECT));
check('AI Program がエンコード可能（検証込み）', prog.encode().length > 0);

// [18] AILSM Optimizer（命令レベル: DCE + CALLバッチ化）
console.log('\n[18] AILSM Optimizer');
// ユーザーの例どおり: CALL Math ×3（連続）→ CALL Math Batch=3
const raw: Instruction[] = [
  { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'math' }, { slot: Slot.TASK_ID, value: '0' }] },
  { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'math' }, { slot: Slot.TASK_ID, value: '1' }] },
  { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: 'math' }, { slot: Slot.TASK_ID, value: '2' }] },
  { opcode: Opcode.RETURN, slots: [{ slot: Slot.TASK_ID, value: '2' }] },
];
const opt = optimizeInstructions(raw);
check('CALL 3→1 にバッチ化', opt.stats.callsBefore === 3 && opt.stats.callsAfter === 1, `calls=${opt.stats.callsBefore}->${opt.stats.callsAfter}`);
check('Latency 削減', opt.stats.latencyMsAfter < opt.stats.latencyMsBefore);
check('Cost 削減', opt.stats.costAfter < opt.stats.costBefore);
check('BATCH ノート', opt.notes.some((n) => n.includes('BATCH')));

// [19] AI Linker（複数 Expert → Executable Task）
console.log('\n[19] AI Linker');
const linked = link('pipeline', [
  { name: 'math', expert: 'math', instructions: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: 'x^2-4=0' }] }] },
  { name: 'search', expert: 'search', instructions: [{ opcode: Opcode.SEARCH, slots: [{ slot: Slot.INPUT, value: 'similar' }] }] },
]);
check('リンクで 2 セグメント', linked.segments.length === 2);
check('シンボルテーブル（math=task0）', linked.segments[0].taskId === '0');
check('CALL×2 + RETURN×2 でラップ', linked.instructions.filter((i) => i.opcode === Opcode.CALL).length === 2 && linked.instructions.filter((i) => i.opcode === Opcode.RETURN).length === 2);
check('リンク後エンコード可能（検証込み）', linked.bytes.length > 0);

// [20] AI ABI（引数/戻り値/エラー/バージョン交渉）
console.log('\n[20] AI ABI');
const arg: AbiArgument = { index: 0, type: 'float32', shape: [1], ownership: 'borrow', alignment: 4 };
check('ABI 引数（float32/borrow/4byte）', arg.type === 'float32' && arg.ownership === 'borrow' && arg.alignment === 4);
check('ABI バージョン整合（1.0 → 1.0）', supportsAbi(ABI_VERSION_1_0, ABI_VERSION_1_0) === true);
check('ABI 不整合（kernel 1.0 → expert 1.1）', supportsAbi({ major: 1, minor: 0 }, { major: 1, minor: 1 }) === false);

// [21] Expert Driver（Kernel → Driver → LLM）
console.log('\n[21] Expert Driver');
const mathDriver = new MockExpertDriver('math', 'Math Expert');
const dResp = mathDriver.invoke({ program: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: '2+3' }] }], abiVersion: ABI_VERSION_1_0 });
check('Math Driver: EQ(2+3)=5', dResp.ok && dResp.result === 5, String(dResp.result));
const dErr = mathDriver.invoke({ program: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: '1/0' }] }], abiVersion: ABI_VERSION_1_0 });
check('Math Driver: 0除算 → Error ABI', !dErr.ok && dErr.error?.code === 1001 && dErr.error?.retryable === true);
const dAbi = mathDriver.invoke({ program: [], abiVersion: { major: 1, minor: 1 } });
check('ABI 不一致 → UNSUPPORTED_ABI', !dAbi.ok && dAbi.error?.code === 2002);

// [22] AI Device Tree
console.log('\n[22] AI Device Tree');
const dtree = new DeviceTree();
dtree.registerNode({ id: 'pc1', arch: 'x86_64', cpu: 'M3', ramMB: 16384, language: 'ja', cost: 0.1 });
dtree.registerNode({ id: 'iphone', arch: 'arm64', cpu: 'A18', ramMB: 8192, battery: 75, network: true, language: 'ja', cost: 0.05 });
check('DeviceTree ノード登録', dtree.list().length === 2);
check('DeviceTree describe に gpu/battery 情報', dtree.describe().includes('pc1') && dtree.describe().includes('battery=75%'));

// [23] Local Expert Runtime（1台のPCで2 Expert が AILSA で通信）
console.log('\n[23] Local Expert Runtime');
const booted = boot();
check('Driver 3種登録（math/search/reasoning）', booted.drivers.size === 3);
const ex1 = runtimeExecute('x^2を積分して', booted);
check('積分 → math Driver へ委譲', ex1.driverId === 'math', String(ex1.driverId));
check('Driver 結果が返る', typeof ex1.result === 'string' && (ex1.result as string).includes('∫'));
check('結果が Kernel 経由で Memory 保存', ex1.finalGraph.nodes.some((n) => n.kind === 'memory' && n.attrs.key === 'result'));
check('プロセス finished', ex1.finalGraph.nodes.some((n) => n.kind === 'process' && n.attrs.state === 'finished'));
const ex2 = runtimeExecute('Webで記事を検索して', booted);
check('検索 → search Driver へ委譲', ex2.driverId === 'search', String(ex2.driverId));
check('search 結果 [doc1..]', ex2.result === '[doc1, doc2, doc3]', String(ex2.result));
const ex3 = runtimeExecute('2と3を足して', booted);
check('ローカル解決は Driver 不要（result=5）', ex3.driverId === null && ex3.result === null);

// [24] Context SSA（長文・PDF・コードを表すノード）
console.log('\n[24] Context SSA');
const text24 = '0123456789abcdef'; // 16 文字
const pages24 = splitContext(text24, 8);
check('splitContext で 2 ページに分割', pages24.length === 2 && pages24[0] === '01234567' && pages24[1] === '89abcdef');
const ctx24 = createContext({ nodes: [], edges: [] }, '論文', text24, 8);
const cObj24 = contextOf(ctx24.graph, ctx24.contextId);
check('Context#N ノードが作成される', cObj24 !== undefined && cObj24.title === '論文' && cObj24.pageCount === 2);
check('Context contains Page エッジ ×2', ctx24.graph.edges.filter((e) => e.rel === 'contains').length === 2);
check('Page ノードが 2 つ', ctx24.graph.nodes.filter((n) => n.kind === 'page').length === 2);

// [25] Page Manager（固定サイズページの分割・ロード）
console.log('\n[25] Page Manager');
const allPages25 = pagesOf(ctx24.graph, ctx24.contextId);
check('pagesOf が index 順に列挙', allPages25.length === 2 && allPages25[0].index === 0 && allPages25[1].index === 1);
check('ページ実体は offset どおり', allPages25[0].text === '01234567' && allPages25[1].text === '89abcdef');
const loaded25 = loadContextPage(ctx24.graph, allPages25[1].id);
check('loadPage でページをロード（参照操作）', loaded25 !== undefined && loaded25.text === '89abcdef');

// [26] Slice Loader（Expert ごとに必要なページだけをロード）
console.log('\n[26] Slice Loader');
const ct26 = createContext({ nodes: [], edges: [] }, 'doc', 'x^2+2x+1=0 を解け', 64);
check('hasEquation で数式ページを判定', hasEquation('x^2+2x+1=0 を解け'));
const mathSlice26 = selectPages(ct26.graph, ct26.contextId, 'math');
check('Math Expert は数式ページだけを読む', mathSlice26.pageIds.length === 1);
const searchSlice26 = selectPages(ct26.graph, ct26.contextId, 'search');
check('Search Expert は検索語なしページを読まない', searchSlice26.pageIds.length === 0);
check('Slice#N ノード（uses エッジ）', mathSlice26.graph.nodes.some((n) => n.kind === 'slice' && n.attrs.expert === 'math'));

// [27] Context Cache（解析済み Context の再利用）
console.log('\n[27] Context Cache');
const ctx27 = createContext({ nodes: [], edges: [] }, 'c', 'text', 64);
const cid27 = ctx27.contextId;
const c1 = cacheArtifact(ctx27.graph, cid27, 'equation', 'parsed', 'x=-1');
check('初回キャッシュは miss', c1.hit === false);
check('キャッシュ参照で値を取得', getCached(c1.graph, cid27, 'equation', 'parsed') === 'x=-1');
const c2 = cacheArtifact(c1.graph, cid27, 'equation', 'parsed', 'x=-1');
check('2回目は hit（再解析不要）', c2.hit === true);
check('Cache#N ノード（context contains cache）', c1.graph.nodes.some((n) => n.kind === 'cache' && n.attrs.kind === 'equation'));

// [28] AI Virtual Memory デモ（3 Expert が巨大知識の一部だけを読む）
console.log('\n[28] AI Virtual Memory');
const demo = runAvmDemo();
const demoCtx = contextOf(demo.graph, demo.contextId);
check('長文 Context がページ分割される', (demoCtx?.pageCount ?? 0) >= 5);
for (const r of demo.results) {
  check(`${r.expert} は全ページを読まない（${r.stats.loadedPages}/${r.stats.totalPages}）`, r.stats.loadedPages < r.stats.totalPages);
  check(`${r.expert} の供給割合 < 100%（${(r.stats.loadedRatio * 100).toFixed(0)}%）`, r.stats.loadedRatio < 1);
}
const mathR = demo.results[0];
check('Long Context ABI: type=context（参照）', mathR.slice.argument.type === 'context' && mathR.slice.argument.ownership === 'borrow');
check('ContextRef は実体ではなく ID 参照', mathR.slice.ref.contextId === demo.contextId && mathR.slice.ref.pageIds.length === mathR.slice.pageIds.length);
const mathPages = pagesOf(demo.graph, demo.contextId).filter((p) => mathR.slice.pageIds.includes(p.id));
check('Math スライスの各ページは数式を含む', mathPages.length > 0 && mathPages.every((p) => hasEquation(p.text)));
const second = requestSlice(demo.graph, demo.contextId, 'math');
check('再スライスで同一ページを参照', second.load.pageIds.length === mathR.slice.pageIds.length);
const re = cacheResult(demo.graph, demo.contextId, 'summary', 'overview', 'x');
check('Context Cache が再解析を防ぐ（hit）', re.hit === true && re.value !== null);
const abiArg = buildContextArgument(0, { contextId: demo.contextId, pageIds: mathR.slice.pageIds });
check('buildContextArgument が context ABI 引数を作る', abiArg.type === 'context' && abiArg.ownership === 'borrow' && abiArg.alignment === 8);
const ctx28 = storeContext({ nodes: [], edges: [] }, 'k', 'k1 k2 k3');
check('storeContext で Context Object を管理', ctx28.context.title === 'k' && ctx28.context.pageCount >= 1);

console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log('  ✅ ALL PASS — AILSM Phase 0.5（Stage 1 決定論 + Stage 3 決定論Verifier）');
} else {
  console.error(`  ❌ ${failed} 件の失敗`);
  process.exitCode = 1;
}
console.log('═'.repeat(60));
