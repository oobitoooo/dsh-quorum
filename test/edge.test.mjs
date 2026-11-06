// dsh-quorum / test/edge.test.mjs —— 边界与异常路径（专挑会让插件炸的地方）
//
// 目标不是覆盖率，而是「宿主里真实会遇到的怪输入」：
//   空需求、超长需求、emoji、轮次夹取、报告截断、全员调用失败、没有 llm 服务、
//   并发两场、权重边界、匿名席位超过标签表……

import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.js';
import { PERSONAS } from '../lib/personas.js';
import { runQuorum } from '../lib/orchestrator.js';
import { createBridge } from '../lib/llm/bridge.js';
import { scoreStatement, anonymizeStatements } from '../lib/critic.js';
import { buildReport } from '../lib/report.js';
import { projectWeights } from '../lib/weights.js';

const REQ = '为 dsh-quorum 插件设计多 Agent 辩论式需求评审：上下文隔离、动态权重、3 轮熔断，两周内可交付。';
const cfg = (o = {}) => resolveConfig({ provider: 'mock', llmCritic: false, mockScenario: 'converge-r2', ...o });

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

console.log('\n[E1] 输入边界');

await test('空需求：明确报错而不是静默跑空', async () => {
  const config = cfg();
  await assert.rejects(
    () => runQuorum({ requirement: '   ', config, llm: createBridge(config, { explicit: 'mock' }) }),
    (e) => e.code === 'QUORUM_EMPTY_REQUIREMENT',
  );
});

await test('超长需求：截到 maxRequirementChars 并正常出报告', async () => {
  const config = cfg({ maxRequirementChars: 300 });
  const long = '需求：'.padEnd(10, ' ') + '很长的需求描述。'.repeat(300);
  const result = await runQuorum({ requirement: long, config, llm: createBridge(config, { explicit: 'mock' }) });
  assert.match(result.markdown, /^# 内阁评审结论/);
  const line = result.markdown.split('\n').find((l) => l.startsWith('**需求**'));
  assert.ok(line.length <= 320, `需求行长度 ${line.length}`);
});

await test('emoji / 换行 / 制表符：不崩，摘要仍成立', async () => {
  const config = cfg();
  const weird = '🧪\t给插件加一个「情绪检测」\n\n要求：两周内交付 😅\u200b';
  const result = await runQuorum({ requirement: weird, config, llm: createBridge(config, { explicit: 'mock' }) });
  assert.match(result.markdown, /^# 内阁评审结论/);
});

await test('maxRounds=0 / 99：夹到 1 / 3', () => {
  assert.equal(cfg({ maxRounds: 0 }).maxRounds, 1);
  assert.equal(cfg({ maxRounds: 99 }).maxRounds, 3);
  assert.ok(cfg({ maxRounds: 99 }).warnings.some((w) => w.includes('上限 3')));
});

await test('单轮模式：只跑 1 轮，终止原因是轮次上限', async () => {
  const config = cfg({ maxRounds: 1 });
  const result = await runQuorum({ requirement: REQ, config, llm: createBridge(config, { explicit: 'mock' }) });
  assert.equal(result.meta.rounds, 1);
  assert.equal(result.meta.stopReason, 'max-rounds');
  assert.ok(result.meta.openBlockers.length > 0, '第 1 轮通常还有阻断');
});

console.log('\n[E2] 报告与出口');

await test('报告上限压到 800：不超限、带截断标记', async () => {
  const config = cfg({ report: { maxChars: 800 } });
  const result = await runQuorum({ requirement: REQ, config, llm: createBridge(config, { explicit: 'mock' }) });
  assert.ok(result.markdown.length <= 800, `len=${result.markdown.length}`);
  assert.match(result.markdown, /已按 report\.maxChars/);
});

await test('主席输出超长：按 chairmanMaxChars 截断', async () => {
  const config = cfg({ chairman: 'on', chairmanMaxChars: 120 });
  const result = await runQuorum({ requirement: REQ, config, llm: createBridge(config, { explicit: 'mock' }) });
  const section = result.markdown.split('主席裁定')[1] ?? '';
  const body = section.split('\n## ')[0].trim();
  assert.ok(body.length <= 130, `主席段长度 ${body.length}`);
});

await test('buildReport 没有轮次时也不崩（防御性默认值）', () => {
  const config = cfg();
  const out = buildReport({
    requirement: REQ,
    runId: 'r0',
    rounds: [],
    weights: { product_manager: 0.34, red_team: 0.33, architect: 0.33 },
    config,
    decision: { reason: 'max-rounds', detail: 'x' },
    provider: 'mock',
    tokensSpent: 0,
    sandbox: null,
  });
  assert.match(out.text, /^# 内阁评审结论/);
});

console.log('\n[E3] 失败路径');

await test('全员调用失败：抛 QUORUM_ALL_AGENTS_FAILED，带原因', async () => {
  const config = cfg();
  const broken = {
    id: 'broken',
    complete: async () => {
      throw new Error('upstream 500');
    },
  };
  await assert.rejects(
    () => runQuorum({ requirement: REQ, config, llm: broken }),
    (e) => e.code === 'QUORUM_ALL_AGENTS_FAILED' && /upstream 500/.test(e.message),
  );
});

await test('harness provider 没有宿主服务：报错清楚，不静默 mock', () => {
  const config = cfg({ provider: 'harness' });
  assert.throws(() => createBridge(config, { ctx: {} }), /ctx\.llm/);
});

await test('权重边界不可行：抛错而不是给出坏权重', () => {
  assert.throws(() => projectWeights([1, 1, 1], 0.5, 0.6), /权重边界不可行/);
  const config = cfg({ weights: { min: 0.5, max: 0.55 } });
  assert.ok(config.weights.min <= 1 / 3 + 1e-6, `min 应被调到 ≤1/3，实际 ${config.weights.min}`);
});

console.log('\n[E4] 并发与匿名');

await test('两场评审并发：互不串味', async () => {
  const config = cfg();
  const [a, b] = await Promise.all([
    runQuorum({ requirement: `${REQ} 场景A`, config, llm: createBridge(config, { explicit: 'mock' }) }),
    runQuorum({ requirement: `${REQ} 场景B`, config, llm: createBridge(config, { explicit: 'mock' }) }),
  ]);
  assert.notEqual(a.meta.runId, b.meta.runId);
  assert.ok(a.markdown.includes('场景A'));
  assert.ok(b.markdown.includes('场景B'));
});

await test('席位多于标签表：自动降级为 S7/S8 而不是 undefined', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    persona: { id: `seat_${i}`, name: `Seat${i}` },
    text: `发言 ${i}`,
  }));
  const { entries, decode } = anonymizeStatements(many, {}, { round: 1, requirement: REQ, enabled: true });
  assert.equal(entries.length, 8);
  assert.ok(entries.every((e) => e.label && e.label !== 'undefined'));
  assert.equal(decode.size, 8);
});

await test('空发言：评分不 NaN、不抛错', () => {
  const v = scoreStatement({ text: '', requirement: REQ, persona: PERSONAS[0], config: cfg() });
  for (const key of ['relevance', 'feasibility', 'economy']) {
    assert.ok(Number.isFinite(v.scores[key]), `${key}=${v.scores[key]}`);
  }
  assert.ok(Number.isFinite(v.quality));
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n--- ${f.name} ---\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}
