#!/usr/bin/env node
// dsh-council / bin/council.mjs —— 命令行入口（不装 DSH 也能验证编排）
//
// 用法：
//   node bin/council.mjs "为插件设计多 Agent 辩论评审，两周内交付" --scenario=converge-r2
//   node bin/council.mjs "需求..." --provider=http --base-url=https://api.deepseek.com/v1 --model=deepseek-chat
// 环境变量（http provider）：DSH_COUNCIL_API_KEY
//
// 输出只有 Markdown 摘要；加 --json 输出元数据，加 --transcript 把全文落到 $DSH_HOME/council/runs/。

import { resolveConfig } from '../lib/config.js';
import { createBridge } from '../lib/llm/bridge.js';
import { runCouncil } from '../lib/orchestrator.js';
import { STOP_REASONS } from '../lib/breaker.js';

const HELP = `dsh-council —— 虚拟内阁需求评审

用法：
  node bin/council.mjs "<需求>" [选项]

选项：
  --scenario=<名字>   mock 剧本：converge-r2 | converge-r3 | never | water | overbudget
  --rounds=<1-3>      轮次上限（默认 3）
  --provider=<名字>   auto | mock | http | harness（默认 auto）
  --base-url=<url>    OpenAI 兼容端点
  --model=<id>        模型 id
  --json              只输出运行元数据
  --transcript        把辩论全文落盘到 $DSH_HOME/council/runs/（不回显）
  --no-critic         评审团不走模型，只用确定性评分表
  --critic-model=<id> 评审团独立模型（不填 = 与席位同源，LLM 权重自动降到 0.4）
  --chairman=<模式>   主席裁定：auto | on | off（默认 auto：非 mock 时启用）
  --no-anonymize      关闭匿名互评（默认开启：评审团只看到席位 A/B/C）
  -h, --help          显示本帮助

环境变量：
  DSH_COUNCIL_API_KEY   http provider 的 key（也可用 --api-key-env 指定别的变量名）
`;

function parseArgs(argv) {
  const out = { positionals: [], flags: {} };
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      const value = rest.join('=');
      out.flags[key] = value === '' ? true : value;
    } else if (arg === '-h') {
      out.flags.help = true;
    } else {
      out.positionals.push(arg);
    }
  }
  return out;
}

const { positionals, flags } = parseArgs(process.argv.slice(2));
if (flags.help || positionals.length === 0) {
  console.log(HELP);
  process.exit(0);
}

const requirement = positionals.join(' ');

const config = resolveConfig({
  provider: typeof flags.provider === 'string' ? flags.provider : 'auto',
  baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : '',
  model: typeof flags.model === 'string' ? flags.model : '',
  mockScenario: typeof flags.scenario === 'string' ? flags.scenario : 'auto',
  maxRounds: flags.rounds ? Number(flags.rounds) : 3,
  returnTranscript: flags.transcript === true,
  llmCritic: flags['no-critic'] ? false : true,
  anonymize: flags['no-anonymize'] ? false : true,
  criticModel: typeof flags['critic-model'] === 'string' ? flags['critic-model'] : '',
  chairman: typeof flags.chairman === 'string' ? flags.chairman : 'auto',
});

const bridge = createBridge(config);
if (bridge.fallbackNote && !flags.json) console.error(`[council] ${bridge.fallbackNote}`);

const criticSeparate = Boolean(config.criticModel);
const criticConfig = criticSeparate ? resolveConfig({ ...config, model: config.criticModel }) : config;
const criticBridge = criticSeparate ? createBridge(criticConfig) : bridge;
const criticWeight = config.llmCritic ? (config.criticIndependence === 'auto' && !criticSeparate ? 0.4 : 0.6) : 0;
const criticNote = !config.llmCritic
  ? '未启用 LLM 评审，纯确定性评分'
  : criticSeparate
    ? `评审团独立（${criticBridge.id}/${config.criticModel}），LLM 权重 ${criticWeight}`
    : `评审团与席位同源（${bridge.id}），LLM 权重降到 ${criticWeight}`;

const result = await runCouncil({
  requirement,
  config,
  llm: bridge,
  criticLlm: criticBridge,
  criticWeight,
  criticNote: `${criticNote}｜匿名互评：${config.anonymize ? '开' : '关'}`,
  onEvent: (type, payload) => {
    if (type === 'round/end') {
      console.error(
        `[council] 第 ${payload.round} 轮：质量 ${payload.quality}｜离散度 ${payload.spread}｜阻断 ${payload.openBlockers}｜` +
          `${payload.decision.stop ? `终止（${STOP_REASONS[payload.decision.reason] ?? payload.decision.reason}）` : '继续'}`,
      );
    }
    if (type === 'agent/failed') console.error(`[council] ${payload.id} 调用失败：${payload.error}`);
    if (type === 'chairman/failed') console.error(`[council] 主席裁定失败：${payload.error}`);
  },
});

if (flags.json) {
  console.log(JSON.stringify(result.meta, null, 2));
} else {
  console.log(result.markdown);
  if (result.meta.transcriptFile) console.error(`\n全文已落盘：${result.meta.transcriptFile}`);
}
