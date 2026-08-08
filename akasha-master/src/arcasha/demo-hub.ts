#!/usr/bin/env npx tsx
/**
 * ArcAsha Demo Hub — iPad / iPhone (iOS Metal) ノードを繋いでモデル実行する
 * 対話型デモ用ハブ。
 *
 * iOS ノード (ippitsu アプリ) は WS :8080 に register してくる。
 * プロンプトを入力すると、接続中の全ノードがローカルの SmolLM2-135M
 * (Metal / llama.cpp) で並列生成し、結果とレイテンシを返す。
 *
 * 使い方:
 *   npx tsx src/arcasha/demo-hub.ts                     # 対話モード
 *   npx tsx src/arcasha/demo-hub.ts --port 9000
 *   npx tsx src/arcasha/demo-hub.ts --prompt "15% of 340?"   # ワンショット
 */
import * as readline from 'node:readline';
import { ExpertHub } from './experts/registry.js';

interface Args { port: number; prompt?: string; maxTokens: number }

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { port: 8080, maxTokens: 64 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') out.port = Number(args[++i]);
    else if (args[i] === '--prompt') out.prompt = args[++i];
    else if (args[i] === '--max-tokens') out.maxTokens = Number(args[++i]);
  }
  return out;
}

async function broadcast(hub: ExpertHub, prompt: string, maxTokens: number): Promise<void> {
  const experts = [...hub.experts];
  if (experts.length === 0) {
    console.log('\n  ⚠️  接続中のノードがありません。iPad / iPhone でアプリを起動 → モデルロード → ハブ接続してください。');
    return;
  }
  console.log(`\n  🚀 [${new Date().toISOString().substring(11, 19)}] "${prompt}"`);
  console.log(`      → ${experts.length} ノードに並列 dispatch ...\n`);
  const t0 = Date.now();
  const results = await Promise.allSettled(experts.map(async (e) => {
    const nodeT0 = Date.now();
    const text = await hub.generate(e.nodeId, prompt, maxTokens);
    return { e, text, ms: Date.now() - nodeT0 };
  }));
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { e, text, ms } = r.value;
      console.log(`  ── ${e.nodeId} (${e.modelId}, ${e.paramsM}M) — ${ms}ms`);
      console.log(`     ${text.split('\n').map(l => `     ${l}`).join('\n')}`);
      console.log('');
    } else {
      console.log(`  ❌ ${r.reason}`);
    }
  }
  console.log(`  ⏱  全体 ${Date.now() - t0}ms\n`);
}

async function main(): Promise<void> {
  const { port, prompt, maxTokens } = parseArgs();
  const hub = new ExpertHub();
  let lastCount = 0;

  hub.start(port, 1, () => {
    console.log(`  🟢 最初のエキスパート接続 (need 1+)`);
  });

  console.log('═'.repeat(64));
  console.log('  ArcAsha Demo Hub — iPad / iPhone (iOS Metal) ノード実行');
  console.log('═'.repeat(64));
  console.log(`  🟢 Hub listening ws://0.0.0.0:${port}`);
  console.log('  📱 端末側: アプリで「モデルをロード」→ ハブ URL に Mac の LAN IP を入力 → 接続');
  console.log('  ⌨️  プロンプトを入力 (Enter で全ノードに送信 / Ctrl+C で終了)\n');

  // ワンショットモード
  if (prompt) {
    await broadcast(hub, prompt, maxTokens);
    await new Promise((r) => setTimeout(r, 300));
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    const p = line.trim();
    if (!p) return;
    void broadcast(hub, p, maxTokens);
  });
  rl.on('close', () => { console.log('\n⏻ Hub stopped.'); process.exit(0); });

  // ノード接続/切断の変化を表示 + 重複 nodeId を警告
  setInterval(() => {
    if (hub.experts.length !== lastCount) {
      lastCount = hub.experts.length;
      console.log(`  📡 エキスパート ${hub.experts.length} 台: ${hub.experts.map(e => `${e.nodeId}(${e.modelId})`).join(', ')}`);
      const seen = new Map<string, number>();
      for (const e of hub.experts) seen.set(e.nodeId, (seen.get(e.nodeId) ?? 0) + 1);
      for (const [id, n] of seen) {
        if (n > 1) {
          console.log(`  ⚠️  nodeId「${id}」が ${n} 台で重複しています。アプリ側でノードIDを変更してください`);
          console.log(`     （例: iPad→node-ios-ipad, iPhone→node-ios-iphone のように端末ごとに別のIDに）`);
        }
      }
    }
  }, 500);
}

main().catch((err) => { console.error(err); process.exit(1); });
