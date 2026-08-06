/**
 * Report Generator（Phase 4.1）— report.json / report.csv / report.md を自動生成
 *
 *   第三者追試のための機械可読出力（決定論・バージョン付き）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchResultRow } from './run.js';
import { overallAccuracy } from './run.js';
import type { OverheadProfile } from './overhead.js';

export const REPORT_VERSION = '1.1.0';
export const REPORT_CORPUS = 'GSM8K/MATH500/HumanEval/MBPP/MMLU/LiveCodeBench (deterministic subset)';

export const VALIDATION_KIND = 'simulation';
export const VALIDATION_NOTE = '設計上の評価モデル（決定論・再現可能）。実機実測は Real Device Benchmark（bench/real-device.ts）と区別する。';

/** JSON レポート（機械可読・追試可能） */
export function buildJsonReport(rows: BenchResultRow[], overhead: OverheadProfile[]): string {
  return JSON.stringify(
    {
      version: REPORT_VERSION,
      kind: VALIDATION_KIND,
      note: VALIDATION_NOTE,
      corpus: REPORT_CORPUS,
      configs: [...new Set(rows.map((r) => r.configName))],
      overall: overallAccuracy(rows),
      results: rows,
      osOverhead: overhead,
    },
    null,
    2,
  );
}

/** CSV レポート（表計算ソフト対応） */
export function buildCsvReport(rows: BenchResultRow[]): string {
  const header = 'suite,suite_name,category,config,config_name,samples,pass,accuracy,avg_quality';
  const lines = [header];
  for (const r of rows) {
    lines.push(`${r.suite},${r.suiteName},${r.category},${r.config},${r.configName},${r.samples},${r.pass},${r.accuracy.toFixed(4)},${r.avgQuality.toFixed(4)}`);
  }
  return lines.join('\n');
}

/** Markdown レポート（論文化用） */
export function buildMarkdownReport(rows: BenchResultRow[], overhead: OverheadProfile[]): string {
  const lines: string[] = [];
  lines.push(`# ArcAsha Benchmark Report`);
  lines.push('');
  lines.push(`- version: ${REPORT_VERSION}`);
  lines.push(`- kind: ${VALIDATION_KIND}（${VALIDATION_NOTE}）`);
  lines.push(`- corpus: ${REPORT_CORPUS}`);
  lines.push('');
  lines.push(`## External Benchmarks (Validation E)`);
  lines.push('');
  lines.push(`| Suite | ${[...new Set(rows.map((r) => r.configName))].join(' | ')} |`);
  lines.push(`|-------|${[...new Set(rows.map((r) => r.configName))].map(() => '------|').join('')}`);
  for (const suite of [...new Set(rows.map((r) => r.suite))]) {
    const cells = [...new Set(rows.map((r) => r.configName))].map((cn) => {
      const row = rows.find((r) => r.suite === suite && r.configName === cn)!;
      return `${(row.accuracy * 100).toFixed(0)}%`;
    });
    lines.push(`| ${suite} | ${cells.join(' | ')} |`);
  }
  const overall = overallAccuracy(rows);
  lines.push(`| **ALL** | ${overall.map((o) => `${(o.accuracy * 100).toFixed(0)}%`).join(' | ')} |`);
  lines.push('');
  lines.push(`## OS Overhead`);
  lines.push('');
  for (const p of overhead) {
    const name = p.components.length === 1 ? p.components[0].component : 'OS layered';
    const cpu = p.components.reduce((s, c) => s + c.cpuPct, 0);
    const llm = p.components.filter((c) => c.component.includes('LLM')).reduce((s, c) => s + c.cpuPct, 0);
    lines.push(`- **${p.config}**: ${name}（CPU ${cpu}%、うち LLM ${llm}%）`);
  }
  return lines.join('\n');
}

/** レポートをディスクへ書き出す（既定: reports/benchmark/） */
export async function writeReports(dir: string, rows: BenchResultRow[], overhead: OverheadProfile[]): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const json = buildJsonReport(rows, overhead);
  const csv = buildCsvReport(rows);
  const md = buildMarkdownReport(rows, overhead);
  const targets: [string, string][] = [
    [join(dir, 'report.json'), json],
    [join(dir, 'report.csv'), csv],
    [join(dir, 'report.md'), md],
  ];
  for (const [path, content] of targets) {
    await writeFile(path, content, 'utf8');
    files.push(path);
  }
  return files;
}
