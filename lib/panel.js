// dsh-quorum / panel.js —— 本机控制面板（127.0.0.1 上的单页应用）
//
// 设计约束：
//   - 只监听 127.0.0.1；写操作要带一次性 token（防本机其它页面 CSRF 式调用）。
//   - 零依赖：node:http + 内联 HTML/JS，不引入前端构建链。
//   - 面板可以改席位人设/立场、可以看辩论过程并翻译——但这些都是「面板自己的视图」，
//     工具回传给主上下文的仍然只有 Markdown 摘要。

import http from 'node:http';
import crypto from 'node:crypto';
import { TARGETS } from './translate.js';
import { TEAM_PRESETS, presetNames } from './personas.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PRESET_LABELS = [
  { name: 'default', label: '默认三席（产品 / 红队 / 架构）' },
  { name: 'product_squad', label: '产品小分队（成本 / 安全 / 模拟客户）' },
];

const MAX_BODY = 256 * 1024;

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
  main { display:grid; grid-template-columns: 380px 1fr; gap:16px; padding:16px 20px; align-items:start; }
  @media (max-width: 980px) { main { grid-template-columns: 1fr; } }
  section { background:#11161d; border:1px solid #21262d; border-radius:8px; padding:14px; margin-bottom:16px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#8b949e; margin:0 0 10px; }
  h3 { font-size:13px; margin:14px 0 6px; color:#c9d1d9; }
  textarea, input, select { width:100%; background:#0d1117; color:#e6edf3; border:1px solid #30363d; border-radius:6px; padding:8px; font:inherit; }
  textarea { resize:vertical; }
  #req { min-height:92px; }
  label { display:block; font-size:12px; color:#8b949e; margin:8px 0 4px; }
  button { background:#238636; color:#fff; border:0; border-radius:6px; padding:8px 14px; font:inherit; cursor:pointer; }
  button:disabled { background:#21262d; color:#7d8590; cursor:default; }
  button.ghost { background:#21262d; color:#c9d1d9; }
  button.tiny { padding:4px 9px; font-size:12px; background:#21262d; color:#c9d1d9; }
  .row { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; align-items:center; }
  .run { padding:8px 0; border-bottom:1px solid #1b2028; cursor:pointer; }
  .run:last-child { border-bottom:0; }
  .run.active { background:#161d26; }
  .run .meta { display:flex; justify-content:space-between; gap:8px; font-size:12px; color:#8b949e; }
  .run .title { font-size:13px; margin:2px 0 6px; color:#c9d1d9; }
  .bars { display:flex; height:6px; border-radius:3px; overflow:hidden; background:#21262d; }
  .bars i { display:block; height:100%; }
  .b0 { background:#2f81f7; } .b1 { background:#f78166; } .b2 { background:#3fb950; } .b3 { background:#d2a8ff; } .b4 { background:#ffa657; } .b5 { background:#79c0ff; }
  pre { white-space:pre-wrap; word-break:break-word; background:#0b0f14; border:1px solid #21262d; border-radius:6px; padding:12px; max-height:46vh; overflow:auto; font:12px/1.6 ui-monospace,Consolas,monospace; }
  .seat { border:1px solid #21262d; border-radius:6px; padding:10px; margin-bottom:10px; }
  .seat .head { display:flex; justify-content:space-between; align-items:center; font-size:12px; color:#8b949e; }
  .seat input, .seat textarea { margin-top:6px; }
  .seat textarea { min-height:52px; }
  .pill { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11px; border:1px solid #30363d; color:#8b949e; }
  .ok { color:#3fb950; } .warn { color:#d29922; } .bad { color:#f85149; }
  .empty { color:#7d8590; font-size:13px; padding:10px 0; }
  .stmt { border-left:2px solid #30363d; padding:2px 0 2px 10px; margin:10px 0; }
  .stmt .name { font-weight:600; font-size:13px; }
  .hint { color:#7d8590; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>dsh-quorum</h1>
  <span class="muted" id="subtitle">控制面板</span>
  <span style="margin-left:auto" class="muted" id="clock"></span>
</header>
<main>
  <div>
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
      <div class="hint" id="status" style="margin-top:8px;min-height:18px"></div>
    </section>

    <section>
      <h2>席位人设</h2>
      <div class="hint" style="margin-bottom:8px">改的是「立场 / 职责 / 输出纪律」，改完保存即生效；最多 6 席。</div>
      <div class="row" style="margin:0 0 10px">
        <select id="preset" style="width:auto"></select>
        <button class="tiny" id="applyPreset">套用预设</button>
      </div>
      <div id="seats"></div>
      <div class="row">
        <button id="saveSeats">保存席位</button>
        <button class="ghost" id="resetSeats">恢复默认</button>
        <button class="tiny" id="addSeat">+ 加一席</button>
      </div>
    </section>
  </div>

  <div>
    <section>
      <h2>最近运行</h2>
      <div id="runs"><div class="empty">还没有运行记录</div></div>
    </section>
    <section>
      <h2>辩论过程 <span class="pill" id="procBadge">未选择</span></h2>
      <div class="row" style="margin:0 0 10px">
        <select id="lang" style="width:auto"><option value="en">翻成英文</option><option value="zh">中文</option></select>
        <button class="ghost" id="translate">翻译过程</button>
        <span class="hint" id="transNote"></span>
      </div>
      <div id="process"><div class="empty">选一条运行记录查看逐轮过程。</div></div>
      <pre id="translation" style="display:none"></pre>
    </section>
    <section>
      <h2 id="reportTitle">报告</h2>
      <pre id="report">选一条运行记录查看 Markdown 摘要。</pre>
    </section>
  </div>
</main>
<script>
const TOKEN = "__TOKEN__";
const state = { runs: [], personas: [], defaultPersonas: [], selected: null, dirty: false };
const $ = (id) => document.getElementById(id);

function esc(s) { return String(s == null ? '' : s); }
function pct(v) { return Math.round((Number(v) || 0) * 100) + '%'; }

function renderSeats() {
  const box = $('seats');
  box.innerHTML = '';
  state.personas.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'seat';
    div.innerHTML =
      '<div class="head"><span>席位 ' + (i + 1) + ' · ' + esc(p.id) + '</span>' +
      '<button class="tiny" data-del="' + i + '">删除</button></div>' +
      '<label>名称</label><input data-f="name" data-i="' + i + '" value="' + esc(p.name) + '">' +
      '<label>头衔</label><input data-f="title" data-i="' + i + '" value="' + esc(p.title) + '">' +
      '<label>立场</label><input data-f="stance" data-i="' + i + '" value="' + esc(p.stance) + '">' +
      '<label>职责 / 人设（一句话说清它负责什么、禁止什么）</label>' +
      '<textarea data-f="mission" data-i="' + i + '">' + esc(p.mission) + '</textarea>' +
      '<label>输出纪律</label><input data-f="outputRule" data-i="' + i + '" value="' + esc(p.outputRule) + '">';
    box.appendChild(div);
  });
  box.querySelectorAll('input,textarea').forEach((el) => {
    el.oninput = () => {
      state.personas[Number(el.dataset.i)][el.dataset.f] = el.value;
      state.dirty = true;
    };
  });
  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = () => {
      if (state.personas.length <= 2) { $('status').textContent = '至少保留 2 个席位'; return; }
      state.personas.splice(Number(btn.dataset.del), 1);
      state.dirty = true;
      renderSeats();
    };
  });
}

function newSeat() {
  return {
    id: 'seat_' + (state.personas.length + 1),
    name: 'Seat' + (state.personas.length + 1),
    title: '评审者',
    stance: '中立',
    mission: '从自己的专业角度给出可执行判断，指出被忽略的约束。',
    outputRule: '最多 6 行、不超过 300 字；先给结论。',
  };
}

function renderRuns() {
  const box = $('runs');
  if (!state.runs.length) { box.innerHTML = '<div class="empty">还没有运行记录</div>'; return; }
  box.innerHTML = '';
  for (const run of state.runs) {
    const div = document.createElement('div');
    div.className = 'run' + (run.runId === state.selected ? ' active' : '');
    const q = Number(run.quality || 0);
    const tone = q >= 7 ? 'ok' : q >= 5 ? 'warn' : 'bad';
    const w = run.weights || {};
    const bars = Object.keys(w).map((id, i) =>
      '<i class="b' + (i % 6) + '" style="width:' + pct(w[id]) + '" title="' + esc(id) + ' ' + pct(w[id]) + '"></i>'
    ).join('');
    div.innerHTML =
      '<div class="meta"><span>' + esc(run.timeLabel) + '</span><span>' + esc(run.rounds) + ' 轮 · ' + esc(run.stopLabel) + '</span></div>' +
      '<div class="title">' + esc(run.requirement) + '</div>' +
      '<div class="meta"><span class="' + tone + '">质量 ' + q.toFixed(1) + '</span><span>' + esc(run.provider) + ' · ' + esc(run.tokensSpent) + ' token</span></div>' +
      '<div class="bars" style="margin-top:6px">' + bars + '</div>';
    div.onclick = () => { state.selected = run.runId; renderRuns(); renderDetail(); };
    box.appendChild(div);
  }
}

function renderDetail() {
  const run = state.runs.find((r) => r.runId === state.selected);
  if (!run) return;
  $('procBadge').textContent = run.requirement;
  const box = $('process');
  const rounds = run.transcript || [];
  if (!rounds.length) {
    box.innerHTML = '<div class="empty">这次运行没有过程记录（可能是旧版本跑出来的）。</div>';
  } else {
    box.innerHTML = '';
    for (const round of rounds) {
      const h = document.createElement('h3');
      h.textContent = '第 ' + round.round + ' 轮 · 质量 ' + Number(round.summary && round.summary.quality || 0).toFixed(1);
      box.appendChild(h);
      for (const s of round.statements) {
        const div = document.createElement('div');
        div.className = 'stmt';
        const sc = s.scores || {};
        div.innerHTML =
          '<div class="name">' + esc(s.name) + ' <span class="pill">相关性 ' + esc(sc.relevance) + ' · 可行性 ' + esc(sc.feasibility) + ' · 经济性 ' + esc(sc.economy) + ' · 综合 ' + esc(s.quality) + '</span></div>' +
          '<div style="white-space:pre-wrap;margin-top:4px">' + esc(s.text) + '</div>';
        box.appendChild(div);
      }
      const blockers = (round.summary && round.summary.openBlockers) || [];
      if (blockers.length) {
        const p = document.createElement('div');
        p.className = 'hint';
        p.textContent = '未解决阻断：' + blockers.map((b) => '[' + b.severity + '] ' + b.claim).join('；');
        box.appendChild(p);
      }
    }
  }
  $('reportTitle').textContent = '报告 · ' + run.requirement;
  $('report').textContent = run.markdown || '（这次运行没有留下摘要）';
  $('translation').style.display = 'none';
  $('transNote').textContent = '';
}

async function load() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    const data = await res.json();
    state.runs = data.runs || [];
    state.presetData = data.presetData || {};
    if (!state.dirty) {
      state.personas = data.personas || [];
      state.defaultPersonas = data.defaultPersonas || state.personas;
      renderSeats();
    }
    if (data.presets && !$('preset').dataset.ready) {
      $('preset').innerHTML = data.presets.map((p) => '<option value="' + esc(p.name) + '">' + esc(p.label) + '</option>').join('');
      $('preset').dataset.ready = '1';
    }
    $('subtitle').textContent = '控制面板 · v' + data.version + ' · ' + data.provider + ' · 席位 ' + state.personas.length + ' · 已跑 ' + state.runs.length + ' 场';
    $('clock').textContent = new Date().toLocaleTimeString();
    renderRuns(); renderDetail();
  } catch (e) { $('status').textContent = '状态获取失败：' + e.message; }
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': TOKEN },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function run() {
  const requirement = $('req').value.trim();
  if (!requirement) { $('status').textContent = '先写需求'; return; }
  $('go').disabled = true;
  $('status').textContent = '辩论中…（最多 ' + $('rounds').value + ' 轮）';
  try {
    const data = await post('/api/debate', {
      requirement,
      scenario: $('scenario').value,
      maxRounds: Number($('rounds').value),
    });
    state.selected = data.run.runId;
    $('status').textContent = '完成：' + data.run.rounds + ' 轮 · ' + data.run.stopLabel;
    await load();
  } catch (e) { $('status').textContent = '失败：' + e.message; }
  finally { $('go').disabled = false; }
}

async function saveSeats() {
  try {
    const data = await post('/api/personas', { personas: state.personas });
    state.personas = data.personas;
    state.dirty = false;
    renderSeats(); renderRuns();
    $('status').textContent = '席位已保存' + (data.warnings && data.warnings.length ? '：' + data.warnings.join('；') : '');
    await load();
  } catch (e) { $('status').textContent = '保存失败：' + e.message; }
}

async function translate() {
  if (!state.selected) { $('status').textContent = '先选一条运行记录'; return; }
  $('translate').disabled = true;
  $('transNote').textContent = '翻译中…';
  try {
    const data = await post('/api/translate', { runId: state.selected, target: $('lang').value });
    $('translation').style.display = 'block';
    $('translation').textContent = data.text;
    $('transNote').textContent = '引擎：' + data.engine + (data.note ? '（' + data.note + '）' : '');
  } catch (e) { $('transNote').textContent = '失败：' + e.message; }
  finally { $('translate').disabled = false; }
}

$('go').onclick = run;
$('refresh').onclick = load;
$('saveSeats').onclick = saveSeats;
$('applyPreset').onclick = () => {
  const name = $('preset').value;
  const preset = state.presetData && state.presetData[name];
  if (!preset) { $('status').textContent = '没有这个预设'; return; }
  state.personas = JSON.parse(JSON.stringify(preset));
  state.dirty = true;
  renderSeats();
  $('status').textContent = '已套用预设「' + name + '」，点「保存席位」生效';
};
$('resetSeats').onclick = () => { state.personas = JSON.parse(JSON.stringify(state.defaultPersonas)); state.dirty = true; renderSeats(); $('status').textContent = '已恢复默认（记得点保存）'; };
$('addSeat').onclick = () => { if (state.personas.length >= 6) { $('status').textContent = '最多 6 席'; return; } state.personas.push(newSeat()); state.dirty = true; renderSeats(); };
$('translate').onclick = translate;
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
        // 不要 destroy：那样客户端只会看到 socket 断掉。停止收集、把剩余数据读掉，让外层回 413。
        reject(new HttpError(413, `请求体超过 ${MAX_BODY} 字节`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 统一解析 JSON：畸形请求回 400，而不是 500。 */
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'JSON 解析失败');
  }
}

/**
 * 启动控制面板。
 *
 * @param {object} options
 * @param {() => object} options.getState
 * @param {(input: object) => Promise<object>} options.runDebate
 * @param {(personas: unknown) => {personas: object[], warnings: string[]}} options.savePersonas
 * @param {(input: {runId: string, target: string}) => Promise<object>} options.translate
 * @param {(line: string, error?: unknown) => void} [options.log]
 * @param {number} [options.port]
 */
export async function startPanel({ getState, runDebate, savePersonas, translate, log = () => {}, port = 7845 }) {
  const token = crypto.randomBytes(16).toString('hex');
  const html = HTML.replace('__TOKEN__', token);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const guarded = () => req.headers['x-quorum-token'] === token;
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        send(res, 200, html, 'text/html; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, 200, { ...getState(), presets: PRESET_LABELS, presetData: TEAM_PRESETS });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json(res, 200, { ok: true, at: new Date().toISOString() });
        return;
      }
      if (req.method === 'POST' && !guarded()) {
        json(res, 401, { error: 'token 不匹配' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/debate') {
        const payload = await readJson(req);
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
      if (req.method === 'POST' && url.pathname === '/api/personas') {
        const payload = await readJson(req);
        if (!Array.isArray(payload.personas)) throw new HttpError(400, 'personas 必须是数组');
        const saved = savePersonas(payload.personas);
        json(res, 200, saved);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/translate') {
        const payload = await readJson(req);
        const runId = String(payload.runId ?? '');
        const target = String(payload.target ?? 'en');
        if (!TARGETS.includes(target)) throw new HttpError(400, `不支持的目标语言：${target}`);
        if (!runId) {
          json(res, 400, { error: 'runId 不能为空' });
          return;
        }
        const result = await translate({ runId, target });
        json(res, 200, result);
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) log(`panel request failed: ${String(error?.message ?? error)}`, error);
      json(res, status, { error: String(error?.message ?? error) });
    }
  });

  await new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (candidate) => {
      const onError = (error) => {
        if (error.code === 'EADDRINUSE' && attempt < 10) {
          attempt += 1;
          server.removeListener('error', onError);
          tryListen(candidate + 1);
          return;
        }
        if (error.code === 'EADDRINUSE' && port !== 0) {
          server.removeListener('error', onError);
          tryListen(0);
          return;
        }
        reject(error);
      };
      server.once('error', onError);
      server.listen(candidate, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve();
      });
    };
    tryListen(port);
  });

  const actualPort = server.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}/`,
    port: actualPort,
    token,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // fetch 的 keep-alive 连接会让 close() 一直等下去；测试与关停都要能立刻返回
        server.closeAllConnections?.();
      }),
  };
}
