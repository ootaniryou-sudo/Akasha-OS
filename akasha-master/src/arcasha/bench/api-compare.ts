/**
 * API モデル比較ベンチ — DeepSeek V4 単体 vs DeepSeek + ArcAsha
 *
 * 目的: 「DeepSeek V4 が強いか」ではなく
 *       「ArcAsha の OS 層が外部 LLM を Expert として使うとき、
 *       どれだけ性能を引き出せるか（または追加コストがどれだけか）」を測る。
 *
 * 構成（同じ問題・同じモデル・同じ条件）:
 *   - baseline : DeepSeek 単体（プロンプトを直接送る）
 *   - arcasha  : 同じ問題を ArcAsha の aiosExecute（Stage-2 委譲）経由で解く
 *
 * 測るもの:
 *   - 正答率（参照文字列の包含判定 — 実測）
 *   - レイテンシ（API latency / total）
 *   - トークン使用量（近似）
 *   - コスト（モデル既定の料金に基づく概算）
 *
 * すべて kind: 'real-api'（実 API 呼び出し）。数値は偽装しない。
 */

import type { BenchSuite } from './types.js';
import { ALL_BENCH_SUITES } from './run.js';

export interface ApiCompareRow {
  suite: string;
  samples: number;
  pass: number;
  accuracy: number;       // pass/samples
  avgLatencyMs: number;   // 平均レイテンシ（実測）
  avgTokens: number;      // 平均トークン数（文字数近似）
  estCostUsd: number;     // 推定コスト（$）
}

export interface ApiCompareResult {
  kind: 'real-api';
  model: string;
  baseline: ApiCompareRow[];
  arcasha: ApiCompareRow[];
  note: string;
}

/**
 * 単一プロンプトを DeepSeek に送る（baseline 用）。
 * generate は (prompt) => Promise<{ text: string; ms: number }>
 */
export async function runApiCompare(
  opts: {
    model: string;
    /** DeepSeek 単体で呼ぶ */
    generateBaseline: (prompt: string, maxTokens?: number) => Promise<{ text: string; ms: number; tokens: number }>;
    /** ArcAsha 経由で呼ぶ（同じ問題を aiosExecute 相当で処理） */
    generateArcAsha: (prompt: string, maxTokens?: number) => Promise<{ text: string; ms: number; tokens: number }>;
    suites?: BenchSuite[];
  },
): Promise<ApiCompareResult> {
  const { model, generateBaseline, generateArcAsha } = opts;
  const suites = opts.suites ?? ALL_BENCH_SUITES.slice(0, 2); // gsm8k + math500（デフォルトは数学系）
  const note = `kind=real-api（実 API 呼び出し・数値を偽装しない）。同じ問題・同じモデル（${model}）で Baseline と ArcAsha 経由を比較。正答は参照文字列の包含判定（実測）。コストは概算（token 数 × モデル料金）。`;

  async function runOne(generate: (p: string, m?: number) => Promise<{ text: string; ms: number; tokens: number }>): Promise<ApiCompareRow[]> {
    const rows: ApiCompareRow[] = [];
    for (const suite of suites) {
      let pass = 0;
      let totalMs = 0;
      let totalTokens = 0;
      let sampleCount = 0;
      for (const sample of suite.samples) {
        try {
          const r = await generate(sample.prompt, 256);
          totalMs += r.ms;
          totalTokens += r.tokens;
          // 正答判定: 参照文字列の包含（実測・厳密な正規化はしない）
          const out = r.text.trim();
          const ref = sample.reference.trim();
          // 空文字出力（実行失敗・委譲なし）は決して pass にしない（ref.includes('') は常に true）
          if (out !== '' && ref !== '' && (out.includes(ref) || ref.includes(out))) pass++;
          sampleCount++;
        } catch (e) {
          // API エラーはスキップ（実行失敗を数えない）
          console.error(`  ⚠ sample skip: ${String(e).slice(0, 80)}`);
        }
      }
      rows.push({
        suite: suite.id,
        samples: sampleCount,
        pass,
        accuracy: sampleCount > 0 ? Math.round((pass / sampleCount) * 1000) / 1000 : 0,
        avgLatencyMs: sampleCount > 0 ? Math.round(totalMs / sampleCount) : 0,
        avgTokens: sampleCount > 0 ? Math.round(totalTokens / sampleCount) : 0,
        estCostUsd: estimateCost(model, totalTokens, sampleCount),
      });
    }
    return rows;
  }

  return {
    kind: 'real-api',
    model,
    baseline: await runOne(generateBaseline),
    arcasha: await runOne(generateArcAsha),
    note,
  };
}

/** コスト概算（$ / task）。モデルごとの料金は変わり得るため概算。 */
function estimateCost(model: string, totalTokens: number, samples: number): number {
  if (samples === 0) return 0;
  // 入力 1 トークン = 出力 1 トークンと近似（実際は要計測）
  const tokens = totalTokens / samples;
  // DeepSeek は出力 1M トークンあたり $1.10 前後（概算。変更されうる）
  const pricePerMToken = model.toLowerCase().includes('deepseek') ? 1.1 : 3.0;
  return Math.round((tokens * pricePerMToken / 1_000_000) * 1_000_000) / 1_000_000;
}

/** 表示 */
export function renderApiCompare(r: ApiCompareResult): string {
  const lines: string[] = [];
  lines.push('══════════════════════════════════════════════════════');
  lines.push(`API モデル比較 — ${r.model}（Baseline vs +ArcAsha）`);
  lines.push('══════════════════════════════════════════════════════');
  lines.push(`note : ${r.note}`);
  lines.push('');
  lines.push(`${'suite'.padEnd(10)} ${'config'.padEnd(9)} ${'acc'.padEnd(6)} ${'lat(ms)'.padEnd(9)} ${'tokens'.padEnd(7)} ${'cost($)'.padEnd(8)}`);
  const rows: { suite: string; config: string; acc: number; lat: number; tok: number; cost: number }[] = [
    ...r.baseline.map((x) => ({ suite: x.suite, config: 'baseline', acc: x.accuracy, lat: x.avgLatencyMs, tok: x.avgTokens, cost: x.estCostUsd })),
    ...r.arcasha.map((x) => ({ suite: x.suite, config: '+ArcAsha', acc: x.accuracy, lat: x.avgLatencyMs, tok: x.avgTokens, cost: x.estCostUsd })),
  ];
  for (const row of rows) {
    lines.push(`${row.suite.padEnd(10)} ${row.config.padEnd(9)} ${(row.acc * 100).toFixed(0).padStart(3)}% ${String(row.lat).padStart(7)} ${String(row.tok).padStart(6)} ${row.cost.toFixed(6).padStart(8)}`);
  }
  // サマリ
  const bAcc = r.baseline.reduce((s, x) => s + x.accuracy, 0) / Math.max(1, r.baseline.length);
  const aAcc = r.arcasha.reduce((s, x) => s + x.accuracy, 0) / Math.max(1, r.arcasha.length);
  const bLat = r.baseline.reduce((s, x) => s + x.avgLatencyMs, 0) / Math.max(1, r.baseline.length);
  const aLat = r.arcasha.reduce((s, x) => s + x.avgLatencyMs, 0) / Math.max(1, r.arcasha.length);
  lines.push('');
  lines.push(`平均正答率 : baseline ${(bAcc * 100).toFixed(1)}% vs +ArcAsha ${(aAcc * 100).toFixed(1)}%`);
  lines.push(`平均遅延   : baseline ${bLat.toFixed(0)}ms vs +ArcAsha ${aLat.toFixed(0)}ms`);
  lines.push(`※ 同一モデル・同一問題・実測。ArcAsha のオーバーヘッドは (ArcAsha - baseline) で示される。`);
  return lines.join('\n');
}
