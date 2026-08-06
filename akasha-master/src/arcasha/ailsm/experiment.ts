/**
 * Fault スケーリング実験（Phase 2.0）— 論文 Figure 用
 *
 * コンテキストを 100 / 500 / 1000 / 5000 ページと増やしながら
 * Fault Rate / TLB Hit / Tier / Latency / Speedup を測る（CPU 論文と同じ評価方法）。
 *
 *   Pages | Tokens | Loaded | Reduction | Fault | TLB Hit | Speedup
 *   100   |  1600  |  368   |  77%      | 24%   | 76%     | 3.5x
 *   ...
 */

import { defaultQuestions, runLongContextBenchmark } from './benchmark.js';

export interface ScalingRow {
  pages: number;
  tokens: number;
  loadedTokens: number;
  tokenReduction: number; // %
  pageLoadRatio: number; // %
  faultRate: number; // %
  tlbHitRate: number; // %
  speedup: number;
}

export function runScalingExperiment(pageCounts: number[] = [100, 500, 1000, 5000]): ScalingRow[] {
  const rows: ScalingRow[] = [];
  for (const pages of pageCounts) {
    const bench = runLongContextBenchmark(defaultQuestions(), pages, 64);
    const t = bench.totals;
    rows.push({
      pages,
      tokens: t.totalTokens,
      loadedTokens: t.loadedTokens,
      tokenReduction: t.tokenReduction * 100,
      pageLoadRatio: t.avgPageLoadRatio * 100,
      faultRate: t.totalFaultRate * 100,
      tlbHitRate: t.tlbHitRate * 100,
      speedup: t.speedup,
    });
  }
  return rows;
}

/** スケーリング表（Markdown） */
export function renderScaling(rows: ScalingRow[]): string {
  const lines: string[] = [];
  lines.push('| Pages | Tokens | Loaded | Token削減 | ページロード率 | Fault率 | TLB Hit | Speedup |');
  lines.push('|------:|-------:|-------:|----------:|---------------:|--------:|--------:|--------:|');
  for (const r of rows) {
    lines.push(
      `| ${r.pages} | ${r.tokens.toLocaleString()} | ${r.loadedTokens.toLocaleString()} | ${r.tokenReduction.toFixed(1)}% | ${r.pageLoadRatio.toFixed(1)}% | ${r.faultRate.toFixed(1)}% | ${r.tlbHitRate.toFixed(1)}% | ${r.speedup.toFixed(2)}x |`,
    );
  }
  return lines.join('\n');
}
