# WebGPU サンプルガイド — ブラウザ内で ODAR ルーティング

WebGPU で複数の小さな LLM (例: WebLLM / Transformers.js WebGPU) を並べ、
`@arcasha/router` のロジック (純 TypeScript、依存なし) をそのままブラウザで動かす。

## なぜ WebGPU か

- ローカル推論 = コスト 0・プライバシー保護・オフライン
- モデルが小さいほど速いが能力が落ちる → 複数モデルを**能力に応じてルーティング**するのが最適
- ODAR は 8 次元特徴量 + シャドウ評価のみ → ブラウザでも軽量 (LinUCB は 8×8 行列逆行列)

## 構成

```
browser (WebGPU)
  ├── models: [qwen3-0.6b, smollm2-360m, gemma-1b]  (WebLLM / Transformers.js)
  ├── @arcasha/router (bundler で import)
  └── シャドウ評価は「キャッシュ済みスコア」or「軽量ルール評価」で代替
```

## コード (抜粋)

```ts
import { LinUCBShadowRouter, computeRewards, findOracle } from '@arcasha/router';

const experts = [
  { nodeId: 'web-qwen', modelId: 'Qwen3-0.6B', family: 'qwen', paramsM: 596, memoryGB: 1.2, temperature: 0.6 },
  { nodeId: 'web-smollm', modelId: 'SmolLM2-360M', family: 'smollm', paramsM: 360, memoryGB: 1, temperature: 0.6 },
  { nodeId: 'web-gemma', modelId: 'Gemma-3-1B', family: 'gemma', paramsM: 1000, memoryGB: 2, temperature: 0.6 },
];
const router = new LinUCBShadowRouter(experts);

export async function routeTask(task, runLocal: (node, task) => Promise<{ score, latencyMs }>) {
  // シャドウ評価 (キャッシュがあればそれを利用 → 実推論は選ばれたノードだけ)
  const results = {};
  for (const e of experts) results[e.nodeId] = await runLocal(e, task);
  // ... computeRewards → select → observe (router package 参照)
  return router.select({ task, states, rewards, order, step });
}
```

## 実装ノート

- バンドル: Vite + TypeScript で `@arcasha/router` を import (Node 標準 API 不使用のためブラウザ可)
- シャドウのコスト抑制: 全モデル推論は遅いので、**特徴量の統計的キャッシュ** + 時々の実測、
  または知識ベースの評価関数で代替する (実測は 1 ノードのみ)
- 完全な動作デモ: `akasha/public/worker-inference.js` + `public/node.html` を参照
  (Web Worker でモデル推論、メインスレッドでルーティング)

## 参考

- WebLLM: https://github.com/mlc-ai/web-llm
- Transformers.js (WebGPU): https://huggingface.co/docs/transformers.js
