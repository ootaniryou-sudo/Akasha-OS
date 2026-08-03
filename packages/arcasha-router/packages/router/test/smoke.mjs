// @arcasha/router — consumer smoke test (build 後に実行: node packages/router/test/smoke.mjs)
import {
  BayesianBelief,
  LinUCBShadowRouter,
  RandomRouter,
  UCBShadowRouter,
  computeRewards,
  findOracle,
} from '../dist/index.js';

const experts = [
  { nodeId: 'node-a', modelId: 'M1', family: 'qwen', paramsM: 500, memoryGB: 1, temperature: 0.6 },
  { nodeId: 'node-b', modelId: 'M2', family: 'smollm', paramsM: 300, memoryGB: 1, temperature: 0.6 },
  { nodeId: 'node-c', modelId: 'M3', family: 'gemma', paramsM: 1000, memoryGB: 2, temperature: 0.6 },
];

// 合成エキスパート品質 (coding): node-b 最強
const QUALITY = { 'node-a': 0.35, 'node-b': 0.85, 'node-c': 0.55 };
const CAPS = ['coding', 'math', 'reasoning'];

function freshStates() {
  const states = {};
  for (const e of experts) {
    const belief = {};
    for (const c of CAPS) belief[c] = new BayesianBelief();
    states[e.nodeId] = {
      capability: Object.fromEntries(CAPS.map(c => [c, belief[c].snapshot()])),
      latencyMs: 200,
      stability: 1.0,
    };
  }
  return states;
}

function run(router, steps) {
  const states = freshStates();
  const beliefs = {};
  for (const e of experts) {
    beliefs[e.nodeId] = Object.fromEntries(CAPS.map(c => [c, new BayesianBelief()]));
  }
  let regret = 0;
  for (let t = 0; t < steps; t++) {
    const task = { id: `t${t}`, capability: 'coding', prompt: 'write a function' };
    const results = {};
    for (const e of experts) {
      results[e.nodeId] = { nodeId: e.nodeId, text: 'x', score: QUALITY[e.nodeId], latencyMs: 200 };
    }
    // 状態更新 (信念)
    for (const e of experts) {
      beliefs[e.nodeId][task.capability].update(results[e.nodeId].score);
      states[e.nodeId].capability[task.capability] = beliefs[e.nodeId][task.capability].snapshot();
    }
    const maxLat = Math.max(...experts.map(e => states[e.nodeId].latencyMs), 1);
    const maxParams = Math.max(...experts.map(e => e.paramsM), 1);
    const rewards = computeRewards(experts, results, states, maxLat, maxParams);
    const ctx = { task, states, rewards, order: experts.map(e => e.nodeId), step: t };
    const chosen = router.select(ctx);
    router.observe(ctx);
    const oracle = findOracle(results);
    regret += results[oracle].score - results[chosen].score;
  }
  return regret;
}

const lin = run(new LinUCBShadowRouter(experts), 60);
const ucb = run(new UCBShadowRouter(experts), 60);
const rnd = run(new RandomRouter(experts, 7), 60);
console.log('cumulative regret @60 steps:');
console.log('  LinUCB-Shadow =', lin.toFixed(3));
console.log('  UCB-Shadow    =', ucb.toFixed(3));
console.log('  Random        =', rnd.toFixed(3));

const ok = lin < rnd && lin < ucb && lin >= 0;
console.log(ok ? '\nPASS: LinUCB-Shadow < baselines ✅' : '\nFAIL ❌');
process.exit(ok ? 0 : 1);
