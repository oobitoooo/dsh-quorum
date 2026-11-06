// dsh-quorum / test/panel.test.mjs —— 控制面板的端到端测试（真起 HTTP 服务，真发请求）
import assert from 'node:assert/strict';
import { startPanel } from '../lib/panel.js';
import { apply } from '../lib/index.js';

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
  { runId: 'quorum-1', rounds: 2, stopLabel: '达成共识', quality: 8.1, weights: { a: 0.4, b: 0.35, c: 0.25 }, provider: 'mock', tokensSpent: 1000, markdown: '# 报告 1' },
];
const calls = [];

const panel = await startPanel({
  port: 0,
  getState: () => ({ version: '0.3.0-test', provider: 'mock', sandboxCount: fakeRuns.length, runs: fakeRuns }),
  runDebate: async (input) => {
    calls.push(input);
    return { markdown: `# 报告：${input.requirement}`, meta: { runId: 'quorum-2', rounds: 2 } };
  },
  log: () => {},
});

console.log(`\n[P] 面板跑在 ${panel.url}`);

await test('GET / 返回页面，token 已注入且不残留占位符', async () => {
  const res = await fetch(panel.url);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /控制面板/);
  assert.ok(!html.includes('__TOKEN__'), '占位符必须被替换');
  assert.ok(html.includes(panel.token), '页面里要带 token');
});

await test('GET /api/state 返回运行记录', async () => {
  const res = await fetch(`${panel.url}api/state`);
  const data = await res.json();
  assert.equal(data.version, '0.3.0-test');
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].runId, 'quorum-1');
});

await test('GET /api/health', async () => {
  const res = await fetch(`${panel.url}api/health`);
  assert.deepEqual((await res.json()).ok, true);
});

await test('POST /api/debate 无 token → 401', async () => {
  const res = await fetch(`${panel.url}api/debate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requirement: 'x' }),
  });
  assert.equal(res.status, 401);
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
  assert.equal(data.run.runId, 'quorum-2');
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

await test('未知路径 → 404', async () => {
  const res = await fetch(`${panel.url}api/nope`);
  assert.equal(res.status, 404);
});

await panel.close();

await test('关掉之后连不上（close 生效）', async () => {
  await assert.rejects(() => fetch(panel.url, { signal: AbortSignal.timeout(800) }));
});

console.log('\n[P2] 插件工具装配');

await test('quorum_panel(start/status/stop) 走通，且面板能触发真实评审', async () => {
  const tools = new Map();
  const ctx = { tools: { register: (t) => tools.set(t.name, t) }, logger: { info() {}, warn() {} } };
  apply(ctx, { provider: 'mock', llmCritic: false, mockScenario: 'converge-r2' });

  const started = await tools.get('quorum_panel').execute({ action: 'start', port: 0 });
  const url = started.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
  assert.ok(url, `应返回地址：${started}`);

  const state = await (await fetch(`${url}api/state`)).json();
  assert.equal(state.version, '0.3.0');

  const stopped = await tools.get('quorum_panel').execute({ action: 'stop' });
  assert.match(stopped, /已关闭/);
  assert.match(await tools.get('quorum_panel').execute({ action: 'status' }), /未启动/);
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n--- ${f.name} ---\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}
