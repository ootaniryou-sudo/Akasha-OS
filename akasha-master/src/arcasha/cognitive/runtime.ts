/**
 * Cognitive Runtime — 一時的認知ネットワーク（Task-Specific Dynamic Cognitive Graph）
 *
 * 普通の Agent は「AgentA → LLM → 結果 → AgentB」のパイプラインだが、
 * ここでは全 Expert が「共有タスクメモリ」を読み書きし、AILSM IR だけで会話する。
 *
 *   Vision   → 共有メモリに「object-list: door(0.91)」を書く
 *   Physics  → 共有メモリから object-list を読む →「trajectory」を書く
 *   Coding   → 共有メモリから trajectory を読む →「program」を書く
 *
 * タスク完了後、チームは解散してプールへ戻る（実行ログだけが残る）。
 */

import type { ComposedTeam } from './capability-graph.js';
import type { PoolExpert } from './pool.js';

/** 共有タスクメモリのエントリ（IR 値） */
export interface SharedMemoryEntry {
  key: string;   // データ型（凸凹）: object-list / trajectory / program ...
  value: string; // IR 値（自然言語ではなく型付きデータ）
  by: string;    // 書いた Expert
  at: number;
}

export interface CognitiveRunStep {
  expert: string;
  inputKey: string;  // 読んだデータ型
  outputKey: string; // 書いたデータ型
  ir: string;        // 書き込んだ IR
  ms: number;
}

export interface CognitiveRunResult {
  task: string;
  team: string[];
  graph: string[];
  memory: SharedMemoryEntry[];
  steps: CognitiveRunStep[];
  totalMs: number;
  quality: number;
  success: boolean;
}

/** IR 値の決定論生成（outputType に応じた型付きデータ） */
function genIr(expert: PoolExpert, task: string, input: SharedMemoryEntry | undefined): string {
  let h = 0;
  const s = task + expert.id + (input?.value ?? '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const r2 = (x: number): number => Math.round(x * 100) / 100;
  const conf = r2(0.7 + (h % 25) / 100);
  switch (expert.outputType) {
    case 'plan':
      return `plan: [steps=${1 + (h % 3)}] goal:"${task.slice(0, 16)}"`;
    case 'object-list':
      return `object-list: [door(conf ${conf}), obstacle(conf ${r2((h % 20) / 100 + 0.6)})]`;
    case 'trajectory':
      return `trajectory: [waypoints=${2 + (h % 4)}, risk=${r2((h % 30) / 100 + 0.1)}]`;
    case 'program':
      return `program: [plan=motor-control-v${1 + (h % 4)}, lines=${8 + (h % 20)}]`;
    case 'motion':
      return `motion: [mode=${h % 2 === 0 ? 'hover' : 'cruise'}, power=${30 + (h % 40)}%]`;
    case 'solution':
      return `solution: x=${r2((h % 100) / 10)}`;
    case 'documents':
      return `documents: [hits=${1 + (h % 5)}, top="${task.slice(0, 12)}"]`;
    case 'knowledge':
    default:
      return `knowledge: [mem=${h % 100}] ${input ? `<- ${input.key}` : ''}`;
  }
}

/**
 * 一時的認知ネットワークの実行:
 * 各 Expert が共有メモリから入力型を読み、出力型（IR）を共有メモリに書き込む。
 *
 * 実行は 2 系統:
 *   - Expert.execute が指定されていれば「実モデル / API / 実機」で実行
 *   - 未指定なら決定論の genIr()（Simulation）で実行
 * これにより「Cognitive Graph の仕組み」と「実モデル接続」を同じランタイムで扱える。
 */
export async function runCognitive(team: ComposedTeam, task: string): Promise<CognitiveRunResult> {
  const memory: SharedMemoryEntry[] = [];
  const steps: CognitiveRunStep[] = [];
  const t0 = Date.now();

  for (const member of team.members) {
    // 共有メモリから入力型の最新値を読む（全員が見られる）
    const input = [...memory].reverse().find((m) => m.key === member.inputType);
    let ms: number;
    let ir: string;

    if (member.execute) {
      // 実モデル / API / 実機 で実行（Expert が IR を返す）
      const r = await member.execute({
        task,
        input: input ? { key: input.key, value: input.value } : undefined,
      });
      ms = r.ms;
      ir = r.ir;
      if (!r.ok) {
        // 実行失敗: エラーを示す IR を共有メモリに残し、このメンバーをスキップ扱いにする
        memory.push({ key: member.outputType, value: `error: ${ir.slice(0, 60)}`, by: member.id, at: Date.now() });
        steps.push({ expert: member.id, inputKey: member.inputType, outputKey: member.outputType, ir: `error: ${ir.slice(0, 40)}`, ms });
        continue;
      }
    } else {
      // Simulation（決定論）: 型付き IR をハッシュから生成
      let h = 0;
      const s = task + member.id;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      ms = member.latencyMs + (h % 40);
      ir = genIr(member, task, input);
    }

    memory.push({ key: member.outputType, value: ir, by: member.id, at: Date.now() });
    steps.push({ expert: member.id, inputKey: member.inputType, outputKey: member.outputType, ir, ms });
  }

  const totalMs = Date.now() - t0;
  // 品質: 共有メモリでデータが受け渡せたほど高い（決定論）
  const connected = team.graph.filter((e) => e.to !== 'memory' && e.from !== 'memory').length;
  const total = team.graph.length;
  const quality = Math.round((0.6 + (total > 0 ? connected / total : 0.5) * 0.35) * 100) / 100;

  return {
    task,
    team: team.order,
    graph: team.graph.map((e) => `${e.from}--(${e.via})-->${e.to}`),
    memory,
    steps,
    totalMs,
    quality,
    success: quality >= 0.7,
  };
}

/** 実行結果の表示（IR 通信を可視化） */
export function renderCognitive(r: CognitiveRunResult): string {
  const lines: string[] = [];
  lines.push('═'.repeat(56));
  lines.push('Cognitive Graph Runtime — Task-Specific Dynamic Cognitive Graph');
  lines.push('═'.repeat(56));
  lines.push(`task  : ${r.task}`);
  lines.push(`team  : ${r.team.join(' → ')}`);
  lines.push(`graph : ${r.graph.join(' , ')}`);
  lines.push(`result: quality=${r.quality.toFixed(2)} ${r.success ? 'success' : 'fail'} / ${r.totalMs}ms`);
  lines.push('');
  lines.push('共有タスクメモリ + IR 通信:');
  for (const s of r.steps) {
    lines.push(`  [${s.expert}] read(${s.inputKey}) → write(${s.outputKey})`);
    lines.push(`      IR: ${s.ir}  (${s.ms}ms)`);
  }
  lines.push('');
  lines.push('共有メモリ最終状態:');
  for (const m of r.memory) {
    lines.push(`  ${m.key} <- ${m.by}: ${m.value}`);
  }
  return lines.join('\n');
}

