/**
 * Local Expert Runtime（Phase 1・最小版）— 1台のPC上で複数のExpertがAILSAで通信する
 *
 *   Natural Language → Compiler → AILSM → Executor
 *     → needsExpert → (Belief/Capability/Schedule) → CALL
 *     → Driver（Math / Search ...）→ RETURN
 *     → Kernel（Memory 保存）→ AILSM 更新
 *
 * 通信は「AI OS の実行バックエンド」の一つ。ここではローカルドライバがそれを担う。
 * 実機（iPad/iPhone）へは同じインターフェースの Driver を実装して差し替える（Phase 1 後半）。
 */

import { compileAndRun } from './compiler.js';
import type { CompileResult } from './compiler.js';
import { run } from './runtime.js';
import type { RuntimeTrace } from './runtime.js';
import { AIKernel } from './kernel.js';
import { MockExpertDriver } from './driver.js';
import type { DriverResponse, ExpertDriver } from './driver.js';
import { DeviceTree } from './device-tree.js';
import { ABI_VERSION_1_0 } from './abi.js';
import { setProcessState } from './state.js';
import type { AilsmGraph } from './ailsm.js';

export interface BootResult {
  deviceTree: DeviceTree;
  drivers: Map<string, ExpertDriver>;
  kernel: AIKernel;
}

/** AI OS を起動する: Device Tree + Expert Driver 登録 */
export function boot(): BootResult {
  const deviceTree = new DeviceTree();
  deviceTree.registerNode({
    id: 'local-pc',
    arch: 'arm64',
    cpu: 'Apple Silicon',
    gpu: 'Apple GPU (Metal)',
    ramMB: 16384,
    language: 'ja',
    cost: 0.1,
    features: { fp16: true },
  });

  const drivers = new Map<string, ExpertDriver>();
  // Phase 3.0: 専門 Expert 10 種 + general（Stage-2 フォールバック用）
  const EXPERT_10 = [
    'math', 'search', 'programming', 'vision', 'planning',
    'translate', 'summarizer', 'retriever', 'reasoning', 'memory', 'general',
  ];
  for (const id of EXPERT_10) {
    drivers.set(id, new MockExpertDriver(id, `${id} Expert`));
  }

  return { deviceTree, drivers, kernel: new AIKernel() };
}

export interface ExpertExecution {
  text: string;
  compile: CompileResult;
  trace: RuntimeTrace;
  driverId: string | null;
  driverResponse: DriverResponse | null;
  finalGraph: AilsmGraph;
  result: string | number | null;
  ms: number;
}

/**
 * タスクを実行する: ローカル解決 or Driver への CALL → Kernel で結果を保存
 *
 * resolveDriver: 実LLM（RemoteDriver）等へ差し替えるフック（Phase 1.0）。
 * 省略時は boot 済みの Mock ドライバを使う。
 */
export async function execute(
  text: string,
  booted: BootResult,
  resolveDriver?: (expert: string) => ExpertDriver | undefined,
): Promise<ExpertExecution> {
  const compiled = compileAndRun(text).compile;
  const trace = run(text);
  let graph = trace.graph;
  let driverId: string | null = null;
  let driverResponse: DriverResponse | null = null;
  const t0 = Date.now();

  if (trace.needsExpert && trace.processId !== undefined) {
    const belief = graph.nodes.find((n) => n.kind === 'belief');
    const expert = String(belief?.attrs.expert ?? 'general');
    const driver = resolveDriver ? resolveDriver(expert) : booted.drivers.get(expert);

    if (driver) {
      driverId = driver.id;
      driverResponse = await driver.invoke({ program: compiled.instructions, abiVersion: ABI_VERSION_1_0 });

      const processId = trace.processId;
      if (driverResponse.ok) {
        const res = booted.kernel.memoryStore(graph, processId, 'result', driverResponse.result ?? '');
        graph = res.graph;
        // ライフサイクル: waiting（CALL中）→ ready → running → finished
        graph = setProcessState(graph, processId, 'ready').graph;
        graph = setProcessState(graph, processId, 'running').graph;
        graph = setProcessState(graph, processId, 'finished').graph;
      } else {
        const refl = booted.kernel.reflectRequest(graph, processId, driverResponse.error?.message ?? 'unknown', 'retry');
        graph = refl.graph;
        graph = setProcessState(graph, processId, 'failed').graph;
      }
    }
  }

  return {
    text,
    compile: compiled,
    trace,
    driverId,
    driverResponse,
    finalGraph: graph,
    result: driverResponse?.ok ? (driverResponse.result ?? null) : null,
    ms: Date.now() - t0,
  };
}
