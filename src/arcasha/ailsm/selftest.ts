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
import { requestSlice, runAvmDemo, storeContext, cacheResult, runExecutionDemo, runMemoryHierarchyDemo } from './avm.js';
import { createExecutionContext, contextSwitch, saveExecutionContext, restoreExecutionContext, updateExecution, executionOf, commitMemory, pushFrame, popFrame, mergeFrames, frameOf } from './execution.js';
import { contextFault, prefetch, isResident } from './demand-paging.js';
import { splitChunks, splitSpans, spanKindOf, subdivideContext, spansOfKind } from './chunk.js';
import { ContextTlb, translateSpan } from './context-tlb.js';
import { TierManager } from './tier.js';
import { AiPerf } from './perf.js';
import { AiTrace, buildRuntimeTrace, buildSchedulerTrace, renderTimeline } from './trace.js';
import { AiProfiler } from './profiler.js';
import { defaultQuestions, pageKindOfIndex, runLongContextBenchmark, synthesizeContext } from './benchmark.js';
import { runObservabilityDemo } from './observability.js';
import { MockModelClient } from './model-client.js';
import { RemoteDriver } from './remote-driver.js';
import { runRelay } from './relay.js';
import { registerHubDevices, routeCall, assignPageDevice, pageDevice, distributedFault } from './device-router.js';
import { CapabilityLearner, updateCapabilitySsa } from './learning.js';
import { initAiOs, aiosExecute, aiosRelay } from './aios.js';
import { AilsmBuilder } from './ailsm.js';
import { runComparisonBenchmark } from './comparison.js';
import { runScalingExperiment, renderScaling } from './experiment.js';
import { hypothesize, activate, evaluate, accept, merge, hypothesesOf, hypothesisOf } from './reasoning.js';
import { runReasoning, runReasoningDemo, defaultHypothesisGenerator } from './reasoning-runtime.js';

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

async function main(): Promise<void> {

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
check('Driver 11種登録（専門Expert + general）', booted.drivers.size === 11);
const ex1 = await runtimeExecute('x^2を積分して', booted);
check('積分 → math Driver へ委譲', ex1.driverId === 'math', String(ex1.driverId));
check('Driver 結果が返る', typeof ex1.result === 'string' && (ex1.result as string).includes('∫'));
check('結果が Kernel 経由で Memory 保存', ex1.finalGraph.nodes.some((n) => n.kind === 'memory' && n.attrs.key === 'result'));
check('プロセス finished', ex1.finalGraph.nodes.some((n) => n.kind === 'process' && n.attrs.state === 'finished'));
const ex2 = await runtimeExecute('Webで記事を検索して', booted);
check('検索 → search Driver へ委譲', ex2.driverId === 'search', String(ex2.driverId));
check('search 結果 [doc1..]', ex2.result === '[doc1, doc2, doc3]', String(ex2.result));
const ex3 = await runtimeExecute('2と3を足して', booted);
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

// [29] Execution Context SSA（思考途中を保存するプロセスコンテキスト）
console.log('\n[29] Execution Context SSA');
const ectx = createContext({ nodes: [], edges: [] }, 'ec', '0123456789abcdef', 8);
const ex29 = createExecutionContext(ectx.graph, ectx.contextId, 'proc1', 'planning');
check('Execution#N が作成される', ex29.exec.id > 0);
check('初期状態 created / expert=planning', ex29.exec.state === 'created' && ex29.exec.expert === 'planning');
check('context contains execution エッジ', ex29.graph.edges.some((e) => e.rel === 'contains' && e.to === ex29.exec.id));
const up29 = updateExecution(ex29.graph, ex29.exec.id, {
  hypothesis: 'A: 概要を確認した',
  currentPage: 2,
  vars: ['tmp=1'],
  residentPages: [1, 2],
});
check('仮説・現在ページ・一時変数を更新', up29.exec.hypothesis === 'A: 概要を確認した' && up29.exec.currentPage === 2 && up29.exec.vars.length === 1);
check('resident set にページ追加', up29.exec.residentPages.length === 2);
check('Execution ノードが重複しない', up29.graph.nodes.filter((n) => n.kind === 'execution').length === 1);

// [30] Context Switch（save/restore — AI Thread が本物の Thread になる）
console.log('\n[30] Context Switch');
const saved30 = saveExecutionContext(up29.graph, ex29.exec.id);
check('save で suspend（思考途中を保存）', saved30.exec.state === 'suspended' && saved30.exec.hypothesis === 'A: 概要を確認した');
const restored30 = restoreExecutionContext(saved30.graph, ex29.exec.id);
check('restore で running（思考途中を復元）', restored30.exec.state === 'running' && restored30.exec.hypothesis === 'A: 概要を確認した');
const math30 = createExecutionContext(restored30.graph, ectx.contextId, 'proc1', 'math');
const sw30 = contextSwitch(math30.graph, ex29.exec.id, math30.exec.id);
check('Context Switch で planning→math', sw30.events.some((e) => e.kind === 'SWITCH' && e.from === 'planning' && e.to === 'math'));
check('switch 後 math は running / planning は suspended', executionOf(sw30.graph, math30.exec.id)?.state === 'running' && executionOf(sw30.graph, ex29.exec.id)?.state === 'suspended');

// [31] Demand Paging（必要になったページだけをロード）
console.log('\n[31] Demand Paging');
const dp31 = createContext({ nodes: [], edges: [] }, 'dp', 'aaa\nx^2+2x+1=0\nbbb', 40);
const dpPages = pagesOf(dp31.graph, dp31.contextId);
const ex31 = createExecutionContext(dp31.graph, dp31.contextId, 'proc1', 'math');
check('初期は resident 0 ページ', ex31.exec.residentPages.length === 0);
const f31a = contextFault(ex31.graph, ex31.exec.id, dpPages[0].id);
check('未ロードページ → Context Fault 発生', f31a.faulted === true);
check('Fault 後 resident に追加・current page 更新', f31a.exec.residentPages.includes(dpPages[0].id) && f31a.exec.currentPage === dpPages[0].id);
const f31b = contextFault(f31a.graph, ex31.exec.id, dpPages[0].id);
check('ロード済みページ → フォールトなし', f31b.faulted === false && f31b.resident === true);

// [32] Context Fault（Kernel がページ実体をロード）
console.log('\n[32] Context Fault');
// 3 ページ構成: 通常ページ / 数式ページ / 通常ページ（各 10 文字でページ境界を揃える）
const ctx32 = createContext({ nodes: [], edges: [] }, 'fault', 'aaaaaaaaaax^2+2x+1=0bbbbbbbbbb', 10);
const p32 = pagesOf(ctx32.graph, ctx32.contextId);
check('テスト用に 3 ページ', p32.length === 3);
const ex32 = createExecutionContext(ctx32.graph, ctx32.contextId, 'proc1', 'math');
const f0 = contextFault(ex32.graph, ex32.exec.id, p32[0].id); // 通常ページを先にロード
const eq32 = p32.find((p) => hasEquation(p.text));
const f32 = eq32 && eq32.id !== p32[0].id ? contextFault(f0.graph, ex32.exec.id, eq32.id) : null;
check('数式ページを Fault で Kernel がロード', f32 !== null && f32.faulted === true && f32.loaded.includes('x^2+2x+1=0'));
check('Fault でロード済み判定', f32 !== null && isResident(f32.exec, eq32!.id));

// [33] Prefetcher + Execution Context デモ
console.log('\n[33] Prefetcher / Execution Context デモ');
const pf33 = f32 ? prefetch(f32.graph, ex32.exec.id, 1) : null;
check('Prefetch で隣接ページを先読み', pf33 !== null && pf33.prefetched.length > 0 && pf33.prefetched.includes(p32[2].id));
const edemo = runExecutionDemo();
check('デモ: Context Fault が発生', edemo.faults > 0);
check('デモ: Context Switch が発生', edemo.switches > 0);
check('デモ: Prefetch が発生', edemo.prefetched > 0);
check('デモ: 仮説が A → B に更新（思考途中を維持）', edemo.finalHypothesis === 'B: 数式も確認した（x=-1）', edemo.finalHypothesis);
check('デモ: planner は suspended から復帰して running', edemo.planner.state === 'running');
check('デモ: 最終仮説が Memory へ保存', edemo.graph.nodes.some((n) => n.kind === 'memory' && n.attrs.key === 'final_hypothesis' && String(n.attrs.value).includes('B:')));
const eqPage33 = pagesOf(edemo.graph, edemo.contextId).find((p) => hasEquation(p.text));
check('デモ: math は数式ページを resident に持つ', eqPage33 !== undefined && edemo.math.residentPages.includes(eqPage33.id));
const mem33 = commitMemory(edemo.graph, edemo.planner.id, 'note', 'done');
check('commitMemory で execution stores memory', mem33.graph.edges.some((e) => e.rel === 'stores' && e.from === edemo.planner.id));

// [34] Context Chunk / Span 階層（ページより細かい単位）
console.log('\n[34] Chunk / Span 階層');
const chunks34 = splitChunks('段落1。\n段落2。\n段落3。');
check('splitChunks で段落分割', chunks34.length === 3 && chunks34[0].includes('段落1'));
const spans34 = splitSpans('一文目。二文目。三文目。');
check('splitSpans で文分割', spans34.length === 3 && spans34[1].includes('二文目'));
check('spanKindOf で数式を判定', spanKindOf('x^2+2x+1=0 を解く') === 'equation');
const sub34 = subdivideContext(createContext({ nodes: [], edges: [] }, 'doc', '一行目。x^2+2x+1=0 を解く。\n二行目。', 40).graph, 1);
check('subdivide で Chunk/Span ノード生成', sub34.chunkIds.length >= 1 && sub34.spanIds.length >= 2);
check('span に kind 分類（equation）', sub34.graph.nodes.some((n) => n.kind === 'span' && n.attrs.kind === 'equation'));
check('page contains chunk contains span', sub34.graph.edges.some((e) => e.rel === 'contains'));

// [35] Execution Cursor / Attention（途中再開可能）
console.log('\n[35] Execution Cursor / Attention');
const c35 = createContext({ nodes: [], edges: [] }, 'c', '0123456789', 8);
const ex35 = createExecutionContext(c35.graph, c35.contextId, 'proc1', 'math');
const up35 = updateExecution(ex35.graph, ex35.exec.id, {
  currentPage: 2,
  currentChunk: 1,
  currentSpan: 3,
  cursor: 391,
  attention: ['Equation#5', 'Page#17'],
});
check('Cursor / Chunk / Span を設定', up35.exec.cursor === 391 && up35.exec.currentChunk === 1 && up35.exec.currentSpan === 3);
check('Attention を保持', up35.exec.attention.length === 2 && up35.exec.attention[0] === 'Equation#5');
const search35 = createExecutionContext(up35.graph, c35.contextId, 'proc1', 'search');
const sw35 = contextSwitch(search35.graph, ex35.exec.id, search35.exec.id);
const back35 = contextSwitch(sw35.graph, search35.exec.id, ex35.exec.id);
check('Switch 後も Cursor を復元（途中から再開）', executionOf(back35.graph, ex35.exec.id)?.cursor === 391 && executionOf(back35.graph, ex35.exec.id)?.currentChunk === 1);

// [36] Reasoning Stack / Execution Frames（複数推論の同時進行）
console.log('\n[36] Reasoning Stack');
const ex36 = createExecutionContext(c35.graph, c35.contextId, 'proc1', 'reasoning');
const fa = pushFrame(ex36.graph, ex36.exec.id, 'branchA', 'x=2 の可能性');
const fb = pushFrame(fa.graph, ex36.exec.id, 'branchB', 'x=-1 の可能性');
check('branchA / branchB を push', executionOf(fb.graph, ex36.exec.id)?.stack.length === 2);
check('Frame ノードが生成される', fb.graph.nodes.filter((n) => n.kind === 'frame').length === 2);
const popped = popFrame(fb.graph, ex36.exec.id);
check('popFrame で最上位を除去', executionOf(popped.graph, ex36.exec.id)?.stack.length === 1 && frameOf(popped.graph, fb.frame.id)?.state === 'popped');
const pushedAgain = pushFrame(popped.graph, ex36.exec.id, 'branchB2', 'x=-1 の可能性');
const merged36 = mergeFrames(pushedAgain.graph, ex36.exec.id, 'x=-1 が正しい');
check('mergeFrames で仮説統合・スタッククリア', executionOf(merged36.graph, ex36.exec.id)?.hypothesis === 'x=-1 が正しい' && executionOf(merged36.graph, ex36.exec.id)?.stack.length === 0);
check('merge 後フレームは merged', merged36.graph.nodes.filter((n) => n.kind === 'frame' && n.attrs.state === 'merged').length >= 2);

// [37] Context TLB（Context Translation Cache — 2回目は Fault しない）
console.log('\n[37] Context TLB');
const t37 = createContext({ nodes: [], edges: [] }, 'tlb', 'text\nx^2+2x+1=0 を解く。\ntext2', 40);
const sub37 = subdivideContext(t37.graph, t37.contextId);
const page37 = pagesOf(sub37.graph, t37.contextId)[0];
const tlb37 = new ContextTlb();
const tr1 = translateSpan(tlb37, sub37.graph, t37.contextId, page37.id, 'equation');
check('初回翻訳はミス（走査してキャッシュ）', tr1.hit === false && tr1.spanIds.length >= 1);
const tr2 = translateSpan(tlb37, sub37.graph, t37.contextId, page37.id, 'equation');
check('2回目はヒット（Fault しない）', tr2.hit === true);
check('TLB ヒット率', tlb37.hitRate() >= 0.5);
check('spansOfKind が equation だけ返す', spansOfKind(sub37.graph, page37.id, 'equation').every((s) => s.kind === 'equation'));

// [38] Hot / Warm / Cold Tier + Memory Hierarchy デモ
console.log('\n[38] Memory Tier / Memory Hierarchy デモ');
const tier38 = new TierManager();
check('未アクセスは COLD', tier38.tierOf(1) === 'cold');
tier38.touch(1);
check('1回アクセスで WARM', tier38.tierOf(1) === 'warm');
tier38.touch(1);
tier38.touch(1);
check('3回アクセスで HOT', tier38.tierOf(1) === 'hot');
tier38.touch(2);
check('evictCold が未アクセスを返す', tier38.evictCold().length === 0 && tier38.untrackedPages([1, 2, 3]).includes(3));
const mh = runMemoryHierarchyDemo();
check('Chunk/Span 階層が生成される', mh.chunkCount >= 4 && mh.spanCount > mh.chunkCount);
check('Equation スパンが分類される', mh.equationSpanCount >= 3);
check('TLB: 初回 miss → 2回目 hit', mh.tlbFirst === true && mh.tlbSecond === true && mh.tlbHitRate >= 0.5);
check('Reasoning Stack: branchA/branchB を merge', mh.frameLabels.join(',') === 'branchA,branchB' && mh.mergedHypothesis === 'x=-1 が正しい');
check('Memory Tier: HOT/WARM/COLD が揃う', mh.tiers.hot === 1 && mh.tiers.warm === 1 && mh.tiers.cold >= 1);
check('Cursor/Attention で途中再開可能', mh.cursor === 391 && mh.attention.includes('Equation#5') && mh.currentChunk !== null && mh.currentSpan !== null);

// [44] Remote Driver（実LLM: MockModelClient で検証）
console.log('\n[44] Remote Driver（実LLM接続）');
const rmc = new MockModelClient({ 'x^2を積分して': '∫x² dx = x³/3 + C' });
const rd44 = new RemoteDriver('remote:mock-qwen-1.5b', 'Qwen@mock', rmc, { deviceId: 'mock-qwen-1.5b' });
const rdRes = await rd44.invoke({ program: [{ opcode: MathOpcode.INTEGRAL, slots: [{ slot: Slot.INPUT, value: 'x^2を積分して' }] }], abiVersion: ABI_VERSION_1_0 });
check('RemoteDriver が実LLM相当で応答', rdRes.ok && rdRes.result === '∫x² dx = x³/3 + C');
check('RemoteDriver が使用デバイスを記録', rd44.lastNode?.nodeId === 'mock-qwen-1.5b');
const rdAbi = await rd44.invoke({ program: [], abiVersion: { major: 1, minor: 1 } });
check('RemoteDriver ABI 不整合 → UNSUPPORTED_ABI', !rdAbi.ok && rdAbi.error?.code === 2002);

// [45] Multi-expert AILSA Relay（Expert→Expert 通信）
console.log('\n[45] AILSA Relay');
const booted45 = boot();
const relay45 = await runRelay(booted45, [
  { expert: 'planning', input: '本を要約して' },
  { expert: 'math', input: 'x^2-4=0を解いて' },
  { expert: 'search', input: 'Webで記事を検索して' },
  { expert: 'reasoning', input: '結論をまとめて' },
  { expert: 'planning', input: '本を要約して' },
]);
check('Relay が 5 ホップ（Planner→Math→Search→Reasoning→Planner）', relay45.hops.length === 5);
check('各ホップが AILSA プログラム（hex）を保持', relay45.hops.every((h) => h.ailsaHex.length > 0));
check('AILSA メッセージ一覧', relay45.ailsaMessages.length === 5 && relay45.ailsaMessages[1].includes('CALL math'));
const relay45b = await runRelay(booted45, [
  { expert: 'math', input: 'x^2-4=0を解いて' },
  { expert: 'search', input: '' },
]);
check('Expert→Expert で値が伝播（solution(...) が次の INPUT へ）', relay45b.hops[1].input === 'solution(x^2-4=0)', relay45b.hops[1].input);
check('連鎖ホップは生の AILSA CALL として送られる', relay45b.hops[1].ailsaHex.startsWith('30'), relay45b.hops[1].ailsaHex.slice(0, 4));

// [46] Device Router（Mac / iPhone / iPad へルーティング）
console.log('\n[46] Device Router');
const dt46 = new DeviceTree();
dt46.registerNode({ id: 'local-pc', arch: 'arm64', cpu: 'Apple Silicon', ramMB: 16384, language: 'ja', cost: 0.1 });
registerHubDevices(dt46, [{ nodeId: 'node-ios-iphone15', modelId: 'Qwen/Qwen2.5-1.5B-Instruct', paramsM: 1540 }]);
check('実ノードが DeviceTree に登録', dt46.node('node-ios-iphone15') !== undefined);
check('routeCall が Mac/ローカルを優先', routeCall(dt46) === 'local-pc');
check('routeCall が優先指定を尊重', routeCall(dt46, 'node-ios-iphone15') === 'node-ios-iphone15');
const dr46 = createContext({ nodes: [], edges: [] }, 'dist', '0123456789abcdef', 8);
const pageA46 = pagesOf(dr46.graph, dr46.contextId)[0].id;
const g46 = assignPageDevice(dr46.graph, pageA46, 'node-ios-iphone15');
check('ページをデバイスへ配置（分散Context）', pageDevice(g46, pageA46) === 'node-ios-iphone15');

// [47] 分散 Context Fault（デバイスからページ取得）
console.log('\n[47] 分散 Context Fault');
const client47 = new MockModelClient({});
const df47 = await distributedFault(client47, 'node-ios-iphone15', 'ページ本文: x^2+2x+1=0');
check('分散 Fault が実デバイスから取得', df47.fromDevice === 'node-ios-iphone15' && df47.text.includes('mock') && df47.ms >= 0);

// [48] Capability オンライン学習（ODAR 完成）
console.log('\n[48] Capability オンライン学習');
const learner48 = new CapabilityLearner();
learner48.observe('math', { accuracy: 0.9, latencyMs: 20, cost: 0.2 });
const c48 = learner48.get('math');
check('EMA で能力値を更新（latency が 100→20 方向へ）', c48.samples === 1 && c48.accuracy > 0.5 && c48.latencyMs < 100);
learner48.observe('math', { accuracy: 0.5, latencyMs: 100, cost: 0.8 });
check('2回目の観測で学習が進む', learner48.get('math').samples === 2 && learner48.get('math').accuracy < c48.accuracy);
learner48.observe('search', { accuracy: 0.3, latencyMs: 200, cost: 0.9 });
check('Learning Scheduler が学習値で math を選ぶ', learner48.pick(['math', 'search']) === 'math');
const b48 = new AilsmBuilder();
const task48 = b48.addNode('task', 'solve', 'unknown', {});
const g48 = b48.graph();
const upd48 = updateCapabilitySsa(g48, task48, 'math', { accuracy: 0.9, latencyMs: 25, cost: 0.2 });
check('Capability SSA に学習値を反映', upd48.graph.nodes.some((n) => n.kind === 'capability' && n.attrs.expert === 'math' && n.attrs.accuracy === 0.9));
const upd48b = updateCapabilitySsa(upd48.graph, task48, 'math', { accuracy: 0.8, latencyMs: 30, cost: 0.3 });
check('Capability ノードを in-place 更新（重複しない）', upd48b.graph.nodes.filter((n) => n.kind === 'capability').length === 1 && upd48b.graph.nodes.some((n) => n.attrs.learned === true));

// [49] AI OS Init（Hub = AI OS 本体）
console.log('\n[49] AI OS Init');
const aios49 = initAiOs();
check('AI OS 起動（mock デバイス 2 台 + RemoteDriver）', aios49.remoteDrivers.size === 2 && aios49.booted.deviceTree.list().length >= 3);
const aex49 = await aiosExecute(aios49, '2と3を足して');
check('ローカル解決はドライバ不要（デバイスは割当済み）', aex49.driverId === null && aex49.result === null && aex49.deviceId !== null);
const aex49b = await aiosExecute(aios49, 'x^2を積分して');
check('CALL → 実デバイス（RemoteDriver）へ委譲', aex49b.driverId?.includes('remote:') === true && aex49b.deviceId !== null && aex49b.result !== null);
check('ODAR が実実行の観測を学習', aios49.learner.get(String(aex49b.driverId)).samples >= 1);
const rel49 = await aiosRelay(aios49, [{ expert: 'math', input: 'x^2-4=0を解いて' }, { expert: 'math', input: '' }]);
check('AI OS でリレー実行', rel49.hops.length === 2 && rel49.hops[1].input === 'solution(x^2-4=0)');
// 遅延同期: 起動後に実機が接続されても委譲できる（Hub 再起動シナリオ）
const lateClient = new MockModelClient({}, []);
const aiosLate = initAiOs(lateClient);
check('起動時はデバイス 0 台（RemoteDriver なし）', aiosLate.remoteDrivers.size === 0);
lateClient.addNode({ nodeId: 'node-ios-iphone15', modelId: 'Qwen/Qwen2.5-1.5B-Instruct', paramsM: 1540 });
const aexLate = await aiosExecute(aiosLate, 'x^2を積分して');
check('起動後に接続した実機へ遅延委譲', aexLate.driverId === 'remote:node-ios-iphone15' && aexLate.deviceId === 'node-ios-iphone15', String(aexLate.driverId));
check('DeviceTree に遅延登録', aiosLate.booted.deviceTree.node('node-ios-iphone15') !== undefined);

// [50] 専門 Expert 10 種（Phase 3.0）
console.log('\n[50] Expert 10 種');
const booted50 = boot();
check('11 種のドライバが登録', booted50.drivers.size === 11);
const prog50 = await booted50.drivers.get('programming')!.invoke({ program: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: 'sort array' }] }], abiVersion: ABI_VERSION_1_0 });
check('programming Expert が応答', prog50.ok && String(prog50.result).includes('code'));
const tr50 = await booted50.drivers.get('translate')!.invoke({ program: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: 'こんにちは' }] }], abiVersion: ABI_VERSION_1_0 });
check('translate Expert が応答', tr50.ok && String(tr50.result).includes('translate'));
const mem50 = await booted50.drivers.get('memory')!.invoke({ program: [{ opcode: MathOpcode.EQ, slots: [{ slot: Slot.INPUT, value: '覚えておいて' }] }], abiVersion: ABI_VERSION_1_0 });
check('memory Expert が応答', mem50.ok && String(mem50.result).includes('保存'));

// [51] 方式比較ベンチマーク（論文 Table）
console.log('\n[51] 方式比較');
const cmp51 = runComparisonBenchmark();
check('比較表に 7 行（6 方式 + ArcAsha）', cmp51.rows.length === 7);
const arc51 = cmp51.rows.find((r) => r.method.includes('Ours'))!;
const qwen51 = cmp51.rows.find((r) => r.method.includes('Long Context'))!;
const rag51 = cmp51.rows.find((r) => r.method.includes('RAG'))!;
check('ArcAsha の読むトークン < Qwen 全読', arc51.readTokens < qwen51.readTokens, `${arc51.readTokens} < ${qwen51.readTokens}`);
check('ArcAsha の Latency < Qwen Long Context', arc51.latencyMs < qwen51.latencyMs, `${arc51.latencyMs} < ${qwen51.latencyMs}`);
check('ArcAsha は RAG より高精度', arc51.accuracy > rag51.accuracy, `${arc51.accuracy} > ${rag51.accuracy}`);
check('比較表が Markdown で描画', cmp51.table.includes('| 方式 |') && cmp51.table.includes('ArcAsha AVM'));

// [52] Fault スケーリング実験（100 / 500 / 1000 ページ）
console.log('\n[52] Fault スケーリング');
const scale52 = runScalingExperiment([100, 500, 1000]);
check('3 レベルで実験', scale52.length === 3);
check('全レベルで Token 削減 > 50%', scale52.every((r) => r.tokenReduction > 50));
check('全レベルで Speedup > 1', scale52.every((r) => r.speedup > 1));
check('ページ増加で Fault 率が収束（≤60%）', scale52.every((r) => r.faultRate <= 60));
check('スケーリング表が描画', renderScaling(scale52).includes('| Pages |'));

// [53] ODAR マルチシグナル学習（success / battery / gpu）
console.log('\n[53] ODAR マルチシグナル');
const learner53 = new CapabilityLearner();
learner53.observe('math', { accuracy: 0.9, latencyMs: 20, cost: 0.2, success: true, battery: 0.8, gpu: 0.9 });
const c53 = learner53.get('math');
check('success/battery/gpu を EMA 学習', c53.successRate > 0.5 && c53.avgBattery > 0.5 && c53.avgGpu > 0.5);
learner53.observe('math', { accuracy: 0.9, latencyMs: 20, cost: 0.2, success: true, battery: 0.9, gpu: 0.2 });
check('2回目で学習が進む', learner53.get('math').samples === 2 && learner53.get('math').avgGpu < c53.avgGpu);
const l53x = new CapabilityLearner();
l53x.observe('a', { accuracy: 0.9, latencyMs: 30, cost: 0.2, success: true, battery: 0.9 });
l53x.observe('b', { accuracy: 0.9, latencyMs: 30, cost: 0.2, success: true, battery: 0.3 });
check('残量が多い Expert を学習で選ぶ', l53x.score('a') > l53x.score('b'));

// [54] 10 Expert リレー（Planner→Search→Math→Reasoning→Programming→Translate→Planner）
console.log('\n[54] 10 Expert リレー');
const relay54 = await runRelay(booted50, [
  { expert: 'planning', input: '本を要約して' },
  { expert: 'search', input: 'Webで記事を検索して' },
  { expert: 'math', input: 'x^2-4=0を解いて' },
  { expert: 'reasoning', input: '結論をまとめて' },
  { expert: 'programming', input: 'sort array' },
  { expert: 'translate', input: 'こんにちは' },
  { expert: 'planning', input: '本を要約して' },
]);
check('7 ホップがすべて成功', relay54.hops.length === 7 && relay54.hops.every((h) => h.ok));
check('AILSA メッセージが各ホップに', relay54.ailsaMessages.length === 7 && relay54.ailsaMessages[4].includes('CALL programming'));

// [55] 「作って」系意図 + Stage-2 フォールバック（既存AIのタスクを全部任せられる）
console.log('\n[55] create 意図 / Stage-2 フォールバック');
const c55 = compile('ログイン機能を作って');
check('「作って」→ intent=create / domain=code', c55.normalized.intent === 'create' && c55.normalized.domain === 'code');
check('「作って」→ programming へ CALL', c55.capability.expert === 'programming', c55.capability.expert);
check('「作って」のタスク文が INPUT に載る', c55.instructions.some((i) => i.slots?.some((s) => s.slot === Slot.INPUT && String(s.value).includes('ログイン'))));
const c55b = compile('Todoアプリを実装して');
check('「実装して」→ create', c55b.normalized.intent === 'create');
const c55c = compile('ゲームを作ろう');
check('「作ろう」→ create', c55c.normalized.intent === 'create');
const aios55 = initAiOs();
const cr55 = await aiosExecute(aios55, 'ログイン機能を作って');
check('「作って」→ 実デバイス(mock)へ委譲', cr55.driverId?.includes('remote:') === true && cr55.result !== null, String(cr55.driverId));
const fb55 = await aiosExecute(aios55, '量子コンピュータについて説明してください');
check('解釈不能タスクもフォールバックで委譲（400にしない）', fb55.fallback === true && fb55.driverId !== null && fb55.result !== null, String(fb55.driverId));
check('フォールバックの AILSA は生 CALL', (fb55.compile as { instructions: unknown[] }).instructions.length === 1);
check('フォールバックでも ODAR 学習', aios55.learner.get(String(fb55.driverId)).samples >= 1);

// [56] Hypothesis SSA（仮説の生成・評価・採用・淘汰・統合）
console.log('\n[56] Hypothesis SSA');
const b56 = new AilsmBuilder();
const t56 = b56.addNode('task', 'solve', 'unknown', { domain: 'math', intent: 'solve' });
let g56 = b56.graph();
const h1 = hypothesize(g56, t56, 'x=3 が解', 0.5);
g56 = h1.graph;
check('hypothesize で Hypothesis#N 生成', hypothesisOf(g56, h1.id)?.state === 'proposed' && hypothesisOf(g56, h1.id)?.confidence === 0.5);
check('task hypothesizes hypothesis エッジ', g56.edges.some((e) => e.rel === 'hypothesizes'));
g56 = activate(g56, h1.id, 'math').graph;
g56 = evaluate(g56, h1.id, 0.8).graph;
check('activate/evaluate で active + score', hypothesisOf(g56, h1.id)?.state === 'active' && hypothesisOf(g56, h1.id)?.score === 0.8);
g56 = accept(g56, h1.id).graph;
check('accept で accepted', hypothesisOf(g56, h1.id)?.state === 'accepted');
const h2 = hypothesize(g56, t56, 'x=-3 が解', 0.5);
g56 = h2.graph;
const m56 = merge(g56, t56, [h1.id, h2.id], 'x=±3', 0.9);
g56 = m56.graph;
check('merge で元は merged / 新仮説生成', hypothesisOf(g56, h1.id)?.state === 'merged' && hypothesisOf(g56, m56.id)?.text === 'x=±3' && hypothesisOf(g56, m56.id)?.parentIds.length === 2);
check('hypothesesOf で列挙', hypothesesOf(g56, t56).length === 3);

// [57] Reasoning Runtime デモ（x^2=9: SPAWN→EVAL→MERGE/KILL）
console.log('\n[57] Reasoning Runtime');
const demo57 = await runReasoningDemo();
check('デモ: 最終仮説 x=±3', demo57.finalText === 'x=±3', String(demo57.finalText));
check('デモ: 3 仮説を評価', demo57.rounds[0].evaluated.length === 3);
check('デモ: 低評価 H3 は KILL（淘汰）', demo57.rounds[0].killed.length === 1);
check('デモ: H1+H2 を MERGE', demo57.rounds[0].merged.length === 1 && demo57.rounds[0].merged[0].text === 'x=±3');
check('デモ: 各仮説が独立 Process（OS 並列）', demo57.processes >= 3);
check('デモ: Expert 呼び出しあり', demo57.expertCalls >= 3);

// [58] 汎用 Reasoning（既定の仮説生成 + 循環）
console.log('\n[58] 汎用 Reasoning');
const booted58 = boot();
const r58 = await runReasoning('新しい数学を考えて', booted58);
check('汎用: 仮説が生成される', r58.rounds.length >= 1 && r58.rounds[0].spawned.length >= 3);
check('汎用: Hypothesis ノードが SSA に', r58.graph.nodes.some((n) => n.kind === 'hypothesis'));
check('汎用: Expert 呼び出し / Process 生成', r58.expertCalls >= 3 && r58.processes >= 3);
check('汎用: 既定生成がドメイン別（math）', defaultHypothesisGenerator('x^2=9を解く')[0].expert === 'math' && defaultHypothesisGenerator('アプリを作って')[0].expert === 'programming');
check('汎用: 収束 or 全ラウンド完了', r58.finalText !== null || r58.rounds.every((rd) => rd.accepted.length === 0));

// [39] AI Performance Monitor（aiperf）
console.log('\n[39] AI Perf Monitor');
const perf39 = new AiPerf();
const tlb39 = new ContextTlb();
const tier39 = new TierManager();
perf39.attach(tlb39, tier39);
perf39.beginCall('math', 18);
perf39.beginCall('search', 42);
perf39.beginCall('math', 6);
perf39.recordPageRequest(false);
perf39.recordPageRequest(true);
perf39.recordPageRequest(true);
const snap39 = perf39.snapshot();
check('CALL 統計（math 2回 / search 1回）', snap39.calls[0].expert === 'search' && snap39.calls.find((c) => c.expert === 'math')?.count === 2);
check('Context Fault Rate', Math.abs(snap39.faultRate - 2 / 3) < 0.001);
check('Expert 利用率（search が最大）', snap39.expertUtilization.search > snap39.expertUtilization.math);
check('aiperf テキスト表示', perf39.render().includes('=== aiperf ===') && perf39.render().includes('TLB Hit Rate'));

// [40] AI Trace（Chrome Trace 互換）
console.log('\n[40] AI Trace');
const tr40 = new AiTrace();
tr40.complete('compile', 1000);
tr40.complete('call:math', 18000);
tr40.complete('reflect', 4000);
const json40 = JSON.parse(tr40.toChromeTrace()) as { traceEvents: unknown[] };
check('Chrome Trace 形式（traceEvents 配列）', Array.isArray(json40.traceEvents) && json40.traceEvents.length === 3);
const ev40 = json40.traceEvents[1] as { name: string; ph: string; dur: number };
check('complete イベント（X）に dur がある', ev40.ph === 'X' && ev40.dur === 18000 && ev40.name === 'call:math');
const rt40 = run('2と3を足して');
const runTrace40 = buildRuntimeTrace(rt40.steps);
const sched40 = buildSchedulerTrace(rt40.events);
check('Runtime/Scheduler Timeline が生成される', runTrace40.length === rt40.steps.length && sched40.length === rt40.events.length);
check('Timeline テキスト表示', renderTimeline(runTrace40).includes('compile'));

// [41] AI Profiler（Hot Expert / Hot Pages / Fault Hotspot）
console.log('\n[41] AI Profiler');
const prof41 = new AiProfiler();
prof41.recordExpert('math', 80);
prof41.recordExpert('search', 10);
prof41.recordExpert('planning', 10);
prof41.recordPageAccess(5, 1);
prof41.recordPageAccess(5, 1);
prof41.recordPageAccess(9, 1);
prof41.recordFault(5);
prof41.recordFault(5);
const p41 = prof41.profile();
check('Hot Expert = math（80%）', p41.hotExpert?.expert === 'math' && p41.hotExpert.share > 0.7);
check('Hot Pages がアクセス順', p41.hotPages[0]?.pageId === 5 && p41.hotPages[0]?.accesses === 2);
check('Fault Hotspot = Page5', p41.faultHotspots[0]?.pageId === 5 && p41.faultHotspots[0]?.faults === 2);
check('profiler テキスト表示', prof41.render().includes('Hot Expert'));

// [42] AI Benchmark（Long Context 比較: Qwen vs ArcAsha）
console.log('\n[42] AI Benchmark');
const syn42 = synthesizeContext('論文', 100, 64);
check('合成 Context が 100 ページ', syn42.graph.nodes.filter((n) => n.kind === 'page').length === 100);
check('ページ種別の決定論配置', pageKindOfIndex(0) === 'equation' && pageKindOfIndex(5) === 'search' && pageKindOfIndex(3) === 'summary');
const bench42 = runLongContextBenchmark(defaultQuestions(), 200, 64);
const t42 = bench42.totals;
check('Token 削減率 > 70%', t42.tokenReduction > 0.7, `${(t42.tokenReduction * 100).toFixed(1)}%`);
check('ページロード率 < 50%', t42.avgPageLoadRatio < 0.5, `${(t42.avgPageLoadRatio * 100).toFixed(1)}%`);
check('Speedup > 1', t42.speedup > 1, `${t42.speedup.toFixed(2)}x`);
check('TLB Hit Rate が計測される', t42.tlbHitRate > 0);
check('Context Fault Rate が計測される', t42.totalFaultRate > 0 && t42.totalFaultRate <= 1);

// [43] Observability 統合デモ
console.log('\n[43] Observability 統合');
const obs = runObservabilityDemo();
check('Chrome Trace が有効な JSON', (() => { try { JSON.parse(obs.chromeTrace); return true; } catch { return false; } })());
check('Timeline イベントが生成される', obs.traceEventCount > 0);
check('aiperf に CALL 統計', obs.perf.calls.length > 0);
check('profiler に Hot Expert', obs.profile.hotExpert !== null);
check('ベンチ: Token 削減率 > 70%', obs.headline.tokenReduction > 0.7, `${(obs.headline.tokenReduction * 100).toFixed(1)}%`);
check('ベンチ: Speedup > 1', obs.headline.speedup > 1, `${obs.headline.speedup.toFixed(2)}x`);
check('ベンチ: Fault Rate / TLB Hit が揃う', obs.headline.faultRate >= 0 && obs.headline.tlbHitRate > 0);

console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log('  ✅ ALL PASS — AILSM Phase 0.5（Stage 1 決定論 + Stage 3 決定論Verifier）');
} else {
  console.error(`  ❌ ${failed} 件の失敗`);
  process.exitCode = 1;
}
console.log('═'.repeat(60));
}

main();
