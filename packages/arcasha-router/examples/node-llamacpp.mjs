// examples/node-llamacpp.mjs
// @arcasha/orchestrator を llama.cpp サーバー (llama-server) に接続するサンプル。
// 前提: llama-server を起動しておく。
//   llama-server -m model.gguf --port 8080 -n 256
// 実行: node examples/node-llamacpp.mjs
import { ArcAshaController, RuleBasedPlanner, Verifier, EpisodeMemory } from '@arcasha/orchestrator';
import { LinUCBShadowRouter } from '@arcasha/router';

const SERVER = process.env.LLAMACPP_HOST || 'http://localhost:8080';
const MODELS = [
  { nodeId: 'node-nano', modelId: 'tinyllm-nano.gguf', family: 'tinyllm', paramsM: 50, memoryGB: 1, temperature: 0.6 },
  { nodeId: 'node-micro', modelId: 'demo-tinyllm-micro.gguf', family: 'tinyllm', paramsM: 20, memoryGB: 1, temperature: 0.6 },
];

// llama.cpp OpenAI 互換エンドポイント (/v1/completions)
async function llamaGenerate(model, prompt) {
  const t0 = Date.now();
  const res = await fetch(`${SERVER}/v1/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, temperature: 0, max_tokens: 128 }),
  });
  const data = await res.json();
  return { text: data.choices?.[0]?.text ?? '', latencyMs: Date.now() - t0 };
}

const backend = {
  experts: MODELS,
  async compute(node, task) {
    const { text, latencyMs } = await llamaGenerate(node.modelId, task.prompt);
    const score = text.length > 10 ? 0.7 : 0.4; // 簡易評価 (実運用は evaluateTask 推奨)
    return { nodeId: node.nodeId, text, score, latencyMs };
  },
};

const controller = new ArcAshaController(
  backend,
  new LinUCBShadowRouter(MODELS),
  new RuleBasedPlanner(),
  new Verifier(0.4),
  new EpisodeMemory(),
);

await controller.warmup([
  { id: 'w1', capability: 'reasoning', prompt: 'A train leaves at 3pm and arrives at 5pm. How many hours?' },
]);

const run = await controller.execute({ id: 'task-1', capability: 'reasoning', prompt: 'If x = 4 and y = 3, what is x * y? Answer with a number.' });
console.log('\n=== 実行結果 ===');
for (const d of run.decisions) {
  console.log(`[${d.role}] -> ${d.nodeId} (score=${d.score.toFixed(3)}, latency=${d.latencyMs}ms)`);
}
console.log(`検証: ${run.verifications.filter(v => v.passed).length}/${run.verifications.length} PASS`);
