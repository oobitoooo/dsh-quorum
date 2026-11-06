// dsh-council / llm/bridge.js —— provider 选择与统一调用契约
//
// 契约只有一个方法：
//   complete({ purpose, system, messages, maxTokens, temperature, signal }) -> { text, usage }
//
// 三个实现：
//   mock    确定性剧本，零依赖，测试与离线演示用
//   http    任意 OpenAI 兼容端点（真实生产路径）
//   harness 复用宿主的 ctx.llm（当前版本是探测式接入；宿主未暴露兼容方法时自动让位）

import { createMockProvider } from './mock.js';
import { createHttpProvider, CouncilLlmError } from './openai-compatible.js';

export { CouncilLlmError };

function harnessProvider(ctx) {
  const llm = ctx?.llm;
  // 只认最朴素的鸭子类型：宿主版本差异大，硬绑具体方法名只会让插件在升级后静默失效
  const complete = llm?.complete?.bind(llm) ?? llm?.chat?.bind(llm);
  if (typeof complete !== 'function') return null;
  return {
    id: 'harness',
    async complete(request) {
      const result = await complete({
        system: request.system,
        messages: request.messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      });
      const text = typeof result === 'string' ? result : result?.text ?? result?.content ?? '';
      if (!String(text).trim()) throw new CouncilLlmError('ctx.llm 返回空内容');
      return { text: String(text), usage: result?.usage ?? {} };
    },
    info() {
      return { id: 'harness' };
    },
  };
}

/**
 * 按配置挑一个 provider。
 * @param {ReturnType<import('../config.js').resolveConfig>} config
 * @param {{ctx?: object, explicit?: string}} [options]
 * @returns {{id: string, complete: Function, info: Function, fallbackNote?: string}}
 */
export function createBridge(config, options = {}) {
  const requested = options.explicit ?? config.provider;

  const buildHarness = () => harnessProvider(options.ctx);
  const buildHttp = () => createHttpProvider({ config });

  const pick = (name) => {
    if (name === 'mock') return createMockProvider({ config });
    if (name === 'http') return buildHttp();
    if (name === 'harness') {
      const provider = buildHarness();
      if (provider) return provider;
      throw new CouncilLlmError('harness provider 需要宿主暴露 ctx.llm.complete；请改用 provider=http');
    }
    throw new CouncilLlmError(`未知 provider：${name}`);
  };

  if (requested !== 'auto') {
    const provider = pick(requested);
    provider.fallbackNote = undefined;
    return provider;
  }

  const apiKey = config.apiKey || process.env[config.apiKeyEnv] || '';
  if (config.baseUrl && apiKey) return pick('http');
  const harness = buildHarness();
  if (harness) {
    harness.fallbackNote = config.baseUrl ? 'baseUrl 已配置但缺少 API key，已回退 harness' : undefined;
    return harness;
  }
  const mock = pick('mock');
  mock.fallbackNote = config.baseUrl
    ? 'baseUrl 已配置但缺少 API key，已回退 mock'
    : '未配置 baseUrl/apiKey，使用 mock 剧本（离线可跑）';
  return mock;
}
