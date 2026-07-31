#!/usr/bin/env npx tsx
/**
 * experiments/qwen3_0.6b/run_single_node.ts
 *
 * EXP-0001 — Akasha Single-Node LLM Integration
 * ──────────────────────────────────────────────
 * Runs Qwen3-0.6B via the LLM Adapter and compares output
 * against the golden reference.
 *
 * Usage:
 *   npx tsx experiments/qwen3_0.6b/run_single_node.ts \
 *     --prompt-file experiments/qwen3_0.6b/prompts/basic.jsonl \
 *     --golden-dir experiments/qwen3_0.6b/reference/golden
 */

import { QwenAdapter } from '../../src/llm/adapters/qwen.js';
import { ExperimentLogger, type ExperimentRun } from '../../src/experiments/logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface PromptEntry {
  prompt: string;
  max_new_tokens: number;
  temperature: number;
  top_p: number;
}

interface GoldenEntry {
  index: number;
  prompt: string;
  input_token_ids: number[];
  output_token_ids: number[];
  decoded_text: string;
  timing_ms: { tokenize: number; generate: number; total: number };
  config: { max_new_tokens: number; temperature: number; top_p: number };
}

// ─── Parse CLI ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const modelId = getArg('--model', 'Qwen/Qwen2.5-0.5B-Instruct');
const promptFile = getArg('--prompt-file', 'experiments/qwen3_0.6b/prompts/basic.jsonl');
const goldenDir = getArg('--golden-dir', '');
const device = getArg('--device', 'auto');

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const logger = new ExperimentLogger('experiments/qwen3_0.6b');

  // Load prompts
  const prompts: PromptEntry[] = fs
    .readFileSync(promptFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  console.log(`Loaded ${prompts.length} prompts from ${promptFile}`);

  // Load golden reference if available
  const goldenEntries: GoldenEntry[] = [];
  if (goldenDir && fs.existsSync(goldenDir)) {
    const files = fs.readdirSync(goldenDir).filter((f) => f.endsWith('.json') && f !== 'environment.json');
    for (const f of files.sort()) {
      goldenEntries.push(JSON.parse(fs.readFileSync(path.join(goldenDir, f), 'utf8')));
    }
    console.log(`Loaded ${goldenEntries.length} golden references from ${goldenDir}`);
  }

  // ── Load adapter ─────────────────────────────────────────────────────────

  console.log(`\nLoading Qwen adapter: ${modelId} ...`);
  const adapter = new QwenAdapter({ modelId, device });

  try {
    await adapter.loadModel();
    console.log('Model loaded successfully.');
  } catch (err) {
    console.error(`Failed to load model: ${err}`);
    console.error('Fallback: use mock mode for interface verification.');
    process.exit(1);
  }

  const meta = adapter.getModelMetadata();
  console.log(`  Model: ${meta.name} (${(meta.paramCount / 1e9).toFixed(1)}B params)`);
  console.log(`  Hidden: ${meta.hiddenSize}, Layers: ${meta.numLayers}, Vocab: ${meta.vocabSize}`);

  // ── Run experiments ──────────────────────────────────────────────────────

  let totalPass = 0;
  let totalFail = 0;

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const golden = goldenEntries[i] ?? null;

    console.log(`\n── Prompt ${i + 1}/${prompts.length} ──`);
    console.log(`  "${p.prompt.slice(0, 60)}..."`);

    // Run via adapter
    const t0 = performance.now();
    const output = await adapter.generate({
      prompt: p.prompt,
      maxNewTokens: p.max_new_tokens,
      temperature: p.temperature,
      topP: p.top_p,
      topK: 50,
    });
    const totalMs = performance.now() - t0;

    console.log(`  Output (${output.tokenIds.length} tokens): ${output.text.slice(0, 60)}...`);
    console.log(`  Time: ${totalMs.toFixed(0)}ms (${output.latencyBreakdown.totalMs.toFixed(0)}ms reported)`);

    // Tokenize prompt for logging
    const promptTokens = await adapter.tokenize(p.prompt);

    // ── Log ─────────────────────────────────────────────────────────────────

    const run = await logger.initRun({
      experimentId: 'EXP-0001',
      description: `Single-node Qwen inference — prompt ${i}`,
      tags: ['single-node', 'qwen', modelId, 'llm-adapter'],
      extra: { promptIndex: i },
    });

    run.input = {
      prompt: p.prompt,
      promptTokenIds: promptTokens.tokenIds,
      maxNewTokens: p.max_new_tokens,
      temperature: p.temperature,
      topP: p.top_p,
      topK: 50,
    };
    run.output = {
      tokenIds: output.tokenIds,
      text: output.text,
      tokenTimingsMs: output.tokenTimingsMs,
      latencyBreakdown: output.latencyBreakdown as Record<string, number>,
    };
    run.metrics = {
      totalMs,
      tokenizeMs: output.latencyBreakdown.tokenizeMs,
      prefillMs: output.latencyBreakdown.prefillMs,
      decodeMs: output.latencyBreakdown.decodeMsTotal,
      tokensPerSecond: output.tokenIds.length / (totalMs / 1000),
      promptTokens: promptTokens.numTokens,
      outputTokens: output.tokenIds.length,
    };

    // Golden comparison
    if (golden) {
      const comparison = logger.compareWithGolden(
        output.tokenIds,
        golden.output_token_ids,
      );
      run.goldenComparison = comparison;

      if (comparison.exactMatch) {
        console.log(`  ✅ Golden match: EXACT (${(comparison.tokenMatchRate * 100).toFixed(1)}%)`);
        totalPass++;
      } else {
        console.log(`  ❌ Golden mismatch: ${(comparison.tokenMatchRate * 100).toFixed(1)}% match`);
        for (const diff of comparison.diffs.slice(0, 5)) {
          console.log(`    ${diff}`);
        }
        totalFail++;
      }
    } else {
      console.log(`  ⚠ No golden reference for comparison`);
    }

    logger.saveRun(run);
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n══════════════════════════════════════════════`);
  console.log(` EXP-0001 Complete`);
  console.log(` Pass: ${totalPass}  Fail: ${totalFail}`);
  console.log(`══════════════════════════════════════════════`);

  await adapter.unload();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
