// @arcasha/orchestrator — consumer smoke test (build 後に実行: node packages/orchestrator/test/smoke.mjs)
import { ArcAshaController, RuleBasedPlanner, Verifier, EpisodeMemory, TreeSearch, PlanGenerator, Reflector } from '../dist/index.js';
import { LinUCBShadowRouter } from '../../router/dist/index.js';

const experts = [
  { nodeId: 'node-a', modelId: 'M1', family: 'qwen', paramsM: 500, memoryGB: 1, temperature: 0.6 },
  { nodeId: 'node-b', modelId: 'M2', family: 'smollm', paramsM: 300, memoryGB: 1, temperature: 0.6 },
  { nodeId: 'node-c', modelId: 'M3', family: 'gemma', paramsM: 1000, memoryGB: 2, temperature: 0.6 },
];

const backend = {
  experts,
  async compute(node, task) {
    const score = node.nodeId === 'node-b' ? 0.8 : node.nodeId === 'node-a' ? 0.5 : 0.3;
    return { nodeId: node.nodeId, text: `def solve(): return 1 # ${task.prompt.slice(0, 10)}`, score, latencyMs: 200 };
  },
};

const controller = new ArcAshaController(
  backend,
  new LinUCBShadowRouter(experts),
  new RuleBasedPlanner(),
  new Verifier(0.4),
  new EpisodeMemory(),
);

await controller.warmup([
  { id: 'w1', capability: 'coding', prompt: 'write a function' },
  { id: 'w2', capability: 'math', prompt: 'solve equation' },
  { id: 'w3', capability: 'reasoning', prompt: 'which is heavier' },
]);

// 1) 通常実行
const run = await controller.execute({ id: 't', capability: 'coding', prompt: 'write a python web scraper' });
console.log('1) execute: subtasks =', run.decisions.length, '| pass =', run.verifications.filter(v => v.passed).length);
const ok1 = run.decisions.length > 0;

// 2) Tree Search (プラン生成 → Beam → 最良)
const search = new TreeSearch(controller, new PlanGenerator(new RuleBasedPlanner()), 5, 2, 0);
const ts = await search.search({ id: 't2', capability: 'reasoning', prompt: 'Which weighs more: feathers or iron?' });
console.log('2) tree search: plans =', ts.beamEstimates.length, '| best score =', ts.best.score);
const ok2 = ts.beamEstimates.length >= 2 && ts.best.score >= 0;

// 3) Reflection 診断
const rr = await controller.executeReflective({ id: 't3', capability: 'math', prompt: 'what is 15% of 340' }, { maxIter: 2 });
console.log('3) reflective: final pass =', rr.finalRun.verifications.filter(v => v.passed).length, '/', rr.finalRun.verifications.length);
const ok3 = rr.finalRun.decisions.length > 0;

const allOk = ok1 && ok2 && ok3;
console.log(allOk ? '\nPASS: @arcasha/orchestrator ✅' : '\nFAIL ❌');
process.exit(allOk ? 0 : 1);
