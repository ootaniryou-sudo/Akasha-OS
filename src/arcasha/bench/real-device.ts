/**
 * Real Device Benchmark（Phase 4.2）— 実機での実測（Simulation と分離）
 *
 *   Validation を 2 本立てにする:
 *     A. Simulation（設計上の評価モデル・決定論）— bench/run.ts の品質モデル
 *     B. Real Device（iPhone / iPad / Mac 実機）— このモジュール
 *
 *   実機が接続されていれば Hub（Phase 1 Device Runtime）経由で実行し、
 *   レイテンシ・電力・温度・品質を実測する。
 *   未接続時は status='not-connected' を返す（数値は偽造しない）。
 *
 *   「設計上の評価モデルの数字」と「実機実測の数字」を区別して論文に載せるための基盤。
 */

import { ALL_BENCH_SUITES } from './run.js';
import type { BenchSuite } from './types.js';
import { ALL_CONFIG_IDS } from './types.js';

export type DeviceStatus = 'measured' | 'not-connected';

export interface RealDeviceRow {
  device: string;
  suite: string;
  config: string;
  latencyMs: number | null;
  powerMw: number | null;
  temperatureC: number | null;
  accuracy: number | null;
  status: DeviceStatus;
}

export interface RealDeviceBenchmarkResult {
  kind: 'real-device';
  status: 'connected' | 'not-connected';
  devices: string[];
  rows: RealDeviceRow[];
  note: string;
}

export type DeviceMeasure = (device: string, suite: BenchSuite, config: string) => {
  latencyMs: number;
  powerMw: number;
  temperatureC: number;
  accuracy: number;
};

/**
 * 実機ベンチを実行する。
 *   - devices が空 → not-connected（数値を偽造しない）
 *   - devices あり → 各デバイス × スイート × 構成を measure で実測
 *   - measure 未指定の接続時は null 実測（実機統合待ち）を返す
 */
export async function runRealDeviceBenchmark(
  opts: { devices?: string[]; measure?: DeviceMeasure; suites?: BenchSuite[] } = {},
): Promise<RealDeviceBenchmarkResult> {
  const devices = opts.devices ?? [];
  const suites = opts.suites ?? ALL_BENCH_SUITES;
  const measure = opts.measure ?? null;

  if (devices.length === 0) {
    return {
      kind: 'real-device',
      status: 'not-connected',
      devices: [],
      rows: [],
      note: '実機未接続。iPhone / iPad / Mac を Hub（Phase 1 Device Runtime）に接続して再実行してください。Simulation の数値を実機のものと偽装しません。',
    };
  }

  const rows: RealDeviceRow[] = [];
  for (const device of devices) {
    for (const suite of suites) {
      for (const config of ALL_CONFIG_IDS) {
        if (measure) {
          const m = measure(device, suite, config);
          rows.push({ device, suite: suite.id, config, latencyMs: m.latencyMs, powerMw: m.powerMw, temperatureC: m.temperatureC, accuracy: m.accuracy, status: 'measured' });
        } else {
          rows.push({ device, suite: suite.id, config, latencyMs: null, powerMw: null, temperatureC: null, accuracy: null, status: 'not-connected' });
        }
      }
    }
  }
  return {
    kind: 'real-device',
    status: measure ? 'connected' : 'not-connected',
    devices,
    rows,
    note: measure
      ? '実機実測（Phase 1 Device Runtime 経由）。Simulation と区別して報告します。'
      : 'デバイスは接続されていますが実測コールバックが未指定です（実機統合待ち）。',
  };
}

export function renderRealDeviceBenchmark(r: RealDeviceBenchmarkResult): string {
  const lines: string[] = [];
  lines.push('=== Real Device Benchmark（実機実測・Simulation と分離）===');
  lines.push(`Status: ${r.status} / Devices: ${r.devices.join(', ') || '(なし)'}`);
  lines.push(`NOTE  : ${r.note}`);
  if (r.rows.length > 0) {
    lines.push('');
    lines.push('device   suite           config    latency   power   temp   accuracy');
    for (const row of r.rows) {
      const lat = row.latencyMs === null ? '  —    ' : String(row.latencyMs).padStart(5) + 'ms';
      const pwr = row.powerMw === null ? '  —   ' : String(row.powerMw).padStart(4) + 'mW';
      const tmp = row.temperatureC === null ? '  —  ' : String(row.temperatureC).padStart(3) + '°C';
      const acc = row.accuracy === null ? '   —   ' : (row.accuracy * 100).toFixed(0) + '%';
      lines.push(`${row.device.padEnd(8)} ${row.suite.padEnd(14)} ${row.config.padEnd(10)} ${lat} ${pwr} ${tmp} ${acc}`);
    }
  }
  return lines.join('\n');
}
