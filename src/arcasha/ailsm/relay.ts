/**
 * Multi-expert AILSA Relay（Phase 1.1）— Expert→Expert の AILSA 通信
 *
 *   Planner → Math → Search → Reasoning → Planner
 *
 * 各ホップは「前の Expert の出力」を入力とし、AILSA プログラム（CALL + INPUT）として
 * 次の Expert へ渡す。これが ArcAsha 最大の売り（Expert が AILSA だけで通信する）。
 *
 * Mac 上のデモ: 全ドライバ（Mock or 実LLM）が同じインターフェースなので差し替え可能。
 */

import { compile, toHex } from './compiler.js';
import { encodeProgram } from '../ailsa/encoder.js';
import { Slot } from '../ailsa/vocab.js';
import { Opcode } from '../ailsa/opcode.js';
import type { Instruction } from '../ailsa/encoder.js';
import { ABI_VERSION_1_0 } from './abi.js';
import type { DriverResponse, ExpertDriver } from './driver.js';
import type { BootResult } from './expert-runtime.js';

export interface RelayStep {
  expert: string;
  input: string; // 初回入力を明示。前ホップの出力で上書きする場合は空文字
  query?: string;
}

export interface RelayHop {
  index: number;
  expert: string;
  input: string;
  output: string | number | null;
  driverId: string | null;
  ok: boolean;
  ailsaHex: string; // このホップで送った AILSA プログラム（hex）
  trace: string[];
  ms: number;
}

export interface RelayResult {
  hops: RelayHop[];
  final: string | number | null;
  ailsaMessages: string[]; // Expert→Expert の AILSA メッセージ一覧
}

export async function runRelay(
  booted: BootResult,
  steps: RelayStep[],
  resolveDriver?: (expert: string) => ExpertDriver | undefined,
): Promise<RelayResult> {
  const hops: RelayHop[] = [];
  let prevOutput: string | number | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // 前ホップの出力を入力として渡す（Expert→Expert の値の受け渡し）
    const input = prevOutput !== null && step.input === '' ? String(prevOutput) : step.input;
    let program: Instruction[];
    let ailsaHex: string;
    if (step.input !== '') {
      // 明示入力: コンパイルして AILSA プログラム化
      program = compile(input).instructions;
      ailsaHex = toHex(encodeProgram(program));
    } else {
      // 連鎖: 前ホップの出力をそのまま INPUT に載せた CALL（再コンパイルしない）
      program = [
        { opcode: Opcode.CALL, slots: [{ slot: Slot.EXPERT, value: step.expert }, { slot: Slot.INPUT, value: input }] },
      ];
      ailsaHex = toHex(encodeProgram(program));
    }
    const driver = resolveDriver ? resolveDriver(step.expert) : booted.drivers.get(step.expert);

    let driverId: string | null = null;
    let ok = false;
    let output: string | number | null = null;
    let trace: string[] = [];
    let ms = 0;
    if (driver) {
      driverId = driver.id;
      const t0 = Date.now();
      const resp: DriverResponse = await driver.invoke({ program, abiVersion: ABI_VERSION_1_0 });
      ms = Date.now() - t0;
      trace = resp.trace;
      ok = resp.ok;
      output = resp.ok ? (resp.result ?? null) : null;
    }
    hops.push({ index: i, expert: step.expert, input, output, driverId, ok, ailsaHex, trace, ms });
    prevOutput = output;
  }

  const ailsaMessages = hops.map((h, i) => `hop${i}: CALL ${h.expert} :: ${h.ailsaHex}`);
  return { hops, final: prevOutput, ailsaMessages };
}

/** リレーの人間可読表示（Mac デモ用） */
export function renderRelay(r: RelayResult): string {
  const lines: string[] = ['=== AILSA Relay ==='];
  for (const h of r.hops) {
    const arrow = h.index === 0 ? '──►' : '──►';
    lines.push(`  ${arrow} ${h.expert.padEnd(10)} ${h.ok ? 'ok' : 'ERR'} ${h.ms}ms`);
    lines.push(`       input : ${h.input.slice(0, 60)}`);
    lines.push(`       output: ${String(h.output ?? '').slice(0, 60)}`);
    lines.push(`       ailsa : ${h.ailsaHex.slice(0, 60)}...`);
  }
  lines.push(`  FINAL: ${String(r.final ?? '').slice(0, 80)}`);
  return lines.join('\n');
}
