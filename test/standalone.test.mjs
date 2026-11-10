// dsh-quorum / test/standalone.test.mjs —— 独立面板（桌面快捷方式走的那条路）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStandalone } from '../lib/standalone.js';

const home = path.join(os.tmpdir(), `quorum-standalone-${Date.now()}`);
process.env.DSH_HOME = home;

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

const panel = await startStandalone({ port: 0 });
console.log(`\n[S] 独立面板 ${panel.url}`);

const token = panel.token;
const post = (p, obj) =>
  fetch(`${panel.url}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': token },
    body: JSON.stringify(obj),
  });

await test('独立面板能起来，state 自带 personas 与 version', async () => {
  const state = await (await fetch(`${panel.url}api/state`)).json();
  assert.equal(state.version, 'standalone');
  assert.equal(state.personas.length, 3);
  assert.ok(state.defaultPersonas.length === 3);
});

await test('独立面板能跑辩论，并留下过程记录', async () => {
  const res = await post('api/debate', { requirement: '给独立面板加一个深色切换', maxRounds: 1, scenario: 'converge-r2' });
  assert.equal(res.status, 200);
  const state = await (await fetch(`${panel.url}api/state`)).json();
  assert.equal(state.runs.length, 1);
  assert.ok(state.runs[0].transcript.length >= 1);
  assert.ok(state.runs[0].markdown.startsWith('# 内阁评审结论'));
  const historyFile = path.join(home, 'quorum', 'runs.json');
  assert.ok(fs.existsSync(historyFile), '运行记录应落盘');
  assert.ok(JSON.parse(fs.readFileSync(historyFile, 'utf8')).length >= 1);
});

await test('独立面板保存人设会落盘（与插件共用同一份文件）', async () => {
  const res = await post('api/personas', { personas: [{ name: '成本管家', mission: '只关心钱' }] });
  assert.equal(res.status, 200);
  const file = path.join(home, 'quorum', 'personas.json');
  assert.ok(fs.existsSync(file));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.personas[0].name, '成本管家');
});

await test('独立面板翻译走同一个回退引擎', async () => {
  const state = await (await fetch(`${panel.url}api/state`)).json();
  const res = await post('api/translate', { runId: state.runs[0].runId, target: 'en' });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.engine, 'glossary');
  assert.match(data.text, /不是机器翻译/);
});

await panel.close();

await test('关闭后端口释放', async () => {
  await assert.rejects(() => fetch(panel.url, { signal: AbortSignal.timeout(800) }));
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n--- ${f.name} ---\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}
process.exit(0);
