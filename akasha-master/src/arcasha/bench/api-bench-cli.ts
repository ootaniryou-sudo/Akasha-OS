/**
 * API 比較ベンチ CLI — `arcasha apibench`
 *
 * DeepSeek V4 単体 vs DeepSeek + ArcAsha を同じ問題で比較する。
 *
 * 使い方:
 *   DEEPSEEK_API_KEY=... npx tsx src/arcasha/cli.ts apibench
 *   （.env の DEEPSEEK_API_KEY でも可）
 *
 * サーバー（demo-web）に依存しない。このプロセス内で ExpertHub を起動し、
 * DeepSeek を API ノードとして登録して aiosExecute を直接呼ぶ。
 */
import 'dotenv/config';
import { runApiCompare, renderApiCompare } from './api-compare.js';
import { ExpertHub } from '../experts/registry.js';
import { initAiOs, aiosExecute } from '../ailsm/aios.js';
import type { AiOs } from '../ailsm/aios.js';

const MAX_TOKENS = 256;

/** DeepSeek 互換 /v1/chat/completions を直接呼ぶ（baseline） */
async function callDeepSeek(prompt: string, maxTokens = MAX_TOKENS): Promise<{ text: string; ms: number; tokens: number }> {
  const base = (process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const key = process.env.DEEPSEEK_API_KEY ?? '';
  if (!key) throw new Error('DEEPSEEK_API_KEY が設定されていません（.env を確認）');
  const t0 = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const text = data.choices?.[0]?.message?.content ?? '';
  const ms = Date.now() - t0;
  const tokens = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0) || text.length;
  return { text, ms, tokens };
}

/** このプロセス内で ArcAsha OS（ExpertHub + AI OS）を組み立てる */
function buildAiOs(): { aios: AiOs; hub: ExpertHub } {
  const hub = new ExpertHub();
  const base = (process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const key = process.env.DEEPSEEK_API_KEY ?? '';
  if (key) hub.addApiNode('api-deepseek', base, key, model);
  const aios = initAiOs({
    listNodes: () => hub.experts.map((e) => ({ nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM })),
    generate: async (nodeId, prompt, maxTokens = MAX_TOKENS) =>
      hub.generate(nodeId, String(prompt), Number(maxTokens) || MAX_TOKENS),
  });
  return { aios, hub };
}

export async function runApiBenchCli(): Promise<string> {
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const key = process.env.DEEPSEEK_API_KEY ?? '';
  if (!key) throw new Error('DEEPSEEK_API_KEY が設定されていません（.env を確認）');

  console.log(`🔄 API 比較ベンチ開始（${model}）— 実 API 呼び出し（kind=real-api）`);
  console.log('  比較: DeepSeek 単体 vs DeepSeek + ArcAsha（本物の aiosExecute 経由・同一プロセス）');
  console.log('  forceDelegate=true + maxTokens 統一で、同じ問題を同じモデル・同じ上限で解かせます。');
  console.log('');

  const { aios, hub } = buildAiOs();

  const r = await runApiCompare({
    model,
    // baseline: DeepSeek 単体で直接
    generateBaseline: (prompt, maxTokens) => callDeepSeek(prompt, maxTokens),
    // arcasha: 同じ問題を本物の ArcAsha OS（aiosExecute → Stage-2 委譲 → DeepSeek）で処理
    // forceDelegate=true で、ローカル解決をスキップして必ず DeepSeek（実機LLM）へ委譲する
    // → 同じ問題・同じモデル・同じ maxTokens で公平に比較する
    generateArcAsha: async (prompt, maxTokens) => {
      const t0 = Date.now();
      const ex = await aiosExecute(aios, prompt, 'api-deepseek', {
        forceDelegate: true,
        maxTokens: maxTokens ?? MAX_TOKENS,
      });
      const text = ex.result !== null && ex.result !== undefined ? String(ex.result) : '';
      // 実トークン使用量（DeepSeek の usage）を使う（baseline と同一の計測）
      const usage = hub.lastApiUsage;
      const tokens = usage ? usage.promptTokens + usage.completionTokens : text.length;
      return { text, ms: Date.now() - t0, tokens };
    },
  });

  const text = renderApiCompare(r);
  console.log(text);
  return 'arcasha apibench: done（kind=real-api・実測・同一プロセス）';
}

