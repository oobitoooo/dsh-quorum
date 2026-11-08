// dsh-quorum / test/panel.test.mjs —— 控制面板端到端（真起 HTTP 服务、真发请求）
import assert from 'node:assert/strict';
import { startPanel } from '../lib/panel.js';
import { apply } from '../lib/index.js';
import { normalizePersonas, PERSONAS } from '../lib/personas.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${String(error?.message ?? error).split('\n')[0]}`);
  }
}

const fakeRuns = [
  {
    runId: 'quorum-1',
    rounds: 2,
    stopLabel: '达成共识',
    quality: 8.1,
    weights: { a: 0.4, b: 0.35, c: 0.25 },
    provider: 'mock',
    tokensSpent: 1000,
    requirement: '加导出按钮',
    markdown: '# 报告 1',
    transcript: [
      {
        round: 1,
        statements: [{ id: 'a', name: 'SeatA', text: '结论：先做导出按钮。', scores: { relevance: 8, feasibility: 7, economy: 9 }, quality: 8 }],
        summary: { quality: 8, spread: 0.2, openBlockers: [], consensus: true },
      },
    ],
  },
];
const calls = [];

const panel = await startPanel({
  port: 0,
  getState: () => ({
    version: '0.4.1-test',
    provider: 'mock',
    personas: PERSONAS,
    defaultPersonas: PERSONAS,
    sandboxCount: fakeRuns.length,
    runs: fakeRuns,
  }),
  runDebate: async (input) => {
    calls.push(input);
    return { markdown: `# 报告：${input.requirement}`, meta: { runId: 'quorum-2', rounds: 2 } };
  },
  savePersonas: (personas) => normalizePersonas(personas),
  translate: async ({ runId, target }) => ({ text: `译文(${target}) of ${runId}`, engine: 'glossary', note: 'mock' }),
  log: () => {},
});

console.log(`\n[P] 面板跑在 ${panel.url}`);

await test('GET / 返回页面，token 已注入', async () => {
  const res = await fetch(panel.url);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /控制面板/);
  assert.match(html, /席位人设/);
  assert.ok(!html.includes('__TOKEN__'));
  assert.ok(html.includes(panel.token));
});

await test('GET /api/state 带 personas 与 defaultPersonas', async () => {
  const data = await (await fetch(`${panel.url}api/state`)).json();
  assert.equal(data.version, '0.4.1-test');
  assert.equal(data.personas.length, 3);
  assert.equal(data.defaultPersonas.length, 3);
  assert.equal(data.runs.length, 1);
});

await test('POST 无 token 一律 401（debate/personas/translate）', async () => {
  for (const path of ['api/debate', 'api/personas', 'api/translate']) {
    const res = await fetch(`${panel.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401, path);
  }
  assert.equal(calls.length, 0);
});

await test('POST /api/debate 带 token → 200 且真的跑了辩论', async () => {
  const res = await fetch(`${panel.url}api/debate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': panel.token },
    body: JSON.stringify({ requirement: '加一个导出按钮', maxRounds: 2, scenario: 'converge-r2' }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.match(data.markdown, /报告：加一个导出按钮/);
  assert.deepEqual(calls.at(-1), { requirement: '加一个导出按钮', maxRounds: 2, mockScenario: 'converge-r2' });
});

await test('POST /api/debate 空需求 → 400', async () => {
  const res = await fetch(`${panel.url}api/debate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': panel.token },
    body: JSON.stringify({ requirement: '   ' }),
  });
  assert.equal(res.status, 400);
});

await test('POST /api/personas 自定义席位 → 归一化返回', async () => {
  const res = await fetch(`${panel.url}api/personas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': panel.token },
    body: JSON.stringify({
      personas: [
        { name: '成本管家', title: '成本', stance: '抠预算', mission: '只关心钱和工期' },
        { name: '安全官', title: '安全', stance: '怀疑', mission: '只关心攻击面' },
      ],
    }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.personas.length, 2);
  assert.equal(data.personas[0].name, '成本管家');
  assert.equal(data.personas[0].mission, '只关心钱和工期');
  assert.ok(data.personas[0].duties.length > 0, '未填职责时继承默认品性');
});

await test('POST /api/translate 返回译文与引擎', async () => {
  const res = await fetch(`${panel.url}api/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': panel.token },
    body: JSON.stringify({ runId: 'quorum-1', target: 'en' }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.match(data.text, /译文\(en\) of quorum-1/);
  assert.equal(data.engine, 'glossary');
});

await test('POST /api/translate 缺 runId → 400', async () => {
  const res = await fetch(`${panel.url}api/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': panel.token },
    body: JSON.stringify({ target: 'en' }),
  });
  assert.equal(res.status, 400);
});

await test('未知路径 → 404', async () => {
  const res = await fetch(`${panel.url}api/nope`);
  assert.equal(res.status, 404);
});

await panel.close();

await test('关掉之后连不上', async () => {
  await assert.rejects(() => fetch(panel.url, { signal: AbortSignal.timeout(800) }));
});

console.log('\n[P2] 插件装配（真插件 + 真面板）');

let pluginPanelUrl = null;
let p2Tools = null;

await test('quorum_panel start/status/stop 走通，state 带席位', async () => {
  const tools = new Map();
  p2Tools = tools;
  const ctx = { tools: { register: (t) => tools.set(t.name, t) }, logger: { info() {}, warn() {} } };
  apply(ctx, { provider: 'mock', llmCritic: false, mockScenario: 'converge-r2', returnTranscript: false });

  const started = await tools.get('quorum_panel').execute({ action: 'start', port: 0 });
  pluginPanelUrl = started.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
  assert.ok(pluginPanelUrl, `应返回地址：${started}`);

  const state = await (await fetch(`${pluginPanelUrl}api/state`)).json();
  assert.equal(state.version, '0.4.1');
  assert.equal(state.personas.length, 3);
  assert.match(await tools.get('quorum_panel').execute({ action: 'status' }), /面板运行中/);
});

await test('面板跑一场 → 过程记录进入 state（capture）', async () => {
  const token = await (async () => {
    const html = await (await fetch(pluginPanelUrl)).text();
    return html.match(/const TOKEN = "([0-9a-f]{32})"/)[1];
  })();
  const res = await fetch(`${pluginPanelUrl}api/debate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': token },
    body: JSON.stringify({ requirement: '给面板加导出按钮，两周内可交付', maxRounds: 2, scenario: 'converge-r2' }),
  });
  assert.equal(res.status, 200);
  const state = await (await fetch(`${pluginPanelUrl}api/state`)).json();
  const run = state.runs[0];
  assert.ok(Array.isArray(run.transcript) && run.transcript.length >= 1, '面板必须拿到逐轮过程');
  assert.ok(run.transcript[0].statements[0].text.length > 10, '过程里要有发言原文');
});

await test('翻译接口：mock 下回退术语表并明确标注', async () => {
  const html = await (await fetch(pluginPanelUrl)).text();
  const token = html.match(/const TOKEN = "([0-9a-f]{32})"/)[1];
  const state = await (await fetch(`${pluginPanelUrl}api/state`)).json();
  const res = await fetch(`${pluginPanelUrl}api/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': token },
    body: JSON.stringify({ runId: state.runs[0].runId, target: 'en' }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.engine, 'glossary');
  assert.match(data.text, /不是机器翻译/);
});

await test('自定义席位后跑一场：过程里出现新席位名', async () => {
  const html = await (await fetch(pluginPanelUrl)).text();
  const token = html.match(/const TOKEN = "([0-9a-f]{32})"/)[1];
  const save = await fetch(`${pluginPanelUrl}api/personas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': token },
    body: JSON.stringify({
      personas: [
        { name: '成本管家', title: '成本', stance: '抠预算', mission: '只关心钱和工期，超出两周就反对' },
        { name: '安全官', title: '安全', stance: '怀疑', mission: '只关心攻击面与数据泄露' },
        { name: '交付官', title: '交付', stance: '催进度', mission: '只关心能不能按时上线' },
      ],
    }),
  });
  assert.equal(save.status, 200);

  const run = await fetch(`${pluginPanelUrl}api/debate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': token },
    body: JSON.stringify({ requirement: '给面板加导出按钮，两周内可交付', maxRounds: 1, scenario: 'converge-r2' }),
  });
  assert.equal(run.status, 200);
  const state = await (await fetch(`${pluginPanelUrl}api/state`)).json();
  const names = state.runs[0].transcript.flatMap((r) => r.statements.map((s) => s.name));
  assert.deepEqual(new Set(names), new Set(['成本管家', '安全官', '交付官']));
  assert.equal(state.personas[0].name, '成本管家');
});

await test('工具装配：5 个工具都在', async () => {
  const tools = new Map();
  apply({ tools: { register: (t) => tools.set(t.name, t) }, logger: { info() {}, warn() {} } }, { provider: 'mock' });
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['quorum_debate', 'quorum_panel', 'quorum_rules', 'quorum_score', 'quorum_status'],
  );
  await tools.get('quorum_panel').execute({ action: 'stop' });
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
// 收尾：关掉 P2 起的那个面板，否则 listeners 会让 node 不退出
try {
  if (p2Tools) await p2Tools.get('quorum_panel').execute({ action: 'stop' });
} catch {
  /* 已经关掉就忽略 */
}
if (failures.length > 0) {
  for (const f of failures) console.error(`\n--- ${f.name} ---\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}
process.exit(0);
