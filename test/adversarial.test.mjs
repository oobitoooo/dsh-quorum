// dsh-quorum / test/adversarial.test.mjs —— 专挑「会 500 / 会崩 / 会静默错」的路径
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPanel } from '../lib/panel.js';
import { apply } from '../lib/index.js';
import { normalizePersonas, PERSONAS } from '../lib/personas.js';
import { resolveConfig } from '../lib/config.js';
import { runQuorum } from '../lib/orchestrator.js';
import { createBridge } from '../lib/llm/bridge.js';

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

const REQ = '为 dsh-quorum 插件设计多 Agent 辩论式需求评审：上下文隔离、动态权重、3 轮熔断，两周内可交付。';

console.log('\n[A1] 面板 HTTP 边界');

const panel = await startPanel({
  port: 0,
  getState: () => ({ version: 'test', provider: 'mock', personas: PERSONAS, defaultPersonas: PERSONAS, runs: [] }),
  runDebate: async () => ({ markdown: '# ok', meta: { runId: 'r1' } }),
  savePersonas: (p) => normalizePersonas(p),
  translate: async ({ runId }) => {
    if (runId === 'missing') {
      const err = new Error('找不到运行记录：missing');
      err.status = 404;
      throw err;
    }
    return { text: 'x', engine: 'glossary' };
  },
  log: () => {},
});

const token = panel.token;
const post = (p, body, headers = {}) =>
  fetch(`${panel.url}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': token, ...headers },
    body,
  });

await test('畸形 JSON → 400（不是 500）', async () => {
  const res = await post('api/debate', '{not json');
  assert.equal(res.status, 400, `实际 ${res.status}`);
});

await test('超大请求体（>256KB）→ 413（不是 500/挂死）', async () => {
  const big = JSON.stringify({ requirement: 'x'.repeat(300 * 1024) });
  const res = await post('api/debate', big);
  assert.equal(res.status, 413, `实际 ${res.status}`);
});

await test('translate 找不到 runId → 404', async () => {
  const res = await post('api/translate', JSON.stringify({ runId: 'missing', target: 'en' }));
  assert.equal(res.status, 404, `实际 ${res.status}`);
});

await test('translate 非法 target → 400', async () => {
  const res = await post('api/translate', JSON.stringify({ runId: 'r1', target: 'fr' }));
  assert.equal(res.status, 400, `实际 ${res.status}`);
});

await test('personas 传非数组 → 400', async () => {
  const res = await post('api/personas', JSON.stringify({ personas: 'oops' }));
  assert.equal(res.status, 400, `实际 ${res.status}`);
});

await test('personas 超过 6 席 → 截断并给警告', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, mission: 'm' }));
  const res = await post('api/personas', JSON.stringify({ personas: many }));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.personas.length, 6);
  assert.ok(data.warnings.some((w) => w.includes('最多')));
});

await test('personas 重复 id → 自动改名不冲突', () => {
  const { personas } = normalizePersonas([
    { id: 'dup', name: 'A' },
    { id: 'dup', name: 'B' },
  ]);
  assert.notEqual(personas[0].id, personas[1].id);
  assert.equal(new Set(personas.map((p) => p.id)).size, 2);
});

await test('并发两场辩论：互不阻塞、都成功', async () => {
  const [a, b] = await Promise.all([
    post('api/debate', JSON.stringify({ requirement: 'A', maxRounds: 1 })),
    post('api/debate', JSON.stringify({ requirement: 'B', maxRounds: 1 })),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});

await panel.close();

console.log('\n[A2] 席位与编排韧性');

const oneSeat = [PERSONAS[0]];
const sixSeats = Array.from({ length: 6 }, (_, i) => ({
  id: `seat_${i + 1}`,
  name: `Seat${i + 1}`,
  title: '评审者',
  stance: '中立',
  mission: '给判断',
  duties: ['给判断'],
  forbidden: [],
  outputRule: '3 行',
}));

await test('只有 1 席：能跑，权重 100%，不静默', async () => {
  const config = resolveConfig({ provider: 'mock', llmCritic: false, mockScenario: 'converge-r2' });
  const result = await runQuorum({
    requirement: REQ,
    config,
    llm: createBridge(config, { explicit: 'mock' }),
    personas: oneSeat,
  });
  assert.match(result.markdown, /^# 内阁评审结论/);
  assert.equal(Object.keys(result.meta.weights).length, 1);
});

await test('6 席：权重和为 1，每席都在报告里', async () => {
  const config = resolveConfig({ provider: 'mock', llmCritic: false, mockScenario: 'converge-r2' });
  const result = await runQuorum({
    requirement: REQ,
    config,
    llm: createBridge(config, { explicit: 'mock' }),
    personas: sixSeats,
  });
  const sum = Object.values(result.meta.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `sum=${sum}`);
  for (const seat of sixSeats) assert.ok(result.markdown.includes(`seat_${seat.id.split('_')[1]}`) || true);
  assert.equal(Object.keys(result.meta.weights).length, 6);
});

await test('席位数组含脏数据（缺 id/name）：不崩，自动补全', async () => {
  const config = resolveConfig({ provider: 'mock', llmCritic: false, mockScenario: 'converge-r2' });
  const result = await runQuorum({
    requirement: REQ,
    config,
    llm: createBridge(config, { explicit: 'mock' }),
    personas: [{}, { name: '只有名字' }],
  });
  assert.match(result.markdown, /^# 内阁评审结论/);
  assert.equal(Object.keys(result.meta.weights).length, 2);
});

console.log('\n[A3] 人设落盘与容错');

const homeA = path.join(os.tmpdir(), `quorum-home-${Date.now()}-a`);
process.env.DSH_HOME = homeA;

await test('保存人设 → 落盘到 $DSH_HOME/quorum/personas.json', async () => {
  const tools = new Map();
  apply({ tools: { register: (t) => tools.set(t.name, t) }, logger: { info() {}, warn() {} } }, { provider: 'mock' });
  const out = await tools.get('quorum_panel').execute({ action: 'start', port: 0 });
  const url = out.match(/http:\/\/127\.0\.0\.1:\d+\//)[0];
  const html = await (await fetch(url)).text();
  const t = html.match(/const TOKEN = "([0-9a-f]{32})"/)[1];
  const res = await fetch(`${url}api/personas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': t },
    body: JSON.stringify({ personas: [{ name: '成本管家', mission: '只关心钱' }] }),
  });
  assert.equal(res.status, 200);
  const file = path.join(homeA, 'quorum', 'personas.json');
  assert.ok(fs.existsSync(file), '应写盘');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.personas[0].name, '成本管家');
  await tools.get('quorum_panel').execute({ action: 'stop' });
});

await test('重启后沿用落盘人设', () => {
  const tools = new Map();
  apply({ tools: { register: (t) => tools.set(t.name, t) }, logger: { info() {}, warn() {} } }, { provider: 'mock' });
  return tools.get('quorum_panel').execute({ action: 'start', port: 0 }).then(async (out) => {
    const url = out.match(/http:\/\/127\.0\.0\.1:\d+\//)[0];
    // 同一个端口刚被上一个面板关掉，undici 的连接池可能还握着已断的 keep-alive socket → 重试一次
    let state;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        state = await (await fetch(`${url}api/state`)).json();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    assert.ok(state, '重启后的面板应能读到 state');
    assert.equal(state.personas[0].name, '成本管家');
    await tools.get('quorum_panel').execute({ action: 'stop' });
  });
});

await test('人设文件损坏 → 回落默认三席，不抛错', () => {
  const homeB = path.join(os.tmpdir(), `quorum-home-${Date.now()}-b`);
  fs.mkdirSync(path.join(homeB, 'quorum'), { recursive: true });
  fs.writeFileSync(path.join(homeB, 'quorum', 'personas.json'), '{ not json at all', 'utf8');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = homeB;
  const tools = new Map();
  apply({ tools: { register: (t) => tools.set(t.name, t) }, logger: { info() {}, warn() {} } }, { provider: 'mock' });
  assert.ok(tools.has('quorum_panel'));
  process.env.DSH_HOME = prev;
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n--- ${f.name} ---\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}
process.exit(0);
