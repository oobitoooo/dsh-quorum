// dsh-quorum / test/history.test.mjs —— 运行记录落盘
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadHistory, saveHistory, appendHistory, historyFile, HISTORY_LIMIT } from '../lib/history.js';

const home = path.join(os.tmpdir(), `quorum-history-${Date.now()}`);
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

const run = (i) => ({ runId: `run-${i}`, requirement: `需求 ${i}`, markdown: `# ${i}`, transcript: [], quality: i });

console.log('\n[H] 历史记录');

await test('空目录：读出来是空数组，不抛错', () => {
  assert.deepEqual(loadHistory(), []);
});

await test('追加写入后能读回，并落盘', () => {
  appendHistory(run(1));
  appendHistory(run(2));
  const all = loadHistory();
  assert.equal(all.length, 2);
  assert.equal(all[1].runId, 'run-2');
  assert.ok(fs.existsSync(historyFile()));
});

await test(`超过 ${HISTORY_LIMIT} 条：只留最近 ${HISTORY_LIMIT} 条`, () => {
  for (let i = 3; i <= 30; i++) appendHistory(run(i), 50);
  saveHistory(Array.from({ length: 30 }, (_, i) => run(i)), HISTORY_LIMIT);
  const all = loadHistory();
  assert.equal(all.length, HISTORY_LIMIT);
  assert.equal(all.at(-1).runId, 'run-29');
});

await test('文件损坏：当空历史，不炸', () => {
  fs.writeFileSync(historyFile(), '{ broken json', 'utf8');
  assert.deepEqual(loadHistory(), []);
});

await test('结构不对（没有 runId）：过滤掉', () => {
  saveHistory([{ foo: 1 }, { runId: 'ok' }], 20);
  // saveHistory 不校验，loadHistory 负责过滤
  const all = loadHistory();
  assert.equal(all.length, 1);
  assert.equal(all[0].runId, 'ok');
});

await test('写入是原子替换：不会留下 .tmp', () => {
  saveHistory([run(1), run(2)]);
  const dir = path.dirname(historyFile());
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n--- ${f.name} ---\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}
process.exit(0);
