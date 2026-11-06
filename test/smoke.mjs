// dsh-quorum / test/smoke.mjs —— 编排、调权、熔断、出口守卫的回归测试
//
// 全部离线：mock provider 是确定性的，所以断言可以写死（轮次、终止原因、权重方向）。
// 跑法：node test/smoke.mjs

import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.js';
import { PERSONAS } from '../lib/personas.js';
import { QuorumSandbox, assertNoTranscript } from '../lib/sandbox.js';
import { projectWeights, updateWeights, initialWeights } from '../lib/weights.js';
import { decideStop } from '../lib/breaker.js';
import { scoreStatement, mergeVerdict, anonymizeStatements, evaluateRound } from '../lib/critic.js';
import { buildCriticUserPrompt } from '../lib/personas.js';
import { createBridge } from '../lib/llm/bridge.js';
import { runQuorum } from '../lib/orchestrator.js';
import { apply } from '../lib/index.js';

const REQ =
  '为 dsh-quorum 插件设计多 Agent 辩论式需求评审：上下文隔离、动态权重、3 轮熔断，两周内可交付。';

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

const cfg = (overrides = {}) =>
  resolveConfig({ provider: 'mock', llmCritic: false, mockScenario: 'converge-r2', ...overrides });

const bridge = (config, requirement = REQ) => createBridge(config, { explicit: 'mock' });

console.log('\n[1] 配置与权重投影');

await test('projectWeights：和为 1 且落在 [min,max]', () => {
  for (const raw of [[1, 1, 1], [10, 1, 1], [0.01, 5, 0.2], [3, 3, 3]]) {
    const w = projectWeights(raw, 0.08, 0.6);
    const sum = w.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `sum=${sum}`);
    for (const v of w) assert.ok(v >= 0.08 - 1e-9 && v <= 0.6 + 1e-9, `v=${v}`);
  }
});

await test('projectWeights：边界不可行时抛错而不是静默出错', () => {
  assert.throws(() => projectWeights([1, 1, 1], 0.5, 0.9), /权重边界不可行/);
});

await test('updateWeights：高分加权、低分掉权、总和仍为 1', () => {
  const config = cfg();
  const ids = ['product_manager', 'red_team', 'architect'];
  const prev = initialWeights(ids);
  const { weights } = updateWeights({
    prev,
    personaIds: ids,
    config,
    verdicts: [
      { id: 'product_manager', quality: 9, rejected: false },
      { id: 'red_team', quality: 4, rejected: false },
      { id: 'architect', quality: 5, rejected: false },
    ],
  });
  assert.ok(weights.product_manager > prev.product_manager, '高分席位应加权');
  assert.ok(weights.red_team < prev.red_team, '低分席位应掉权');
  assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 1e-6);
});

await test('updateWeights：被驳回的席位掉权更狠', () => {
  const config = cfg();
  const ids = ['product_manager', 'red_team', 'architect'];
  const prev = initialWeights(ids);
  const base = updateWeights({
    prev,
    personaIds: ids,
    config,
    verdicts: [{ id: 'product_manager', quality: 5, rejected: false }, { id: 'red_team', quality: 5, rejected: false }, { id: 'architect', quality: 5, rejected: false }],
  }).weights.product_manager;
  const rejected = updateWeights({
    prev,
    personaIds: ids,
    config,
    verdicts: [{ id: 'product_manager', quality: 5, rejected: true }, { id: 'red_team', quality: 5, rejected: false }, { id: 'architect', quality: 5, rejected: false }],
  }).weights.product_manager;
  assert.ok(rejected < base, `rejected=${rejected} base=${base}`);
});

console.log('\n[2] 评分器');

await test('scoreStatement：超预算方案被驳回', () => {
  const v = scoreStatement({
    text: '从零手搓一个 GTA6 级别的自研引擎，全部重写现有运行时，十万行代码，三到五年完成。',
    requirement: REQ,
    persona: PERSONAS[0],
    config: cfg(),
  });
  assert.equal(v.rejected, true);
  assert.ok(v.scores.economy <= 3, `economy=${v.scores.economy}`);
});

await test('scoreStatement：水字数被识别，质量显著低于正常发言', () => {
  const config = cfg();
  const good = scoreStatement({
    text: '结论：复用现有工具增量接入，两周交付。关键动作：1. 注册 quorum_debate；2. 三席独立上下文，3000 字截断；3. 评审团一次评完。验收：连跑 3 次结论一致。',
    requirement: REQ,
    persona: PERSONAS[0],
    config,
  });
  const water = scoreStatement({
    text: '在当前背景下，要以抓手思维打造一体化平台，形成生态闭环，实现全链路赋能与共振，进行维度升级与组合拳打法，实现可持续的整体闭环。',
    requirement: REQ,
    persona: PERSONAS[0],
    config,
  });
  assert.ok(water.quality < good.quality - 2, `water=${water.quality} good=${good.quality}`);
  assert.ok(water.metrics.hollow > 0);
});

await test('mergeVerdict：LLM 与确定性 6:4 融合，驳回取并集', () => {
  const config = cfg();
  const heuristic = scoreStatement({
    text: '方案：复用现有能力，两周落地，先做最小验证。',
    requirement: REQ,
    persona: PERSONAS[0],
    config,
  });
  const merged = mergeVerdict(heuristic, { relevance: 10, feasibility: 10, economy: 10, rejected: false }, config);
  assert.equal(merged.source, 'llm+heuristic');
  const expected = Math.round((0.6 * 10 + 0.4 * heuristic.scores.relevance) * 100) / 100;
  assert.equal(merged.scores.relevance, expected, `融合分应为 0.6*LLM+0.4*确定性 = ${expected}`);
  assert.ok(merged.scores.relevance >= heuristic.scores.relevance, 'LLM 满分不应拉低融合分');
  const vetoed = mergeVerdict(heuristic, { relevance: 8, feasibility: 8, economy: 2, rejected: true, notes: '超预算' }, config);
  assert.equal(vetoed.rejected, true);
});

console.log('\n[2b] 借鉴能力：匿名互评 / 评审独立性 / 主席裁定');

await test('匿名互评：标签为 A/B/C，确定性洗牌，可反解回席位', () => {
  const statements = PERSONAS.map((p) => ({ persona: p, text: `发言 ${p.id}` }));
  const weights = { product_manager: 0.3, red_team: 0.4, architect: 0.3 };
  const first = anonymizeStatements(statements, weights, { round: 1, requirement: REQ, enabled: true });
  const second = anonymizeStatements(statements, weights, { round: 1, requirement: REQ, enabled: true });
  assert.deepEqual(first.entries.map((e) => e.label), ['A', 'B', 'C']);
  assert.deepEqual(first.entries.map((e) => e.label), second.entries.map((e) => e.label), '同输入必须同顺序');
  for (const [label, id] of first.decode) {
    assert.ok(PERSONAS.some((p) => p.id === id), `${label} 应反解到真实席位`);
  }
  const prompt = buildCriticUserPrompt({
    requirement: REQ,
    round: 1,
    entries: first.entries,
  });
  assert.ok(!/ProductManager|RedTeam|Architect/.test(prompt), '评审团提示词里不能出现席位名');
  assert.match(prompt, /### A（权重/);
});

await test('评审独立性：同源降权 0.4 的融合公式成立', () => {
  const config = cfg();
  const heuristic = scoreStatement({
    text: '方案：复用现有能力，两周落地，先做最小验证。',
    requirement: REQ,
    persona: PERSONAS[0],
    config,
  });
  const llm = { relevance: 9, feasibility: 9, economy: 9, rejected: false };
  const same = mergeVerdict(heuristic, llm, config, 0.4);
  const expected = Math.round((0.4 * 9 + 0.6 * heuristic.scores.relevance) * 100) / 100;
  assert.equal(same.scores.relevance, expected);
  const full = mergeVerdict(heuristic, llm, config, 0.6);
  assert.ok(full.scores.relevance > same.scores.relevance, '同源时应比独立评审更保守');
});

await test('评委返回匿名标签时能映射回席位，并按 0.4 权重融合', async () => {
  const config = cfg({ llmCritic: true });
  let seenPrompt = '';
  const fakeCritic = {
    id: 'fake',
    async complete({ purpose, messages }) {
      if (purpose !== 'critic') return { text: '' };
      seenPrompt = messages[0].content;
      const labels = [...seenPrompt.matchAll(/^### ([A-Z])（权重/gm)].map((m) => m[1]);
      return {
        text: JSON.stringify({
          verdicts: labels.map((label) => ({ id: label, relevance: 9, feasibility: 9, economy: 9, rejected: false })),
          blockers: [],
          consensus: true,
          optimal: true,
        }),
      };
    },
  };
  const statements = PERSONAS.map((p) => ({ persona: p, text: '结论：复用现有工具，两周交付最小闭环，验收连跑三次一致。' }));
  const evaluation = await evaluateRound({
    round: 1,
    requirement: REQ,
    statements,
    weights: { product_manager: 1 / 3, red_team: 1 / 3, architect: 1 / 3 },
    config,
    llm: fakeCritic,
    llmWeight: 0.4,
  });
  assert.ok(!/ProductManager|RedTeam|Architect/.test(seenPrompt));
  assert.equal(evaluation.verdicts.length, 3);
  for (const v of evaluation.verdicts) {
    assert.ok(PERSONAS.some((p) => p.id === v.id), `映射后的 id 必须是席位：${v.id}`);
    assert.equal(v.source, 'llm+heuristic');
  }
  assert.equal(evaluation.source, 'llm+heuristic(0.4)', '本轮应按降权后的 0.4 融合');
  assert.equal(evaluation.anonymized, true);
});

await test('主席裁定：开启时进报告，关闭时整段消失', async () => {
  const on = cfg({ chairman: 'on' });
  const withChairman = await runQuorum({ requirement: REQ, config: on, llm: bridge(on) });
  assert.match(withChairman.markdown, /## .、主席裁定/);
  assert.match(withChairman.markdown, /可以开工/);
  assert.equal(withChairman.meta.chairman.used, true);

  const off = cfg({ chairman: 'off' });
  const without = await runQuorum({ requirement: REQ, config: off, llm: bridge(off) });
  assert.ok(!without.markdown.includes('主席裁定'));
  assert.equal(without.meta.chairman.used, false);
});

await test('主席仍受出口守卫约束（报告里没有长段原文）', async () => {
  const config = cfg({ chairman: 'on' });
  const result = await runQuorum({ requirement: REQ, config, llm: bridge(config) });
  assert.equal(result.meta.egress.ok, true);
  assert.ok(result.meta.egress.leaked === 0, `leaked=${result.meta.egress.leaked}`);
});

console.log('\n[3] 沙箱隔离与出口守卫');

await test('沙箱：各席位上下文互不共享对象', () => {
  const sandbox = new QuorumSandbox(PERSONAS);
  for (const persona of PERSONAS) {
    sandbox.get(persona.id).seedSystem(`你是 ${persona.name}`);
    sandbox.get(persona.id).brief(`task for ${persona.id}`);
    sandbox.get(persona.id).record(`answer from ${persona.id}`);
  }
  assert.equal(sandbox.assertIsolated(), true);
  const a = sandbox.get('product_manager');
  const b = sandbox.get('red_team');
  assert.notEqual(a.messages, b.messages);
  assert.equal(b.messages[1].content, 'task for red_team');
});

await test('沙箱：手工共享数组会被自检拦下', () => {
  const sandbox = new QuorumSandbox(PERSONAS);
  const shared = [{ role: 'user', content: 'x' }];
  sandbox.get('red_team').messages = shared;
  sandbox.get('architect').messages = shared;
  assert.throws(() => sandbox.assertIsolated(), /上下文泄漏/);
});

await test('出口守卫：回灌原文会被拦下', () => {
  const sandbox = new QuorumSandbox(PERSONAS);
  const long = '这是一段足够长的辩论原文，用来验证出口守卫能不能拦住倒灌。'.repeat(4);
  sandbox.get('red_team').record(long);
  assert.throws(() => assertNoTranscript(`# 报告\n\n${long}\n`, sandbox), /出口守卫/);
  const ok = assertNoTranscript('# 报告\n\n结论：通过。\n', sandbox);
  assert.equal(ok.leaked, 0);
});

console.log('\n[4] 熔断');

await test('breaker：达成共识提前终止', () => {
  const config = cfg();
  const decision = decideStop({
    round: 1,
    config,
    previous: null,
    summary: { weightedQuality: 8, spread: 0.3, openBlockers: [], rejectedCount: 0, consensus: true, optimal: false, allRejected: false },
  });
  assert.equal(decision.stop, true);
  assert.equal(decision.reason, 'consensus');
});

await test('breaker：轮次上限强制终止', () => {
  const config = cfg();
  const decision = decideStop({
    round: 3,
    config,
    previous: { weightedQuality: 7 },
    summary: { weightedQuality: 7.5, spread: 1, openBlockers: [{ severity: 'P0' }], rejectedCount: 0, consensus: false, optimal: false, allRejected: false },
  });
  assert.equal(decision.stop, true);
  assert.equal(decision.reason, 'max-rounds');
});

await test('breaker：无进展且无阻断 → 提前收敛', () => {
  const config = cfg();
  const decision = decideStop({
    round: 2,
    config,
    previous: { weightedQuality: 6.4 },
    summary: { weightedQuality: 6.45, spread: 0.9, openBlockers: [], rejectedCount: 0, consensus: false, optimal: false, allRejected: false },
  });
  assert.equal(decision.reason, 'no-progress');
});

console.log('\n[5] 端到端编排（mock）');

await test('converge-r2：第 2 轮达成共识即停，不跑满 3 轮', async () => {
  const config = cfg();
  const result = await runQuorum({ requirement: REQ, config, llm: bridge(config) });
  assert.equal(result.meta.rounds, 2, `rounds=${result.meta.rounds}`);
  assert.equal(result.meta.stopReason, 'consensus');
  assert.ok(result.meta.quality >= config.thresholds.consensusQuality);
  assert.equal(result.meta.openBlockers.length, 0);
});

await test('converge-r3：第 2 轮仍有新增阻断，第 3 轮清空后收敛', async () => {
  const config = cfg({ mockScenario: 'converge-r3' });
  const result = await runQuorum({ requirement: REQ, config, llm: bridge(config) });
  assert.equal(result.meta.rounds, 3, `rounds=${result.meta.rounds}`);
  assert.equal(result.meta.openBlockers.length, 0);
});

await test('never：始终有 P0 阻断 → 跑满 3 轮后熔断', async () => {
  const config = cfg({ mockScenario: 'never' });
  const result = await runQuorum({ requirement: REQ, config, llm: bridge(config) });
  assert.equal(result.meta.rounds, 3);
  assert.equal(result.meta.stopReason, 'max-rounds');
  assert.ok(result.meta.openBlockers.length > 0);
});

await test('overbudget：提案被驳回、掉权并在下一轮静默', async () => {
  const config = cfg({ mockScenario: 'overbudget' });
  const result = await runQuorum({ requirement: REQ, config, llm: bridge(config) });
  assert.ok(result.meta.rejected.length > 0, '应存在被驳回的建议');
  assert.ok(result.meta.weights.product_manager < 1 / 3, `pm权重=${result.meta.weights.product_manager}`);
  assert.ok(result.meta.muted.includes('product_manager'), `muted=${result.meta.muted}`);
});

await test('water：水字数导致掉权（并可能被静默）', async () => {
  const config = cfg({ mockScenario: 'water' });
  const result = await runQuorum({ requirement: REQ, config, llm: bridge(config) });
  assert.ok(result.meta.weights.product_manager < 1 / 3, `pm权重=${result.meta.weights.product_manager}`);
  assert.ok(result.meta.rounds <= 3);
});

await test('摘要只含结构化字段，长度受控且不含原文', async () => {
  const config = cfg();
  const result = await runQuorum({ requirement: REQ, config, llm: bridge(config) });
  const md = result.markdown;
  assert.ok(md.length <= config.report.maxChars, `len=${md.length}`);
  assert.match(md, /^# 内阁评审结论/);
  assert.match(md, /## .、下一步/);
  assert.match(md, /隔离声明/);
  assert.ok(!md.includes('本轮无新增阻断'), '不应出现红队原句');
  assert.ok(!md.includes('按红队意见逐条收口'), '不应出现产品经理原句');
});

await test('llmCritic=true 且 mock 返回空 verdicts：回落确定性评分不报错', async () => {
  const config = cfg({ llmCritic: true });
  const result = await runQuorum({ requirement: REQ, config, llm: bridge(config) });
  assert.ok(result.markdown.includes('评分源 heuristic'));
});

await test('宿主未 inject llm：createBridge 不抛错，回退 mock', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'llm', {
    get() {
      throw new Error('cannot get property "llm" without inject');
    },
  });
  const config = cfg({ provider: 'auto', baseUrl: '', apiKey: '' });
  const bridge = createBridge(config, { ctx: hostile });
  assert.equal(bridge.id, 'mock');
});

await test('宿主未 inject llm：插件装配与调用仍可跑通（真实回归）', async () => {
  const tools = new Map();
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) }, logger: { info() {}, warn() {} } };
  Object.defineProperty(ctx, 'llm', {
    get() {
      throw new Error('cannot get property "llm" without inject');
    },
  });
  apply(ctx, { provider: 'auto', llmCritic: false, mockScenario: 'converge-r2' });
  const out = await tools.get('quorum_debate').execute({ requirement: REQ });
  assert.match(out, /^# 内阁评审结论/);
});

console.log('\n[6] 插件装配');

await test('apply() 注册 5 个工具，quorum_debate 可跑通', async () => {
  const registered = new Map();
  const fakeCtx = {
    tools: { register: (tool) => registered.set(tool.name, tool) },
    logger: { info() {}, warn() {} },
  };
  apply(fakeCtx, { provider: 'mock', llmCritic: false, mockScenario: 'converge-r2' });
  assert.deepEqual(
    [...registered.keys()].sort(),
    ['quorum_debate', 'quorum_panel', 'quorum_rules', 'quorum_score', 'quorum_status'].sort(),
  );
  const out = await registered.get('quorum_debate').execute({ requirement: REQ });
  assert.match(out, /^# 内阁评审结论/);
  const status = registered.get('quorum_status').execute({ limit: 5 });
  assert.match(status, /quorum-/);
  const scored = registered.get('quorum_score').execute({ requirement: REQ, statement: '两周内复用现有工具交付最小闭环。' });
  assert.ok(JSON.parse(scored).scores.economy > 0);
});

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n--- ${f.name} ---\n${f.error?.stack ?? f.error}`);
  }
  process.exit(1);
}
