// dsh-council / llm/openai-compatible.js —— 任意 OpenAI 兼容端点
//
// 只要能回 /chat/completions 就能接：官方 API、中转站、本地 vLLM / Ollama 的兼容层都行。
// 刻意不用任何 SDK：插件不该把宿主拖进依赖地狱，fetch 在 Node 18+ 是内置的。

export class CouncilLlmError extends Error {
  constructor(message, { status, retryable = false, detail } = {}) {
    super(message);
    this.name = 'CouncilLlmError';
    this.code = 'COUNCIL_LLM_ERROR';
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeBase(baseUrl) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new CouncilLlmError('缺少 baseUrl（形如 https://api.example.com/v1）');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function extractText(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  return '';
}

/**
 * @param {object} options
 * @param {ReturnType<import('../config.js').resolveConfig>} options.config
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createHttpProvider({ config, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') {
    throw new CouncilLlmError('当前运行时没有 fetch，http provider 不可用');
  }
  const apiKey = config.apiKey || process.env[config.apiKeyEnv] || '';
  const url = normalizeBase(config.baseUrl);
  const model = config.model || 'deepseek-chat';

  async function once({ system, messages, maxTokens, temperature, signal }) {
    const body = {
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      max_tokens: Math.max(64, Math.round(maxTokens ?? 700)),
      temperature: typeof temperature === 'number' ? temperature : 0.3,
      stream: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new CouncilLlmError(`上游返回 ${response.status}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          detail: text.slice(0, 400),
        });
      }

      const payload = await response.json();
      const text = extractText(payload);
      if (!text.trim()) throw new CouncilLlmError('上游返回空内容', { retryable: true });
      return {
        text,
        usage: {
          input: payload?.usage?.prompt_tokens ?? 0,
          output: payload?.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      if (error instanceof CouncilLlmError) throw error;
      if (error?.name === 'AbortError') {
        throw new CouncilLlmError(`请求超时（${config.timeoutMs}ms）`, { retryable: true });
      }
      throw new CouncilLlmError(`请求失败：${String(error?.message ?? error)}`, { retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  return {
    id: 'http',
    async complete(request) {
      let lastError;
      for (let attempt = 0; attempt <= config.retries; attempt++) {
        try {
          return await once(request);
        } catch (error) {
          lastError = error;
          if (!error?.retryable || attempt === config.retries) break;
          await sleep(300 * (attempt + 1));
        }
      }
      throw lastError;
    },
    info() {
      return { id: 'http', url, model, hasKey: Boolean(apiKey) };
    },
  };
}
