/**
 * experiments/logger.ts
 *
 * Akasha-OS — Experiment Logger
 * ─────────────────────────────
 * 全実験の入力・出力・メトリクスを構造化して記録する。
 * 再現可能性を担保するため、git commit / config / environment を自動収集。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

export interface ExperimentConfig {
  experimentId: string;
  description: string;
  tags: string[];
  /** Additional key-value metadata. */
  extra: Record<string, string | number | boolean>;
}

export interface ExperimentRun {
  runId: string;
  experimentId: string;
  timestamp: string;
  gitCommit: string;
  environment: EnvironmentInfo;
  config: ExperimentConfig;
  input: {
    prompt: string;
    promptTokenIds: number[];
    maxNewTokens: number;
    temperature: number;
    topP: number;
    topK: number;
  };
  output: {
    tokenIds: number[];
    text: string;
    tokenTimingsMs: number[];
    latencyBreakdown: Record<string, number>;
  };
  metrics: {
    totalMs: number;
    tokenizeMs: number;
    prefillMs: number;
    decodeMs: number;
    tokensPerSecond: number;
    promptTokens: number;
    outputTokens: number;
  };
  goldenComparison?: {
    tokenMatchRate: number;
    exactMatch: boolean;
    diffs: string[];
  };
}

export interface EnvironmentInfo {
  os: string;
  cpu: string;
  ram: string;
  gpu: string;
  nodeVersion: string;
  pythonVersion?: string;
  transformersVersion?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Logger
// ═════════════════════════════════════════════════════════════════════════════

export class ExperimentLogger {
  private baseDir: string;

  constructor(baseDir = 'experiments') {
    this.baseDir = baseDir;
  }

  /**
   * Create a new experiment run directory and write config.
   */
  async initRun(config: ExperimentConfig): Promise<ExperimentRun> {
    const runId = `${config.experimentId}_${Date.now()}`;
    const runDir = path.join(this.baseDir, config.experimentId, 'results', runId);
    fs.mkdirSync(runDir, { recursive: true });

    const env = this._collectEnvironment();

    const run: ExperimentRun = {
      runId,
      experimentId: config.experimentId,
      timestamp: new Date().toISOString(),
      gitCommit: this._getGitCommit(),
      environment: env,
      config,
      input: { prompt: '', promptTokenIds: [], maxNewTokens: 0, temperature: 0, topP: 0, topK: 0 },
      output: { tokenIds: [], text: '', tokenTimingsMs: [], latencyBreakdown: {} },
      metrics: {
        totalMs: 0, tokenizeMs: 0, prefillMs: 0, decodeMs: 0,
        tokensPerSecond: 0, promptTokens: 0, outputTokens: 0,
      },
    };

    // Write config immediately
    fs.writeFileSync(
      path.join(runDir, 'config.json'),
      JSON.stringify({ config, environment: env }, null, 2),
    );

    return run;
  }

  /**
   * Save a completed experiment run.
   */
  saveRun(run: ExperimentRun): string {
    const runDir = path.join(
      this.baseDir,
      run.experimentId,
      'results',
      run.runId,
    );

    // Full run data
    fs.writeFileSync(
      path.join(runDir, 'run.json'),
      JSON.stringify(run, null, 2),
    );

    // Metrics CSV (for easy plotting)
    const csv = [
      'metric,value',
      `totalMs,${run.metrics.totalMs}`,
      `tokenizeMs,${run.metrics.tokenizeMs}`,
      `prefillMs,${run.metrics.prefillMs}`,
      `decodeMs,${run.metrics.decodeMs}`,
      `tokensPerSecond,${run.metrics.tokensPerSecond}`,
      `promptTokens,${run.metrics.promptTokens}`,
      `outputTokens,${run.metrics.outputTokens}`,
      `tokenMatchRate,${run.goldenComparison?.tokenMatchRate ?? 'N/A'}`,
    ].join('\n');
    fs.writeFileSync(path.join(runDir, 'metrics.csv'), csv);

    // Output text
    fs.writeFileSync(
      path.join(runDir, 'output.txt'),
      run.output.text,
    );

    // Token IDs
    fs.writeFileSync(
      path.join(runDir, 'token_ids.json'),
      JSON.stringify({
        input: run.input.promptTokenIds,
        output: run.output.tokenIds,
        timings: run.output.tokenTimingsMs,
      }),
    );

    return runDir;
  }

  /**
   * Compare Akasha output with golden reference token IDs.
   */
  compareWithGolden(
    akashaTokenIds: number[],
    goldenTokenIds: number[],
  ): { tokenMatchRate: number; exactMatch: boolean; diffs: string[] } {
    const maxLen = Math.max(akashaTokenIds.length, goldenTokenIds.length);
    let matches = 0;
    const diffs: string[] = [];

    for (let i = 0; i < maxLen; i++) {
      const a = akashaTokenIds[i];
      const g = goldenTokenIds[i];
      if (a === g) {
        matches++;
      } else if (i < 10) {
        // Only log first 10 diffs to avoid spam
        diffs.push(`pos=${i}: akasha=${a} golden=${g}`);
      }
    }

    if (akashaTokenIds.length !== goldenTokenIds.length) {
      diffs.push(
        `length: akasha=${akashaTokenIds.length} golden=${goldenTokenIds.length}`,
      );
    }

    return {
      tokenMatchRate: maxLen > 0 ? matches / maxLen : 0,
      exactMatch:
        akashaTokenIds.length === goldenTokenIds.length && matches === maxLen,
      diffs,
    };
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private _collectEnvironment(): EnvironmentInfo {
    return {
      os: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      ram: `${Math.round(os.totalmem() / (1024 * 1024 * 1024))} GB`,
      gpu: process.env.AKASHA_GPU ?? 'unknown',
      nodeVersion: process.version,
      pythonVersion: process.env.AKASHA_PYTHON_VERSION,
      transformersVersion: process.env.AKASHA_TRANSFORMERS_VERSION,
    };
  }

  private _getGitCommit(): string {
    try {
      return require('node:child_process')
        .execSync('git rev-parse --short HEAD', { encoding: 'utf8' })
        .trim();
    } catch {
      return 'unknown';
    }
  }
}
