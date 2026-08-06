#!/usr/bin/env node
/**
 * ArcAsha CLI（v1.0）— `arcasha` コマンド
 *
 *   npm install arcasha → `arcasha benchmark` が動く（package.json の bin）。
 *   - benchmark : Real Benchmark Suite（Simulation）+ Decision Explanation + Real Device + reports/ 生成
 *   - policy    : OS ポリシー学習デモ（Decision Explanation を学習データにする）
 *   - hierarchy : Hierarchy Runtime デモ（Master → Caravan → Device → Expert が考える→判断→命令→学習）
 *   - version   : version 表示
 *   - help      : ヘルプ
 */

export const ARCASHA_VERSION = '1.0.0';

export async function runCli(argv: string[]): Promise<string> {
  const cmd = argv[0] ?? 'help';
  switch (cmd) {
    case 'benchmark': {
      const { main } = await import('./bench/cli.js');
      await main(argv[1]);
      return `arcasha benchmark: done（reports/benchmark/ に kind=simulation の report.json/csv/md を生成）`;
    }
    case 'policy': {
      const { runPolicyLearningDemo } = await import('./attachments/decision-log.js');
      return runPolicyLearningDemo();
    }
    case 'replay': {
      const { captureReplay, renderReplay, runReplayDemo } = await import('./attachments/replay.js');
      if (argv[1]) {
        const booted = (await import('./ailsm/expert-runtime.js')).boot();
        const t = await captureReplay(argv[1], booted, { mode: 'auto', budgetMs: 1000 });
        return renderReplay(t);
      }
      return runReplayDemo();
    }
    case 'hierarchy': {
      const { runHierarchyDemoCli } = await import('./hierarchy/hierarchy-runtime.js');
      await runHierarchyDemoCli();
      return 'arcasha hierarchy: done';
    }
    case 'version':
      return `ArcAsha v${ARCASHA_VERSION}`;
    case 'help':
    default:
      return [
        `ArcAsha v${ARCASHA_VERSION} — AI Operating System for Modular Reasoning and Runtime Intelligence`,
        '',
        'Usage: arcasha <command>',
        '  benchmark   Real Benchmark Suite（Simulation）+ Decision Explanation + Real Device + reports/ 生成',
        '  replay      Decision Replay（なぜこの回答になったのかをステップ再生。引数でタスク指定可）',
        '  policy      OS ポリシー学習デモ（Decision Explanation を学習データにして Meta Executive のポリシーを更新）',
        '  hierarchy   Hierarchy Runtime デモ（Master → Caravan → Device → Expert の階層が自律判断）',
        '  version     version 表示',
        '  help        このヘルプ',
      ].join('\n');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2))
    .then((s) => console.log(s))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
