/**
 * ArcAsha v1.0 Quickstart — 5 つのステップで「OS が推論を管理する」を体感
 *
 *   1. Thinking Mode で実行（Fast / Auto / Deep）
 *   2. Decision Explanation（なぜこの構成を選んだか）
 *   3. Executive の推論（仮説 → 採用 → 統合）
 *   4. OS ポリシー学習（Decision を学習データにする）
 *
 * 実行: npx tsx examples/quickstart.ts
 */

import { runThinking, renderThinking } from '../src/arcasha/attachments/modes.js';
import { explainExecutive, renderExplanation } from '../src/arcasha/attachments/explain.js';
import { runExecutiveDemo, renderExecutive } from '../src/arcasha/ailsm/executive-runtime.js';
import { runPolicyLearningDemo } from '../src/arcasha/attachments/decision-log.js';

async function main(): Promise<void> {
  const booted = (await import('../src/arcasha/ailsm/expert-runtime.js')).boot();

  console.log('='.repeat(60));
  console.log('ArcAsha v1.0 Quickstart');
  console.log('='.repeat(60));

  console.log('\n[1] Thinking Mode（Auto: タスクから自動選択）');
  console.log(renderThinking(await runThinking('この論文を批判的にレビューして', booted, { mode: 'auto' })));

  console.log('\n[2] Decision Explanation（なぜこの構成か）');
  console.log(renderExplanation(await explainExecutive('新しいアルゴリズムを考えて', booted, { mode: 'auto', budgetMs: 1000 })));

  console.log('\n[3] Executive の推論（仮説 → 採用 → 統合）');
  console.log(renderExecutive(await runExecutiveDemo()));

  console.log('\n[4] OS ポリシー学習（Decision を学習データに）');
  console.log(await runPolicyLearningDemo());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

