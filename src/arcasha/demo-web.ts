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
 */
import http from 'node:http';
import { ExpertHub } from './experts/registry.js';

const WS_PORT = Number(process.env.PORT ?? 8080);
const WEB_PORT = Number(process.env.WEB_PORT ?? 4173);

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') { const v = Number(args[++i]); if (v) WS_PORT = v; }
  if (args[i] === '--web-port') { const v = Number(args[++i]); if (v) WEB_PORT = v; }
}

const hub = new ExpertHub();
hub.start(WS_PORT, 1, () => {});

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
  <div class="sub">マスター (Mac) から マルチノード推論を操作 — iPad / iPhone の Metal で実行</div>

  <div class="card">
    <h2>接続ノード</h2>
    <div id="nodes"><div class="empty">ノード接続待ち… (端末のアプリを起動すると自動接続されます)</div></div>
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

  <div id="results"></div>
</div>

<script>
const $ = id => document.getElementById(id);
const nodesEl = $('nodes'), resultsEl = $('results'), statusEl = $('status');
const promptEl = $('prompt'), tokensEl = $('tokens'), sendBtn = $('send');

async function refreshNodes() {
  try {
    const r = await fetch('/api/nodes');
    const d = await r.json();
    if (d.nodes && d.nodes.length) {
      nodesEl.innerHTML = d.nodes.map(n =>
        '<div class="node"><span class="dot"></span><span class="id">' + esc(n.nodeId) +
        '</span><span class="meta">' + esc(n.modelId) + ' · ' + n.paramsM + 'M params</span></div>'
      ).join('');
    } else {
      nodesEl.innerHTML = '<div class="empty">ノード接続待ち…</div>';
    }
  } catch (_) {}
}

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
refreshNodes();
setInterval(refreshNodes, 3000);
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

  if (url.pathname === '/api/nodes') {
    sendJson(200, { nodes: hub.experts.map((e) => ({ nodeId: e.nodeId, modelId: e.modelId, paramsM: e.paramsM })) });
    return;
  }

  if (url.pathname === '/api/prompt' && req.method === 'POST') {
    let body = '';
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

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(WEB_PORT, () => {
  console.log('═'.repeat(60));
  console.log('  ArcAsha Web Console');
  console.log('═'.repeat(60));
  console.log(`  🟢 ExpertHub ws://0.0.0.0:${WS_PORT} (ノード接続用)`);
  console.log(`  🌐 Webダッシュボード: http://localhost:${WEB_PORT}`);
  console.log(`  📱 端末: アプリを起動すれば自動接続されます`);
  console.log('');
});
