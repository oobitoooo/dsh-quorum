// dsh-council / test/http.test.mjs —— 真实 HTTP 路径的端到端验证
//
// 起一个本地 OpenAI 兼容的桩服务，确认三件事：
//   1. 请求形状对（/chat/completions、Bearer、max_tokens、system+user）；
//   2. 三个席位各自独立调用，轮次推进正常；
//   3. 上游 500 会重试，最终不外抛垃圾（或按预期失败）。

import assert from 'node:assert/strict';
import http from 'node:http';
import { resolveConfig } from '../lib/config.js';
import { createHttpProvider } from '../lib/llm/openai-compatible.js';
import { runCouncil } from '../lib/orchestrator.js';
import { createBridge } from '../lib/llm/bridge.js';

const REQ = '给一个两周内可交付的插件方案：三席辩论、上下文隔离、3 轮熔断。';

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

const calls = [];
let failNext = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const payload = body ? JSON.parse(body) : {};
    calls.push({ url: req.url, auth: req.headers.authorization, payload });
    if (failNext > 0) {
      failNext -= 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
      return;
    }
    const system = payload.messages?.find((m) => m.role === 'system')?.content ?? '';
    const isCritic = /评审团/.test(system);
    const isRed = /RedTeam/.test(system);
    const isArch = /Architect/.test(system);
    const roundMatch = (payload.messages ?? []).map((m) => m.content ?? '').join('\n').match(/第\s*(\d+)\/3\s*轮/);
    const round = roundMatch ? Number(roundMatch[1]) : 1;

    let content;
    if (isCritic) {
      content = JSON.stringify({ verdicts: [], blockers: [], consensus: false, optimal: false });
    } else if (isRed) {
      content =
        round === 1
          ? '[P0] 三席共享同一模型会让评分趋同 → 后果：红队失效 → 触发条件：连续两轮评分方差 < 0.2。'
          : '本轮无新增阻断。';
    } else if (isArch) {
      content = '结构成立。成本：复用现有工具，一周可起步，不建议自建平台。';
    } else {
      content = '结论：复用现有 defineTool 增量接入，两周交付。关键动作：1. 三席独立上下文；2. 权重绑定 token 配额；3. 3 轮熔断。验收：连跑三次结论一致。';
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }),
    );
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/v1`;
console.log(`\n[HTTP] stub server on ${baseUrl}`);

await test('createHttpProvider：请求形状与鉴权头正确', async () => {
  calls.length = 0;
  const provider = createHttpProvider({
    config: resolveConfig({ provider: 'http', baseUrl, apiKey: 'sk-test', model: 'stub-model', provider_retries: 0 }),
  });
  const out = await provider.complete({ system: '你是 ProductManager', messages: [{ role: 'user', content: 'hi' }], maxTokens: 128 });
  assert.match(out.text, /结论|驳回|结构/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-test');
  assert.equal(calls[0].payload.model, 'stub-model');
  assert.equal(calls[0].payload.max_tokens, 128);
});

await test('createHttpProvider：500 会重试一次后成功', async () => {
  calls.length = 0;
  failNext = 1;
  const provider = createHttpProvider({
    config: resolveConfig({ provider: 'http', baseUrl, apiKey: 'k', retries: 1, timeoutMs: 5000 }),
  });
  const out = await provider.complete({ system: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 });
  assert.ok(out.text.length > 0);
  assert.equal(calls.length, 2, '应重试一次');
});

await test('runCouncil 走 HTTP：多轮推进并只回 Markdown', async () => {
  calls.length = 0;
  failNext = 0;
  const config = resolveConfig({ provider: 'http', baseUrl, apiKey: 'k', llmCritic: true, maxRounds: 3 });
  const result = await runCouncil({ requirement: REQ, config, llm: createBridge(config, { explicit: 'http' }) });
  assert.match(result.markdown, /^# 内阁评审结论/);
  assert.ok(result.meta.rounds >= 1 && result.meta.rounds <= 3, `rounds=${result.meta.rounds}`);
  assert.equal(result.meta.provider, 'http');
  const agentCalls = calls.filter((c) =>
    /RedTeam|Architect|ProductManager/.test(JSON.stringify(c.payload.messages?.[0] ?? {})),
  );
  assert.ok(agentCalls.length >= 3, `至少三席各一次，实际 ${agentCalls.length}`);
  assert.ok(result.markdown.length < 6000);
});

await test('上游持续 500：报错带上下文，不吞异常', async () => {
  failNext = 99;
  const provider = createHttpProvider({
    config: resolveConfig({ provider: 'http', baseUrl, apiKey: 'k', retries: 0, timeoutMs: 5000 }),
  });
  await assert.rejects(
    () => provider.complete({ system: 'x', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 }),
    /上游返回 500/,
  );
  failNext = 0;
});

server.close();

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n--- ${f.name} ---\n${f.error?.stack ?? f.error}`);
  process.exit(1);
}
