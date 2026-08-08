// examples/node-ollama.mjs
// arcasha-orchestrator + arcasha-router で Ollama を ComputeBackend として使うサンプル。
// 前提: `ollama serve` が起動済み (デフォルト http://localhost:11434)。
// 実行: node examples/node-ollama.mjs
import { ArcAshaController, RuleBasedPlanner, Verifier, EpisodeMemory } from 'arcasha-orchestrator';
import { LinUCBShadowRouter } from 'arcasha-router';

const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODELS = [
  { nodeId: 'node-smollm', modelId: 'smollm2:360m', family: 'smollm', paramsM: 360, memoryGB: 1, temperature: 0.6 },
  { nodeId: 'node-qwen', modelId: 'qwen3:0.6b', family: 'qwen', paramsM: 596, memoryGB: 1, temperature: 0.6 },
  { nodeId: 'node-gemma', modelId: 'gemma3:1b', family: 'gemma', paramsM: 1000, memoryGB: 1, temperature: 0.6 },
];

async function ollamaGenerate(model, prompt) {
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: 256 } }),
  });
  const data = await res.json();
  return { text: data.response ?? '', latencyMs: Date.now() - t0 };
}

// ルールベース評価 (coding/math/reasoning) でシャドウ実行 + 報酬を計算するバックエンド
const backend = {
  experts: MODELS,
  async compute(node, task) {
    const { text, latencyMs } = await ollamaGenerate(node.modelId, task.prompt);
    const score = task.capability === 'coding'
      ? (text.includes('def ') || text.includes('function') ? 0.8 : 0.4)
      : task.capability === 'math'
        ? (/\d+/.test(text) ? 0.7 : 0.4)
        : text.length > 20 ? 0.7 : 0.4;
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

// ウォームアップ (シャドウ学習)
await controller.warmup([
  { id: 'w1', capability: 'coding', prompt: 'Write a function to reverse a string.' },
  { id: 'w2', capability: 'math', prompt: 'What is 25% of 440? Answer with a number.' },
  { id: 'w3', capability: 'reasoning', prompt: 'Which weighs more: a kilogram of iron or a kilogram of feathers?' },
]);

// 本番タスク
const run = await controller.execute({ id: 'task-1', capability: 'coding', prompt: 'Write a Python function that fetches a URL and returns the title.' });
console.log('\n=== 実行結果 ===');
for (const d of run.decisions) {
  console.log(`[${d.role}] -> ${d.nodeId}  (score=${d.score.toFixed(3)}, latency=${d.latencyMs}ms)`);
}
console.log(`検証: ${run.verifications.filter(v => v.passed).length}/${run.verifications.length} PASS`);
console.log('\n学習重み:', controller.weights().map(w => w.toFixed(3)).join(', '));

