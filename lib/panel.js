// dsh-quorum / panel.js —— 本机控制面板（127.0.0.1 上的单页应用）
//
// 设计约束：
//   - 只监听 127.0.0.1，不对外；写操作要带一次性 token（防本机其它页面 CSRF 式调用）。
//   - 零依赖：一个 node:http、一段内联 HTML/JS，不引入前端构建链。
//   - 面板只读「会话内运行记录」，不读会话文件、不碰 transcript（全文在 $DSH_HOME/quorum/runs/）。

import http from 'node:http';
import crypto from 'node:crypto';

const MAX_BODY = 64 * 1024;

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-quorum 控制面板</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.55 ui-sans-serif,system-ui,"Segoe UI",sans-serif; background:#0d1117; color:#e6edf3; }
  header { display:flex; align-items:baseline; gap:12px; padding:14px 20px; border-bottom:1px solid #21262d; }
  header h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.3px; }
  header .muted { color:#7d8590; font-size:12px; }
  main { display:grid; grid-template-columns: 340px 1fr; gap:16px; padding:16px 20px; align-items:start; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  section { background:#11161d; border:1px solid #21262d; border-radius:8px; padding:14px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#8b949e; margin:0 0 10px; }
  textarea, input, select { width:100%; background:#0d1117; color:#e6edf3; border:1px solid #30363d; border-radius:6px; padding:8px; font:inherit; }
  textarea { min-height:96px; resize:vertical; }
  label { display:block; font-size:12px; color:#8b949e; margin:10px 0 4px; }
  button { background:#238636; color:#fff; border:0; border-radius:6px; padding:8px 14px; font:inherit; cursor:pointer; }
  button:disabled { background:#21262d; color:#7d8590; cursor:default; }
  button.ghost { background:#21262d; color:#c9d1d9; }
  .row { display:flex; gap:8px; margin-top:12px; }
  .run { padding:8px 0; border-bottom:1px solid #1b2028; cursor:pointer; }
  .run:last-child { border-bottom:0; }
  .run:hover { background:#151b23; }
  .run .meta { display:flex; justify-content:space-between; gap:8px; font-size:12px; color:#8b949e; }
  .run .title { font-size:13px; margin:2px 0 6px; color:#c9d1d9; }
  .bars { display:flex; height:6px; border-radius:3px; overflow:hidden; background:#21262d; }
  .bars i { display:block; height:100%; }
  .b0 { background:#2f81f7; } .b1 { background:#f78166; } .b2 { background:#3fb950; }
  pre { white-space:pre-wrap; word-break:break-word; background:#0b0f14; border:1px solid #21262d; border-radius:6px; padding:12px; max-height:52vh; overflow:auto; font:12px/1.6 ui-monospace,Consolas,monospace; }
  .pill { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11px; border:1px solid #30363d; color:#8b949e; }
  .ok { color:#3fb950; } .warn { color:#d29922; } .bad { color:#f85149; }
  .empty { color:#7d8590; font-size:13px; padding:12px 0; }
</style>
</head>
<body>
<header>
  <h1>dsh-quorum</h1>
  <span class="muted" id="subtitle">控制面板</span>
  <span style="margin-left:auto" class="muted" id="clock"></span>
</header>
<main>
  <section>
    <h2>开一场评审</h2>
    <label for="req">需求</label>
    <textarea id="req" placeholder="例：给插件加一个导出 PDF 的能力，两周内可交付"></textarea>
    <label for="scenario">mock 剧本（未配置模型时生效）</label>
    <select id="scenario">
      <option value="auto">auto</option>
      <option value="converge-r2">converge-r2（第 2 轮共识）</option>
      <option value="converge-r3">converge-r3（第 3 轮共识）</option>
      <option value="never">never（跑满 3 轮）</option>
      <option value="water">water（水字数掉权）</option>
      <option value="overbudget">overbudget（超预算驳回）</option>
    </select>
    <label for="rounds">轮次上限</label>
    <select id="rounds"><option>3</option><option>2</option><option>1</option></select>
    <div class="row">
      <button id="go">开一场</button>
      <button class="ghost" id="refresh">刷新</button>
    </div>
    <div class="muted" id="status" style="margin-top:10px;min-height:18px"></div>
  </section>

  <section>
    <h2>最近运行</h2>
    <div id="runs"><div class="empty">还没有运行记录</div></div>
  </section>
</main>
<main style="grid-template-columns:1fr;padding-top:0">
  <section>
    <h2 id="reportTitle">报告</h2>
    <pre id="report">选一条运行记录查看 Markdown 摘要。</pre>
  </section>
</main>
<script>
const TOKEN = "__TOKEN__";
const state = { runs: [], selected: null };
const $ = (id) => document.getElementById(id);

function esc(s) { return String(s == null ? '' : s); }

function pct(v) { return Math.round((Number(v) || 0) * 100) + '%'; }

function renderRuns() {
  const box = $('runs');
  if (!state.runs.length) { box.innerHTML = '<div class="empty">还没有运行记录</div>'; return; }
  box.innerHTML = '';
  for (const run of state.runs) {
    const div = document.createElement('div');
    div.className = 'run';
    const q = Number(run.quality || 0);
    const tone = q >= 7 ? 'ok' : q >= 5 ? 'warn' : 'bad';
    const w = run.weights || {};
    const ids = Object.keys(w);
    const bars = ids.map((id, i) =>
      '<i class="b' + (i % 3) + '" style="width:' + pct(w[id]) + '" title="' + esc(id) + ' ' + pct(w[id]) + '"></i>'
    ).join('');
    div.innerHTML =
      '<div class="meta"><span>' + esc(run.timeLabel) + '</span>' +
      '<span>' + esc(run.rounds) + ' 轮 · ' + esc(run.stopLabel) + '</span></div>' +
      '<div class="title">' + esc(run.requirement) + '</div>' +
      '<div class="meta"><span class="' + tone + '">质量 ' + q.toFixed(1) + '</span><span>' +
      esc(run.provider) + ' · ' + esc(run.tokensSpent) + ' token</span></div>' +
      '<div class="bars" style="margin-top:6px">' + bars + '</div>';
    div.onclick = () => { state.selected = run.runId; renderReport(); };
    box.appendChild(div);
  }
}

function renderReport() {
  const run = state.runs.find((r) => r.runId === state.selected) || state.runs[0];
  if (!run) return;
  $('reportTitle').textContent = '报告 · ' + run.requirement;
  $('report').textContent = run.markdown || '（这次运行没有留下摘要）';
}

async function load() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    const data = await res.json();
    state.runs = data.runs || [];
    $('subtitle').textContent = '控制面板 · v' + data.version + ' · ' + data.provider + ' · 沙箱 ' + data.sandboxCount + ' 场';
    $('clock').textContent = new Date().toLocaleTimeString();
    renderRuns(); renderReport();
  } catch (e) { $('status').textContent = '状态获取失败：' + e.message; }
}

async function run() {
  const requirement = $('req').value.trim();
  if (!requirement) { $('status').textContent = '先写需求'; return; }
  $('go').disabled = true;
  $('status').textContent = '辩论中…（最多 3 轮，通常几秒到几十秒）';
  try {
    const res = await fetch('/api/debate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-quorum-token': TOKEN },
      body: JSON.stringify({
        requirement,
        scenario: $('scenario').value,
        maxRounds: Number($('rounds').value),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    state.selected = data.run.runId;
    $('status').textContent = '完成：' + data.run.rounds + ' 轮 · ' + data.run.stopLabel;
    await load();
  } catch (e) {
    $('status').textContent = '失败：' + e.message;
  } finally { $('go').disabled = false; }
}

$('go').onclick = run;
$('refresh').onclick = load;
load();
setInterval(load, 5000);
</script>
</body>
</html>`;

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 启动控制面板。
 *
 * @param {object} options
 * @param {() => object} options.getState 返回 { version, provider, runs, sandboxCount }
 * @param {(input: {requirement: string, maxRounds?: number, scenario?: string}) => Promise<{markdown: string, meta: object}>} options.runDebate
 * @param {(line: string, error?: unknown) => void} [options.log]
 * @param {number} [options.port]
 */
export async function startPanel({ getState, runDebate, log = () => {}, port = 7845 }) {
  const token = crypto.randomBytes(16).toString('hex');
  const html = HTML.replace('__TOKEN__', token);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        send(res, 200, html, 'text/html; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, 200, getState());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, 200, { ok: true, at: new Date().toISOString() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/debate') {
        if (req.headers['x-quorum-token'] !== token) {
          json(res, 401, { error: 'token 不匹配' });
          return;
        }
        const raw = await readBody(req);
        let payload = {};
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: 'JSON 解析失败' });
          return;
        }
        const requirement = String(payload.requirement ?? '').trim();
        if (!requirement) {
          json(res, 400, { error: 'requirement 不能为空' });
          return;
        }
        const result = await runDebate({
          requirement,
          maxRounds: Number(payload.maxRounds) || undefined,
          mockScenario: typeof payload.scenario === 'string' ? payload.scenario : undefined,
        });
        json(res, 200, { run: result.meta, markdown: result.markdown });
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      log(`panel request failed: ${String(error?.message ?? error)}`, error);
      json(res, 500, { error: String(error?.message ?? error) });
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE' && port !== 0) {
        server.removeListener('error', onError);
        server.listen(0, '127.0.0.1', resolve);
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', resolve);
  });

  const actualPort = server.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}/`,
    port: actualPort,
    token,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
