// dsh-council / index.js —— DSH 插件入口
//
// 四个工具：
//   council_debate  跑一场内阁评审，只回 Markdown 摘要（唯一的重活）
//   council_rules   打印评分口径与终止条件（写需求前先看一遍）
//   council_score   对一段发言做确定性评分（零模型，调提示词时用它对齐口径）
//   council_status  查看本次会话内最近几次运行的权重/终止原因
//
// 插件本身不持有模型配置：provider 每次调用现建，配置改了立刻生效。

import { resolveConfig, DEFAULTS, PROVIDERS } from './config.js';
import { runCouncil } from './orchestrator.js';
import { createBridge } from './llm/bridge.js';
import { scoreStatement } from './critic.js';
import { PERSONAS } from './personas.js';
import { STOP_REASONS } from './breaker.js';

// 宿主里 @deepseek-ai/dsh-tools 由 DSH 提供；单独跑测试时退化为恒等包装。
let defineTool;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  defineTool = (options) => options;
}

export const name = 'dsh-council';
export const inject = ['tools'];
export const VERSION = '0.1.0';

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

function describeRules() {
  const lines = [
    '# dsh-council 评审口径',
    '',
    '## 席位（各自独立上下文，互不可见）',
    ...PERSONAS.map((p) => `- **${p.name}**（${p.title}）：${p.mission}`),
    '',
    '## 三维评分（TTD）',
    '- **相关性**：是否在解决主任务。跑题、复述、空话 → 3 分以下。',
    '- **可行性**：逻辑自洽、动作可执行。含糊措辞扣分。',
    '- **经济性**：实现成本。需要从零自研 / 重写整个系统 / 数千行新代码 → ≤2 分并驳回。',
    '',
    '## 权重（Hedge 乘法更新）',
    '- 质量 5 分为中性点：高于 5 加权，低于 5 掉权；被驳回额外 ×0.45；质量 <3 再 ×0.5。',
    '- 上下限：8%–60%，永远保留发言资格，也永远不允许独裁。',
    '- 权重连带决定：下一轮发言顺序、静默名单（低于均分 55%）、token 配额（0.6–1.6 倍）。',
    '',
    '## 熔断',
    '最多 3 轮。提前终止条件（任一命中即停）：',
    ...Object.entries(STOP_REASONS).map(([key, label]) => `- \`${key}\`：${label}`),
    '',
    '## 评审团',
    '- 匿名互评：送给评审团的发言不署名，只给「席位 A/B/C」（每轮确定性洗牌），避免角色先验偏好。',
    '- 评审独立性：没配 `criticModel` 就是自己评自己，LLM 评分权重自动从 0.6 降到 0.4，其余由确定性评分兜底。',
    '- 主席裁定：轮次结束后由主席把结构化结论收敛成一段执行摘要（只读评分/阻断/下一步，不读全文）。',
    '',
    '## 出口',
    '只回传 Markdown 摘要（结构化字段生成，不搬运原文）；全文只在 returnTranscript=true 时落盘到 $DSH_HOME/council/runs/。',
  ];
  return lines.join('\n');
}

export function apply(ctx, config = {}) {
  const baseConfig = resolveConfig(config);
  const runs = [];

  ctx.tools.register(
    defineTool({
      name: 'council_debate',
      description:
        '启动「虚拟内阁」多 Agent 辩论评审：ProductManager 提案、RedTeam 挑刺、Architect 评估扩展性，' +
        '主工作流（评审团）逐轮按相关性/可行性/经济性打分并动态调整话语权，最多 3 轮，' +
        '达成共识或产出最优解即提前终止。只回传 Markdown 摘要，辩论全文不进主上下文。' +
        '未配置模型时用内置 mock 剧本（离线可跑，用于验证编排与熔断）。',
      parameters: {
        requirement: { type: 'string', description: '待评审的需求/方案，一句话到一段话均可（必填）' },
        maxRounds: { type: 'number', description: '轮次上限，1–3，默认 3（硬上限 3）' },
        provider: { type: 'string', enum: PROVIDERS, description: 'auto（默认）/ mock / http / harness' },
        model: { type: 'string', description: '模型 id（http provider 用）' },
        baseUrl: { type: 'string', description: 'OpenAI 兼容端点，如 https://api.deepseek.com/v1' },
        mockScenario: {
          type: 'string',
          description: 'mock 剧本：auto / converge-r2 / converge-r3 / never / water / overbudget',
        },
        llmCritic: { type: 'boolean', description: '是否让评审团也走模型（false 则纯确定性评分）' },
        criticModel: { type: 'string', description: '评审团独立模型：与席位分开时填，避免自己评自己' },
        returnTranscript: { type: 'boolean', description: '把辩论全文落盘调试（绝不回传上下文）' },
        json: { type: 'boolean', description: 'true 返回完整元数据 JSON 而非 Markdown' },
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args) {
        const overrides = {
          maxRounds: args?.maxRounds,
          model: args?.model,
          baseUrl: args?.baseUrl,
          mockScenario: args?.mockScenario,
          ...(typeof args?.criticModel === 'string' && args.criticModel.trim()
            ? { criticModel: args.criticModel.trim() }
            : {}),
          ...(typeof args?.llmCritic === 'boolean' ? { llmCritic: args.llmCritic } : {}),
          ...(typeof args?.returnTranscript === 'boolean' ? { returnTranscript: args.returnTranscript } : {}),
        };
        for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete overrides[key];

        const effective = resolveConfig({
          ...baseConfig,
          ...overrides,
          ...(typeof args?.provider === 'string' ? { provider: args.provider } : {}),
        });
        // 用合并后的配置建 bridge：否则 maxTokens/model/baseUrl 这类单次覆盖到不了 provider
        const bridge = createBridge(effective, { ctx });
        if (bridge.fallbackNote) ctx.logger?.info?.(`[dsh-council] ${bridge.fallbackNote}`);

        // 评审独立性：没单独指定评审模型 = 自己评自己 → 把 LLM 权重从 0.6 降到 0.4
        const criticSeparate = Boolean(effective.criticProvider || effective.criticModel);
        const criticConfig = criticSeparate
          ? resolveConfig({
              ...effective,
              provider: effective.criticProvider || effective.provider,
              model: effective.criticModel || effective.model,
            })
          : effective;
        const criticBridge = criticSeparate ? createBridge(criticConfig, { ctx }) : bridge;
        const sameModel = !criticSeparate;
        const criticWeight = effective.llmCritic
          ? effective.criticIndependence === 'auto' && sameModel
            ? 0.4
            : 0.6
          : 0;
        const criticNote = !effective.llmCritic
          ? '未启用 LLM 评审，纯确定性评分（0.0 权重）'
          : sameModel
            ? `评审团与席位同源（${bridge.id}），LLM 权重降到 ${criticWeight}；配置 criticProvider/criticModel 可分离`
            : `评审团独立（${criticBridge.id}${effective.criticModel ? `/${effective.criticModel}` : ''}），LLM 权重 ${criticWeight}`;

        const result = await runCouncil({
          requirement: args?.requirement,
          config: effective,
          llm: bridge,
          criticLlm: criticBridge,
          criticWeight,
          criticNote: `${criticNote}｜匿名互评：${effective.anonymize ? '开' : '关'}`,
          onEvent: (type, payload) => {
            if (type === 'round/end') {
              ctx.logger?.info?.(
                `[dsh-council] 第 ${payload.round} 轮：质量 ${payload.quality}｜阻断 ${payload.openBlockers}｜${
                  payload.decision.stop ? `终止（${payload.decision.reason}）` : '继续'
                }`,
              );
            }
            if (type === 'agent/failed') ctx.logger?.warn?.(`[dsh-council] ${payload.id} 调用失败：${payload.error}`);
            if (type === 'chairman/failed') ctx.logger?.warn?.(`[dsh-council] 主席裁定失败：${payload.error}`);
          },
        });

        runs.push(result.meta);
        if (runs.length > 20) runs.shift();

        return args?.json ? JSON.stringify(result.meta, null, 2) : result.markdown;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'council_rules',
      description: '打印 dsh-council 的席位职责、三维评分口径、权重更新规则与熔断条件。写需求前先看一遍。',
      parameters: {
        json: { type: 'boolean', description: 'true 返回结构化 JSON' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute(args) {
        if (args?.json) {
          return JSON.stringify(
            {
              personas: PERSONAS,
              stopReasons: STOP_REASONS,
              defaults: {
                maxRounds: DEFAULTS.maxRounds,
                thresholds: DEFAULTS.thresholds,
                weights: DEFAULTS.weights,
                budget: DEFAULTS.budget,
              },
            },
            null,
            2,
          );
        }
        return describeRules();
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'council_score',
      description:
        '确定性评分（零模型）：给一段发言按相关性/可行性/经济性打分，返回分数、指标与是否驳回。' +
        '用来在调提示词时对齐口径，或在不跑整场辩论的情况下预检一段方案的成本。',
      parameters: {
        requirement: { type: 'string', description: '主任务需求' },
        statement: { type: 'string', description: '待评分的一段发言/方案' },
        persona: {
          type: 'string',
          enum: PERSONAS.map((p) => p.id),
          description: '按哪个席位的视角评分（影响阻断项抽取），默认 red_team',
        },
        json: { type: 'boolean', description: '默认就返回 JSON；此参数保留以保持一致性' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute(args) {
        const persona = PERSONAS.find((p) => p.id === (args?.persona ?? 'red_team')) ?? PERSONAS[1];
        const verdict = scoreStatement({
          text: args?.statement ?? '',
          requirement: args?.requirement ?? '',
          persona,
          config: baseConfig,
        });
        return JSON.stringify(
          {
            persona: persona.id,
            scores: verdict.scores,
            quality: verdict.quality,
            rejected: verdict.rejected,
            rejectReason: verdict.rejectReason,
            metrics: verdict.metrics,
            blockers: verdict.blockers,
          },
          null,
          2,
        );
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'council_status',
      description: '查看本会话内最近几次 council_debate 的运行元数据（轮次、终止原因、最终权重、token 估算）。',
      parameters: {
        limit: { type: 'number', description: '最多返回几条，默认 5' },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute(args) {
        const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5));
        const recent = runs.slice(-limit);
        if (recent.length === 0) return '本会话还没有运行记录。先调用 council_debate。';
        return recent
          .map((meta) =>
            [
              `${meta.runId}｜${meta.rounds} 轮｜${meta.stopLabel}｜质量 ${meta.quality}`,
              `  权重：${Object.entries(meta.weights ?? {})
                .map(([id, w]) => `${id} ${(w * 100).toFixed(0)}%`)
                .join(' / ')}`,
              `  token：约 ${meta.tokensSpent}｜provider=${meta.provider}${meta.transcriptFile ? `｜全文：${meta.transcriptFile}` : ''}`,
            ].join('\n'),
          )
          .join('\n');
      },
    }),
  );

  ctx.logger?.info?.(`[dsh-council] v${VERSION} loaded: 4 tools`);
}

export default { name, inject, apply };
