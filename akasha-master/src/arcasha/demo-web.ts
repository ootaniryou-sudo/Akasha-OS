#!/usr/bin/env npx tsx
/**
 * ArcAsha Web Console — ブラウザからマルチノード推論を操作するWebダッシュボード。
 *
 * - ExpertHub (WS :8080) に iPad / iPhone ノードが接続
 * - HTTP :4173 でダッシュボードを配信
 * - ブラウザからプロンプトを送ると全ノードに並列 dispatch → 結果を表示
 *
 * 使い方:
 *   npx tsx src/arcasha/demo-web.ts               # WS:8080 / Web:4173
 *   npx tsx src/arcasha/demo-web.ts --port 8080 --web-port 4173
 *
 * 環境変数 / .env:
 *   DEEPSEEK_API_KEY / DEEPSEEK_API_BASE / DEEPSEEK_MODEL を設定すると
 *   DeepSeek を能力ノードとして自動接続する（ARKASHA_AUTO_API=deepseek）
 */
import 'dotenv/config';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { marked } from 'marked';
import { ExpertHub } from './experts/registry.js';
import { initAiOs, aiosExecute, aiosRelay, syncAiOs } from './ailsm/aios.js';
import { toHex } from './ailsm/compiler.js';
import { encodeProgram } from './ailsa/encoder.js';
import { runComparisonBenchmark } from './ailsm/comparison.js';
import { runScalingExperiment, renderScaling } from './ailsm/experiment.js';
import { runRealDeviceBenchmarkMeasured } from './bench/real-device.js';
import { AI_POOL, type PoolExpert } from './cognitive/pool.js';
import { composeTeam } from './cognitive/capability-graph.js';
import { runCognitive, renderCognitive } from './cognitive/runtime.js';

let WS_PORT = Number(process.env.PORT ?? 8080);
let WEB_PORT = Number(process.env.WEB_PORT ?? 4173);

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') { const v = Number(args[++i]); if (v) WS_PORT = v; }
  if (args[i] === '--web-port') { const v = Number(args[++i]); if (v) WEB_PORT = v; }
}

const hub = new ExpertHub();
hub.start(WS_PORT, 1, () => {});

// ─── Web 起動時にすぐ動く基盤: モックノード自動起動 ──────────────────
// 実機 (iPad/iPhone) が無くても Web を開いた瞬間にデバイスが繋がっている状態にする。
// --no-mock で無効化 / --mock N で台数指定。
const mockArg = args.indexOf('--mock');
let mockCount = 3;
if (mockArg >= 0) {
  const v = Number(args[mockArg + 1]);
  mockCount = Number.isFinite(v) && v >= 0 ? v : 3;
} else if (args.includes('--no-mock')) {
  mockCount = 0;
}
const AUTO_MOCK_IDS = ['mock-ios-a', 'mock-ipad-b', 'mock-iphone-c'];
for (let i = 0; i < mockCount; i++) {
  const id = AUTO_MOCK_IDS[i] ?? `mock-node-${i}`;
  hub.addMockNode(id);
}
if (mockCount > 0) console.log(`  🧪 モックノード ${mockCount} 台を自動起動（--no-mock で無効）`);

// ─── 外部 API 自動接続（.env / 環境変数）────────────────────────────
// DEEPSEEK_API_KEY が設定されていれば DeepSeek を能力ノードとして自動登録する。
// ARCASHA_AUTO_API=deepseek または DEEPSEEK_API_KEY の存在で有効化。
const autoApi = process.env.ARCASHA_AUTO_API ?? '';
const hasDeepSeekKey = !!(process.env.DEEPSEEK_API_KEY ?? '');
if (autoApi.includes('deepseek') || hasDeepSeekKey) {
  const key = process.env.DEEPSEEK_API_KEY ?? '';
  const base = process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com';
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
  const nodeId = 'api-deepseek';
  if (key || !/^https:\/\//.test(base)) { // キー必須（Ollama 等のローカルはキー不要）
    hub.addApiNode(nodeId, base, key, model);
    console.log(`  ☁️ 外部 API 自動接続: ${nodeId} (${model} @ ${base})`);
  }
}

// ノードをラウンドロビンで選択（複数端末に分散 → 役職の偏りが可視化される）
let rrCursor = 0;
function nextNodeId(): string | undefined {
  const nodes = hub.experts;
  if (nodes.length === 0) return undefined;
  const n = nodes[rrCursor % nodes.length];
  rrCursor++;
  return n.nodeId;
}

/** 決定論ハッシュ（ノード選択などで再現可能に使う） */
function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// ─── AI OS 本体（Phase 1.2: Hub が AI OS の init になる）────────────────
const aios = initAiOs({
  listNodes: () => hub.experts.map((e) => ({ nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM })),
  generate: async (nodeId, prompt, maxTokens = 64) =>
    hub.generate(nodeId, String(prompt), Number(maxTokens) || 64),
});

// ─── AI OS Monitor（Phase 2.1）────────────────────────────────────────
const recentExecs: {
  text: string;
  driverId: string | null;
  deviceId: string | null;
  ms: number;
  result: string | number | null;
  steps: string[];
  ailsaHex: string;
  ok: boolean;
}[] = [];

function pushRecent(ex: {
  text: string;
  driverId: string | null;
  deviceId: string | null;
  ms: number;
  result: string | number | null;
  steps: string[];
  ailsaHex: string;
  ok: boolean;
}): void {
  recentExecs.unshift(ex);
  if (recentExecs.length > 20) recentExecs.pop();
}

let monitorCache: { scaling: string; comparison: string } | null = null;
function monitorData(): { scaling: string; comparison: string } {
  if (!monitorCache) {
    const scaling = runScalingExperiment([100, 500, 1000]);
    const cmp = runComparisonBenchmark();
    monitorCache = {
      scaling: renderScaling(scaling),
      comparison: cmp.table,
    };
  }
  return monitorCache;
}

// ─── ダッシュボード HTML ────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>ArcAsha Web Console</title>
<style>
  :root { --bg:#0b0f14; --card:#131a22; --ink:#e6f1ea; --mute:#5e7488; --go:#2fce7a; --busy:#e0b84a; --bad:#e05a4f; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--ink); font-family:"IBM Plex Mono","SF Mono",ui-monospace,monospace; font-size:14px; min-height:100vh; }
  .wrap { max-width:860px; margin:0 auto; padding:24px 16px 60px; }
  h1 { font-size:26px; font-weight:800; letter-spacing:.04em; }
  h1 span { color:var(--go); }
  .sub { color:var(--mute); font-size:12px; margin-top:4px; }
  .card { background:var(--card); border:1px solid #1e2833; border-radius:10px; padding:16px; margin-top:16px; }
  .card h2 { font-size:13px; color:var(--mute); text-transform:uppercase; letter-spacing:.08em; margin-bottom:10px; }
  .node { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid #1a232e; }
  .node:last-child { border-bottom:none; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--go); }
  .node .id { font-weight:700; }
  .node .meta { color:var(--mute); font-size:11px; }
  .empty { color:var(--mute); font-size:12px; }
  .input-row { display:flex; gap:8px; margin-top:8px; }
  textarea {
    flex:1; background:#0e141b; border:1px solid #24313f; border-radius:8px; color:var(--ink);
    font:inherit; padding:10px 12px; resize:vertical; min-height:56px; outline:none;
  }
  textarea:focus { border-color:var(--go); }
  .tokens { width:90px; background:#0e141b; border:1px solid #24313f; border-radius:8px; color:var(--ink); font:inherit; padding:10px; text-align:center; }
  button {
    background:var(--go); color:#000; border:none; border-radius:8px; font:inherit;
    font-weight:700; padding:10px 22px; cursor:pointer; transition:opacity .1s;
  }
  button:disabled { opacity:.5; cursor:default; }
  button.secondary { background:#24313f; color:var(--ink); }
  #status { color:var(--mute); font-size:12px; margin-top:10px; min-height:18px; }
  .result { margin-top:12px; border:1px solid #1e2833; border-radius:8px; padding:12px; }
  .result .head { display:flex; justify-content:space-between; font-size:11px; color:var(--mute); margin-bottom:6px; }
  .result .head .id { color:var(--go); font-weight:700; }
  .result .text { white-space:pre-wrap; line-height:1.6; }
  .result .err { color:var(--bad); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Aka<span>sha</span> Web Console</h1>
  <div class="sub">マスター (Mac) から マルチノード推論を操作 — iPad / iPhone の Metal で実行 · <a href="/monitor" style="color:var(--go)">AI OS Monitor ↗</a></div>

  <div class="card">
    <h2>接続ノード</h2>
    <div id="nodes"><div class="empty">ノード接続待ち… (端末のアプリを起動すると自動接続されます)</div></div>
  </div>

  <div class="card">
    <h2>デバイス接続（基盤）</h2>
    <div class="input-row" style="flex-wrap:wrap">
      <button id="add-mock" class="secondary" style="flex:1;min-width:120px">+ モックノード追加</button>
      <input id="http-url" type="text" placeholder="HTTPデバイス URL (例: http://192.168.1.10:8080)" style="flex:2;min-width:220px;background:#0e141b;border:1px solid #24313f;border-radius:8px;color:var(--ink);font:inherit;padding:10px 12px;outline:none" />
      <button id="add-http" class="secondary" style="flex:1;min-width:120px">+ HTTP接続</button>
    </div>
    <div class="input-row" style="flex-wrap:wrap;margin-top:8px">
      <input id="api-url" type="text" placeholder="外部API base URL (例: https://api.openai.com / http://localhost:11434/v1)" style="flex:2;min-width:200px;background:#0e141b;border:1px solid #24313f;border-radius:8px;color:var(--ink);font:inherit;padding:10px 12px;outline:none" />
      <input id="api-key" type="password" placeholder="API Key（ローカルのみ・保存しない）" style="flex:1;min-width:140px;background:#0e141b;border:1px solid #24313f;border-radius:8px;color:var(--ink);font:inherit;padding:10px 12px;outline:none" />
      <input id="api-model" type="text" placeholder="model (gpt-4o-mini)" style="flex:1;min-width:120px;background:#0e141b;border:1px solid #24313f;border-radius:8px;color:var(--ink);font:inherit;padding:10px 12px;outline:none" />
      <button id="add-api" class="secondary" style="flex:1;min-width:120px">+ API接続</button>
    </div>
    <div id="device-status" style="color:var(--mute);font-size:12px;margin-top:8px;min-height:16px"></div>
    <div class="sub" style="margin-top:6px">実機 (iPad/iPhone) はアプリ起動で自動接続 / モックは Web 起動時に 3 台自動起動（--no-mock で無効）/ 外部 API は OpenAI 互換（API Key はブラウザ内のみ・保存しない）</div>
  </div>

  <div class="card">
    <h2>システム情報 (内部設定)</h2>
    <div id="sysinfo"><div class="empty">—</div></div>
  </div>

  <div class="card">
    <h2>プロンプト送信</h2>
    <div class="input-row">
      <textarea id="prompt" placeholder="例: Explain in one sentence: what is a distributed expert system?"></textarea>
      <input class="tokens" id="tokens" type="number" value="64" min="8" max="512" title="最大トークン数" />
      <button id="send">送信</button>
      <button id="clear" class="secondary">クリア</button>
    </div>
    <div id="status"></div>
  </div>

  <div class="card">
    <h2>AI OS — AILSA 実行（Compile → CALL → 実デバイス → ODAR 学習）</h2>
    <div class="input-row">
      <textarea id="ailsm-prompt" placeholder="例: x^2を積分して / 2と3を足して / Webで記事を検索して"></textarea>
      <button id="ailsm-run">実行</button>
    </div>
    <div id="ailsm-status" style="color:var(--mute);font-size:12px;margin-top:8px;min-height:16px"></div>
    <pre id="ailsm-out" style="white-space:pre-wrap;background:#0e141b;border:1px solid #1e2833;border-radius:8px;padding:12px;margin-top:8px;display:none;font-size:12px;line-height:1.5"></pre>
  </div>

  <div id="results"></div>
</div>

<script>
const $ = id => document.getElementById(id);
const nodesEl = $('nodes'), resultsEl = $('results'), statusEl = $('status');
const sysinfoEl = $('sysinfo');
const promptEl = $('prompt'), tokensEl = $('tokens'), sendBtn = $('send');

async function refreshInfo() {
  try {
    const r = await fetch('/api/info');
    const d = await r.json();
    if (!d.nodes || !d.nodes.length) {
      sysinfoEl.innerHTML = '<div class="empty">ノード未接続</div>';
      return;
    }
    sysinfoEl.innerHTML = d.nodes.map(n => {
      const det = n.details || {};
      const s = det.settings || {};
      const caps = det.capabilities ? JSON.stringify(det.capabilities) : '-';
      return '<div class="node" style="align-items:flex-start;flex-direction:column;padding:8px 0">' +
        '<div><span class="id">' + esc(n.nodeId) + '</span> <span class="meta">' + esc(n.modelId) + ' · ' + n.paramsM + 'M</span></div>' +
        '<div class="meta">platform: ' + esc(det.platform || '-') + ' / backend: ' + esc(det.backend || '-') + ' / precision: ' + esc(det.precision || '-') + ' / device: ' + esc(det.device || '-') + '</div>' +
        '<div class="meta">settings: n_ctx=' + (s.n_ctx ?? '-') + ' n_batch=' + (s.n_batch ?? '-') + ' n_threads=' + (s.n_threads ?? '-') + ' gpu_layers=' + (s.gpu_layers ?? '-') + ' temperature=' + (s.temperature ?? '-') + '</div>' +
        '<div class="meta">capabilities: ' + esc(caps) + '</div>' +
        '</div>';
    }).join('');
  } catch (_) {}
}

async function refreshNodes() {
  try {
    const r = await fetch('/api/nodes');
    const d = await r.json();
    if (d.nodes && d.nodes.length) {
      nodesEl.innerHTML = d.nodes.map(n =>
        '<div class="node"><span class="dot"></span><span class="id">' + esc(n.nodeId) +
        '</span><span class="meta">' + esc(n.modelId) + ' · ' + n.paramsM + 'M params</span>' +
        '<button class="secondary" style="margin-left:auto;padding:4px 10px;font-size:11px" data-disconnect="' + esc(n.nodeId) + '">切断</button></div>'
      ).join('');
      // 切断ボタン
      nodesEl.querySelectorAll('[data-disconnect]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-disconnect');
          await fetch('/api/node/' + encodeURIComponent(id) + '/disconnect', { method: 'POST' });
          refreshNodes(); refreshInfo();
        });
      });
    } else {
      nodesEl.innerHTML = '<div class="empty">ノード接続待ち…</div>';
    }
  } catch (_) {}
}

// ─── デバイス接続（基盤）─────────────────────────────────────────────
const deviceStatusEl = $('device-status');
const httpUrlEl = $('http-url');
async function deviceStatus(msg) {
  deviceStatusEl.textContent = msg;
}
$('add-mock').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/device/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'mock' }),
    });
    const d = await r.json();
    deviceStatus(d.ok ? '✅ モックノード ' + d.nodeId + ' を追加しました' : '❌ ' + (d.error || '追加失敗'));
    refreshNodes(); refreshInfo();
  } catch (e) { deviceStatus('❌ ' + e); }
});
$('add-http').addEventListener('click', async () => {
  const url = httpUrlEl.value.trim();
  if (!url) { deviceStatus('⚠️ HTTP デバイスの URL を入力してください'); return; }
  try {
    const r = await fetch('/api/device/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'http', url }),
    });
    const d = await r.json();
    deviceStatus(d.ok ? '✅ HTTP デバイス ' + d.nodeId + ' を接続しました (' + d.url + ')' : '❌ ' + (d.error || '接続失敗'));
    if (d.ok) httpUrlEl.value = '';
    refreshNodes(); refreshInfo();
  } catch (e) { deviceStatus('❌ ' + e); }
});
httpUrlEl.addEventListener('keydown', e => { if (e.key === 'Enter') $('add-http').click(); });

// ─── 外部 API 接続（OpenAI 互換）───────────────────────────────────
const apiUrlEl = $('api-url');
const apiKeyEl = $('api-key');
const apiModelEl = $('api-model');
$('add-api').addEventListener('click', async () => {
  const url = apiUrlEl.value.trim();
  if (!url) { deviceStatus('⚠️ 外部 API の base URL を入力してください'); return; }
  const apiKey = apiKeyEl.value.trim();
  const model = apiModelEl.value.trim() || 'gpt-4o-mini';
  try {
    const r = await fetch('/api/device/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'api', url, apiKey, model }),
    });
    const d = await r.json();
    deviceStatus(d.ok
      ? '✅ 外部 API ' + d.nodeId + ' を接続しました (' + d.model + ' @ ' + d.url + (d.hasApiKey ? ' / keyあり' : ' / keyなし') + ')'
      : '❌ ' + (d.error || '接続失敗'));
    if (d.ok) { apiUrlEl.value = ''; apiKeyEl.value = ''; }
    refreshNodes(); refreshInfo();
  } catch (e) { deviceStatus('❌ ' + e); }
});
apiUrlEl.addEventListener('keydown', e => { if (e.key === 'Enter') $('add-api').click(); });

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function send() {
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  const maxTokens = parseInt(tokensEl.value || '64', 10);
  sendBtn.disabled = true;
  statusEl.textContent = '⏳ ' + prompt + '  → ノードへ並列 dispatch ...';
  try {
    const r = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, maxTokens }),
    });
    const d = await r.json();
    if (d.error) { statusEl.textContent = '❌ ' + d.error; return; }
    statusEl.textContent = '✅ ' + new Date().toLocaleTimeString() + ' — ' + d.results.length + ' ノード応答 (' + d.totalMs + 'ms)';
    const cards = d.results.map(res => {
      if (res.error) return '<div class="result"><div class="head"><span class="id">' + esc(res.nodeId) + '</span></div><div class="text err">❌ ' + esc(res.error) + '</div></div>';
      return '<div class="result"><div class="head"><span class="id">' + esc(res.nodeId) +
        '</span><span>' + esc(res.modelId) + ' · ' + res.ms + 'ms</span></div>' +
        '<div class="text">' + esc(res.text) + '</div></div>';
    }).join('');
    resultsEl.innerHTML = '<div class="card" style="margin-top:16px"><h2>プロンプト: ' + esc(d.prompt) + '</h2></div>' + cards + resultsEl.innerHTML;
    refreshNodes();
  } catch (e) {
    statusEl.textContent = '❌ ' + e;
  } finally {
    sendBtn.disabled = false;
  }
}

$('send').addEventListener('click', send);
$('clear').addEventListener('click', () => { resultsEl.innerHTML = ''; statusEl.textContent = ''; });
promptEl.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });

// ─── AI OS (AILSA) 実行 ────────────────────────────────────────────────
const ailsmPromptEl = $('ailsm-prompt');
const ailsmStatusEl = $('ailsm-status');
const ailsmOutEl = $('ailsm-out');
$('ailsm-run').addEventListener('click', async () => {
  const text = ailsmPromptEl.value.trim();
  if (!text) return;
  ailsmStatusEl.textContent = '⏳ Compile → CALL → 実デバイス委譲 ...';
  try {
    const r = await fetch('/api/ailsm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const d = await r.json();
    if (d.error) { ailsmStatusEl.textContent = '❌ ' + d.error; return; }
    ailsmStatusEl.textContent = '✅ ' + (d.fallback ? 'Stage-2委譲: ' : '') + (d.driverId ? 'CALL ' + d.driverId + ' → ' + d.deviceId + ' (' + d.ms + 'ms)' : 'ローカル解決') + ' / ODAR学習: ' + (d.learned ? '記録済み' : '-');
    ailsmOutEl.style.display = 'block';
    ailsmOutEl.textContent =
      'result : ' + d.result + '\\n' +
      (d.fallback ? 'stage  : Stage-2 フォールバック（決定論→実機LLM）\\n' : '') +
      'driver : ' + (d.driverId ?? 'local') + '\\n' +
      'device : ' + (d.deviceId ?? 'local') + '\\n' +
      'steps  : ' + d.steps.join(' → ') + '\\n' +
      'AILSA  : ' + d.ailsaHex;
    refreshNodes();
  } catch (e) {
    ailsmStatusEl.textContent = '❌ ' + e;
  }
});
ailsmPromptEl.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('ailsm-run').click(); });
refreshNodes();
refreshInfo();
setInterval(refreshNodes, 3000);
setInterval(refreshInfo, 3000);
</script>
</body>
</html>`;

// ─── HTTP サーバ ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${WEB_PORT}`);
  const sendJson = (code: number, obj: unknown) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url.pathname === '/monitor' || url.pathname === '/monitor.html') {
    try {
      const m = readFileSync(new URL('../../public/aios-monitor.html', import.meta.url), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(m);
    } catch {
      sendJson(404, { error: 'monitor not found' });
    }
    return;
  }

  // ─── DEV_MASTER_SPEC.md ビューア（個人用マークダウンをブラウザで見やすく表示）──
  if (url.pathname === '/dev-master-spec' || url.pathname === '/dev-master-spec.html') {
    try {
      const md = readFileSync(new URL('../../../DEV_MASTER_SPEC.md', import.meta.url), 'utf-8');
      const body = marked.parse(md, { gfm: true, breaks: true });
      const page = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DEV_MASTER_SPEC.md — ArcAsha 開発者マスター仕様書</title>
<style>
  :root {
    --bg:#0b0f14; --card:#131a22; --ink:#e6f1ea; --mute:#8aa2b5;
    --accent:#2fce7a; --accent2:#e0b84a; --line:#1e2833;
    --code-bg:#0d1420; --pre-bg:#0a1018;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;
    line-height:1.75; font-size:15px;
  }
  .wrap { max-width:960px; margin:0 auto; padding:40px 24px 120px; }
  .topbar {
    position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:12px;
    padding:12px 24px; background:rgba(11,15,20,.92); backdrop-filter:blur(8px);
    border-bottom:1px solid var(--line);
  }
  .topbar .logo { font-weight:800; color:var(--accent); letter-spacing:.04em; }
  .topbar .path { color:var(--mute); font-size:12px; font-family:ui-monospace,Menlo,monospace; }
  .topbar a { color:var(--accent2); text-decoration:none; font-size:13px; margin-left:auto; }
  h1, h2, h3, h4 { color:#fff; line-height:1.4; margin-top:1.8em; }
  h1 { font-size:1.9em; border-bottom:2px solid var(--line); padding-bottom:.35em; }
  h2 { font-size:1.45em; border-bottom:1px solid var(--line); padding-bottom:.3em; }
  h3 { font-size:1.2em; }
  a { color:var(--accent); }
  p, li { color:var(--ink); }
  li { margin:.25em 0; }
  code {
    background:var(--code-bg); color:#7ee2a8; padding:2px 6px; border-radius:4px;
    font-family:ui-monospace,Menlo,Consolas,monospace; font-size:.88em;
  }
  pre {
    background:var(--pre-bg); border:1px solid var(--line); border-radius:8px;
    padding:16px; overflow-x:auto; line-height:1.5;
  }
  pre code { background:none; padding:0; color:#c9e6d6; font-size:.85em; }
  table {
    border-collapse:collapse; width:100%; margin:1.2em 0; font-size:.9em;
    display:block; overflow-x:auto;
  }
  th, td { border:1px solid var(--line); padding:8px 12px; text-align:left; }
  th { background:var(--card); color:#fff; font-weight:700; }
  tr:nth-child(even) td { background:rgba(19,26,34,.4); }
  blockquote {
    margin:1.2em 0; padding:.6em 1.1em; border-left:4px solid var(--accent);
    background:rgba(47,206,122,.06); border-radius:0 6px 6px 0; color:#cfe9da;
  }
  blockquote p { color:#cfe9da; }
  hr { border:none; border-top:1px solid var(--line); margin:2.5em 0; }
  .tag { display:inline-block; padding:2px 10px; border-radius:20px; font-size:12px;
         background:rgba(47,206,122,.12); color:var(--accent); border:1px solid rgba(47,206,122,.3); }
  .mermaid { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin:1.2em 0; }
  .toc { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px 24px; }
  .toc a { color:var(--mute); text-decoration:none; }
  .toc a:hover { color:var(--accent); }
  ::-webkit-scrollbar { height:8px; width:8px; }
  ::-webkit-scrollbar-thumb { background:var(--line); border-radius:4px; }
</style>
</head>
<body>
<div class="topbar">
  <span class="logo">ArcAsha</span>
  <span class="path">DEV_MASTER_SPEC.md（個人用・公開対象外）</span>
  <a href="/monitor">→ AI OS Monitor</a>
</div>
<div class="wrap" id="content">${body}</div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad:false, theme:'dark' });
    document.querySelectorAll('pre code.language-mermaid').forEach((el) => {
      const pre = el.parentElement;
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = el.textContent;
      pre.replaceWith(div);
    });
    mermaid.run({ nodes: document.querySelectorAll('.mermaid') }).catch(() => {});
  }
</script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
    } catch (e) {
      sendJson(404, { error: 'DEV_MASTER_SPEC.md not found: ' + String(e) });
    }
    return;
  }

  if (url.pathname === '/api/nodes') {
    sendJson(200, { nodes: hub.experts.map((e) => ({ nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM })) });
    return;
  }

  if (url.pathname === '/api/info') {
    sendJson(200, {
      wsPort: WS_PORT,
      webPort: WEB_PORT,
      nodes: hub.experts.map((e) => ({
        nodeId: e.nodeId,
        modelId: e.modelId,
        paramsM: e.paramsM,
        details: hub.nodeDetails.get(e.nodeId) ?? {},
      })),
    });
    return;
  }

  if (url.pathname === '/api/prompt' && req.method === 'POST') {    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { prompt, maxTokens } = JSON.parse(body);
        if (!prompt) { sendJson(400, { error: 'prompt required' }); return; }
        const experts = [...hub.experts];
        if (experts.length === 0) { sendJson(503, { error: 'ノードが接続されていません' }); return; }
        const t0 = Date.now();
        const results = await Promise.allSettled(experts.map(async (e) => {
          const t1 = Date.now();
          const text = await hub.generate(e.nodeId, String(prompt), Number(maxTokens) || 64);
          return { nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM, text, ms: Date.now() - t1 };
        }));
        sendJson(200, {
          prompt: String(prompt),
          totalMs: Date.now() - t0,
          results: results.map((r) => r.status === 'fulfilled' ? r.value : { nodeId: '?', error: String(r.reason) }),
        });
      } catch (e) {
        sendJson(400, { error: String(e) });
      }
    });
    return;
  }

  // ─── デバイス接続 API（Web からデバイスを追加・切断する基盤）──────
  if (url.pathname === '/api/device/connect' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { type?: string; nodeId?: string; url?: string; modelId?: string; apiKey?: string; model?: string };
        const { type, nodeId, url: baseUrl, modelId } = parsed;
        if (type === 'mock') {
          const id = nodeId && String(nodeId).trim() ? String(nodeId).trim() : `mock-${Date.now() % 10000}`;
          const ok = hub.addMockNode(id, modelId ? String(modelId) : undefined);
          sendJson(ok ? 200 : 409, ok ? { ok, nodeId: id, type: 'mock' } : { ok: false, error: `node ${id} already exists` });
        } else if (type === 'http') {
          const id = nodeId && String(nodeId).trim() ? String(nodeId).trim() : `http-${Date.now() % 10000}`;
          if (!baseUrl || !String(baseUrl).trim()) { sendJson(400, { ok: false, error: 'url required for http device' }); return; }
          const ok = hub.addHttpNode(id, String(baseUrl).trim(), modelId ? String(modelId) : undefined);
          sendJson(ok ? 200 : 409, ok ? { ok, nodeId: id, type: 'http', url: String(baseUrl).trim() } : { ok: false, error: `node ${id} already exists` });
        } else if (type === 'api') {
          // 外部 API（OpenAI 互換・API キー認証）を Expert として登録
          const id = nodeId && String(nodeId).trim() ? String(nodeId).trim() : `api-${Date.now() % 10000}`;
          if (!baseUrl || !String(baseUrl).trim()) { sendJson(400, { ok: false, error: 'url required for api node' }); return; }
          const apiKey = (parsed.apiKey as string) ?? '';
          const model = (parsed.model as string) || 'gpt-4o-mini';
          const ok = hub.addApiNode(id, String(baseUrl).trim(), apiKey, model);
          sendJson(ok ? 200 : 409, ok
            ? { ok, nodeId: id, type: 'api', url: String(baseUrl).trim(), model, hasApiKey: apiKey.length > 0 }
            : { ok: false, error: `node ${id} already exists` });
        } else {
          sendJson(400, { ok: false, error: 'type must be "mock", "http" or "api"' });
        }
      } catch (e) {
        sendJson(400, { ok: false, error: String(e) });
      }
    });
    return;
  }

  // ─── Real Device Benchmark API（接続中の実機で実際に計測）─────────
  if (url.pathname === '/api/real-benchmark' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        // 実機ノードのみ（mock / http は実機 LLM ではないので除外）
        const realNodes = hub.experts.filter((e) => !hub.mockNodes.has(e.nodeId) && !hub.httpNodes.has(e.nodeId));
        if (realNodes.length === 0) {
          sendJson(200, { status: 'not-connected', devices: [], rows: [], note: '実機（WS 接続の iPad/iPhone）が接続されていません。モック / HTTP デバイスは実機計測の対象外です。' });
          return;
        }
        const r = await runRealDeviceBenchmarkMeasured({
          devices: realNodes.map((e) => e.nodeId),
          generate: async (nodeId, prompt, maxTokens = 64) => {
            const t0 = Date.now();
            const text = await hub.generate(nodeId, String(prompt), Number(maxTokens) || 64);
            const ms = Date.now() - t0;
            return { text, ms, tokens: text.length };
          },
          getMetric: (nodeId) => {
            const m = hub.nodeMetrics.get(nodeId);
            if (!m) return undefined;
            return { batteryPct: m.batteryPct, rttMs: m.rttMs, powerMw: m.powerMw, source: m.source };
          },
        });
        sendJson(200, r);
      } catch (e) {
        sendJson(400, { ok: false, error: String(e) });
      }
    });
    return;
  }

  // ─── Cognitive Graph API（実モデル接続 / シミュレーション）────────
  if (url.pathname === '/api/cognitive' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        if (!text) { sendJson(400, { ok: false, error: 'text required' }); return; }

        // 実モデルノード（WS 実機 + HTTP デバイス）。モックのみ除外。
        // →「Expert = 必ずしもローカル LLM ではない」（API / 実機 / クラウドも能力ノード）
        const realNodes = hub.experts.filter((e) => !hub.mockNodes.has(e.nodeId));
        const usedReal = realNodes.length > 0;

        // AI Pool の各 Expert に「実モデル実行」を注入する
        // （実機/API があれば hub.generate で実行、無ければ execute なし = 決定論 genIr シミュレーション）
        const pool: PoolExpert[] = AI_POOL.map((e) => {
          if (!usedReal) return e;
          const nodeId = realNodes[Math.floor(Math.abs(hashOf(e.id + text)) % realNodes.length)].nodeId;
          return {
            ...e,
            execute: async ({ task, input }) => {
              const t0 = Date.now();
              // 実モデルへ: その Expert の役割と入力を自然言語プロンプトに載せて生成させる
              const prompt = `[${e.role} expert] 入力: ${input?.value ?? '(なし)'} / タスク: ${task} → 出力（${e.outputType} として 1 行で）:`;
              const out = await hub.generate(nodeId, prompt, 48);
              const ms = Date.now() - t0;
              return { ir: `${e.outputType}: ${out.trim().slice(0, 120)}`, ms, ok: out.trim().length > 0 };
            },
          };
        });

        const team = composeTeam(pool, String(text));
        const r = await runCognitive(team, String(text));
        sendJson(200, {
          ok: true,
          usedReal, // true = 実モデル接続 / false = 決定論シミュレーション
          deviceIds: usedReal ? realNodes.map((n) => n.nodeId) : [],
          result: r,
          text: renderCognitive(r),
        });
      } catch (e) {
        sendJson(400, { ok: false, error: String(e) });
      }
    });
    return;
  }

  // ─── 端末操作 API（モニターの接続端末操作）────────────────────────
  const nodeMatch = url.pathname.match(/^\/api\/node\/([^/]+)\/disconnect$/);
  if (nodeMatch && req.method === 'POST') {
    const ok = hub.disconnect(decodeURIComponent(nodeMatch[1]));
    sendJson(200, { ok, nodeId: decodeURIComponent(nodeMatch[1]) });
    return;
  }

  // ─── デバイス間ピア会話 API（ニューロンネットワーク風）────────────
  if (url.pathname === '/api/peer' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const { from, to, text } = JSON.parse(body);
        if (!from || !to || !text) { sendJson(400, { error: 'from/to/text required' }); return; }
        const msg = hub.peerMessage(String(from), String(to), String(text));
        sendJson(200, msg);
      } catch (e) {
        sendJson(400, { error: String(e) });
      }
    });
    return;
  }

  // ─── AI OS Monitor API（Phase 2.1）────────────────────────────────
  if (url.pathname === '/api/monitor') {
    syncAiOs(aios);
    sendJson(200, {
      devices: aios.client.listNodes(),
      learner: aios.learner.all(),
      recent: recentExecs,
      scaling: monitorData().scaling,
      comparison: monitorData().comparison,
      nodes: hub.metrics(),
      roles: aios.learner.all(),
      tree: hub.tree(),
      peerLog: hub.peerLog,
    });
    return;
  }

  // ─── AI OS API（Phase 1.2）─────────────────────────────────────────
  if (url.pathname === '/api/device-tree') {
    syncAiOs(aios); // 接続済み実機を DeviceTree / RemoteDriver へ遅延登録
    const tree = aios.booted.deviceTree.describe();
    sendJson(200, {
      tree,
      nodes: aios.client.listNodes(),
      learner: aios.learner.all(),
    });
    return;
  }

  if (url.pathname === '/api/ailsm' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { text, deviceId } = JSON.parse(body);
        if (!text) { sendJson(400, { error: 'text required' }); return; }
        const targetId = deviceId ? String(deviceId) : nextNodeId();
        const ex = await aiosExecute(aios, String(text), targetId);
        pushRecent({
          text: String(text),
          driverId: ex.driverId,
          deviceId: ex.deviceId,
          ms: ex.ms,
          result: ex.result,
          steps: ex.trace.steps.map((s) => s.kind),
          ailsaHex: toHex(encodeProgram(ex.compile.instructions)),
          ok: ex.driverResponse?.ok ?? false,
        });
        sendJson(200, {
          text: String(text),
          result: ex.result,
          driverId: ex.driverId,
          deviceId: ex.deviceId,
          ms: ex.ms,
          learned: ex.learned,
          fallback: ex.fallback ?? false,
          ailsaHex: toHex(encodeProgram(ex.compile.instructions)),
          steps: ex.trace.steps.map((s) => s.kind),
          learner: aios.learner.all(),
        });
      } catch (e) {
        sendJson(400, { error: String(e) });
      }
    });
    return;
  }

  if (url.pathname === '/api/relay' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { steps, deviceId } = JSON.parse(body);
        if (!Array.isArray(steps) || steps.length === 0) { sendJson(400, { error: 'steps required' }); return; }
        const relay = await aiosRelay(aios, steps, deviceId ? String(deviceId) : undefined);
        sendJson(200, {
          final: relay.final,
          hops: relay.hops.map((h) => ({
            index: h.index,
            expert: h.expert,
            ok: h.ok,
            ms: h.ms,
            driverId: h.driverId,
            input: h.input.slice(0, 80),
            output: String(h.output ?? '').slice(0, 80),
            ailsaHex: h.ailsaHex.slice(0, 80),
          })),
          ailsaMessages: relay.ailsaMessages,
        });
      } catch (e) {
        sendJson(400, { error: String(e) });
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});
server.listen(WEB_PORT, () => {
  console.log('═'.repeat(60));
  console.log('  ArcAsha Web Console');
  console.log('═'.repeat(60));
  console.log(`  🟢 ExpertHub ws://0.0.0.0:${WS_PORT} (ノード接続用)`);
  console.log(`  🌐 Webダッシュボード: http://localhost:${WEB_PORT}`);
  console.log(`  📱 端末: アプリを起動すれば自動接続されます (mDNS自動発見対応)`);
  console.log('');

  // mDNS (Bonjour) でハブを広告 → 端末アプリが自動発見できるようにする
  // macOS 標準の dns-sd を使用: dns-sd -R <Name> <Type> <Domain> <Port>
  const adv = spawn('dns-sd', ['-R', 'ArcAsha Hub', '_arcasha._tcp', 'local', String(WS_PORT)], { stdio: 'ignore' });
  adv.on('error', () => console.log('  ⚠️ dns-sd が使えないため mDNS 広告をスキップ'));
  adv.on('exit', () => { /* 広告プロセス終了 (無視) */ });
});
