#!/usr/bin/env npx tsx
/**
 * EXP-0001 tokenizer comparison: Python vs JS/ONNX
 * Compares input token IDs between Python Transformers and Transformers.js.
 */
import { QwenAdapter } from '../../src/llm/adapters/qwen.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const GOLDEN_DIR = path.resolve('experiments/qwen3_0.6b/golden/output');
const MODEL = 'onnx-community/Qwen3-0.6B-ONNX';

async function main() {
  const adapter = new QwenAdapter({ modelId: MODEL, device: 'cpu' });
  await adapter.loadModel();
  console.log('=== Tokenizer Comparison (Python Transformers vs Transformers.js ONNX) ===\n');

  const files = fs.readdirSync(GOLDEN_DIR)
    .filter(f => f.endsWith('.json') && f !== 'manifest.json')
    .sort();

  let inputMatch = 0;
  const results: Record<string, unknown>[] = [];

  for (const f of files) {
    const golden = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, f), 'utf8'));
    const prompt: string = golden.prompt;

    // JS tokenizer
    const jsTok = await adapter.tokenize(prompt);
    const pyInputIds: number[] = golden.input_token_ids;

    const match = jsTok.tokenIds.length === pyInputIds.length &&
      jsTok.tokenIds.every((id: number, i: number) => id === pyInputIds[i]);

    console.log(`${f}: "${prompt.slice(0, 50)}..."`);
    console.log(`  Python tokens: ${pyInputIds.length} [${pyInputIds.slice(0, 5).join(', ')}...]`);
    console.log(`  JS tokens:     ${jsTok.tokenIds.length} [${jsTok.tokenIds.slice(0, 5).join(', ')}...]`);
    console.log(`  Tokenizer: ${match ? '✅ EXACT MATCH' : '❌ MISMATCH'}`);

    if (!match) {
      const maxLen = Math.max(pyInputIds.length, jsTok.tokenIds.length);
      const diffs: string[] = [];
      for (let i = 0; i < maxLen; i++) {
        if (pyInputIds[i] !== jsTok.tokenIds[i]) {
          diffs.push(`pos ${i}: py=${pyInputIds[i]} js=${jsTok.tokenIds[i]}`);
          if (diffs.length >= 5) break;
        }
      }
      console.log(`  First diffs: ${diffs.join(', ')}`);
    } else {
      inputMatch++;
    }
    results.push({ file: f, prompt, inputMatch: match, pyLen: pyInputIds.length, jsLen: jsTok.tokenIds.length });
    console.log();
  }

  console.log('=== INPUT TOKENIZER SUMMARY ===');
  console.log(`Match: ${inputMatch}/${files.length}`);
  
  if (inputMatch === files.length) {
    console.log('✅ INPUT TOKENIZER: FULL MATCH — Python and JS tokenizers are IDENTICAL.');
  } else {
    console.log('❌ INPUT TOKENIZER: MISMATCH detected!');
    console.log('   Root cause: different tokenizer implementations between');
    console.log('   Python transformers and @huggingface/transformers (JS).');
  }

  await adapter.unload();
}

main().catch(e => { console.error(e); process.exit(1); });
