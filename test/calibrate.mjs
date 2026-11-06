// 临时校准脚本：把 mock 每个剧本/每轮/每席位的评分打出来，用来调权重公式
import { resolveConfig } from '../lib/config.js';
import { PERSONAS, buildSystemPrompt } from '../lib/personas.js';
import { createMockProvider } from '../lib/llm/mock.js';
import { scoreStatement } from '../lib/critic.js';
import { coverage } from '../lib/text.js';

const REQ = '为 dsh-quorum 插件设计多 Agent 辩论式需求评审：上下文隔离、动态权重、3 轮熔断，两周内可交付。';
const config = resolveConfig({ provider: 'mock', llmCritic: false });

for (const scenario of ['converge-r2', 'never', 'water', 'overbudget']) {
  const mock = createMockProvider({ config: resolveConfig({ ...config, mockScenario: scenario }), requirement: REQ });
  console.log(`\n=== ${scenario} ===`);
  for (let round = 1; round <= 3; round++) {
    const line = [];
    for (const persona of PERSONAS) {
      const system = buildSystemPrompt(persona, { config });
      const { text } = await mock.complete({
        system,
        messages: [{ role: 'user', content: `【第 ${round} 轮 · 主任务】${REQ}` }],
        maxTokens: 833,
        purpose: 'agent',
      });
      const v = scoreStatement({ text, requirement: REQ, persona, config });
      line.push(
        `${persona.id}: cov=${coverage(REQ, text).toFixed(2)} rel=${v.scores.relevance} fea=${v.scores.feasibility} eco=${v.scores.economy} q=${v.quality} rej=${v.rejected ? 1 : 0} len=${text.length} blocks=${v.blockers.length}`,
      );
    }
    console.log(` r${round}: ` + line.join(' | '));
  }
}
