// dsh-quorum / config.js —— 配置默认值与归一化
//
// 设计原则：所有阈值都可被调用方逐字段覆盖，且归一化后一定是「能跑出结果」的合法值。
// 配置错了不抛异常，而是夹到安全区间并在 warnings 里记账——评审系统不该因为一个
// 画错的数字就整场罢工。

export const PROVIDERS = ['auto', 'mock', 'http', 'harness'];

export const DEFAULTS = {
  /** 'auto' = 有 baseUrl/apiKey 走 http，ctx.llm 可用走 harness，否则 mock */
  provider: 'auto',
  model: '',
  baseUrl: '',
  apiKey: '',
  apiKeyEnv: 'DSH_QUORUM_API_KEY',
  timeoutMs: 60_000,
  retries: 1,

  /** 熔断：硬上限 3 轮 */
  maxRounds: 3,
  earlyStop: true,

  weights: {
    /** 初始权重（均分）；n 个席位时按 1/n 归一 */
    eta: 0.9, // Hedge 学习率：该轮掉分对权重的惩罚强度
    min: 0.08, // 权重下限：再差也保留发言资格
    max: 0.6, // 权重上限：再强也不能一个人说了算
    rejectFactor: 0.45, // 被经济性驳回时的额外折扣
    harshQuality: 3.0, // 质量低于该值视为"水字数/跑题"，叠加惩罚
    harshFactor: 0.5,
    silentShrink: 0.5, // 本轮未发言者向均分回归的比例
  },

  thresholds: {
    /** 达成共识：加权质量分下限 */
    consensusQuality: 6.8,
    /** 达成共识：加权离散度上限（分差，越小越一致） */
    consensusSpread: 1.6,
    /** 最优解判定（提前终止的第二条件） */
    optimalQuality: 8.2,
    /** 经济性红线：低于它直接驳回该建议 */
    economyReject: 3.0,
    /** 权重低于「均分 × 该比例」→ 下一轮静默（省 Token） */
    muteRatio: 0.55,
    /** 连续两轮质量提升小于该值 → 判定无进展，提前收敛 */
    noProgressDelta: 0.15,
    /** 跑题判定：发言对主任务词汇的覆盖低于该值（只扣分，不直接驳回） */
    driftCoverage: 0.02,
  },

  budget: {
    /** 单个 Agent 单轮的基准输出上限（token） */
    perAgentTokens: 700,
    minTokens: 220,
    maxTokens: 1400,
    /** 整场辩论的输出总量红线（token 估算） */
    totalTokens: 9_000,
  },

  /**
   * 水字数判据：超过 waterChars 开始扣分，每多 500 字再扣一档。
   * 中文字符≈token，这里只做量级控制，不做精确计费。
   */
  water: {
    waterChars: 1200,
    hardChars: 2400,
  },

  report: {
    /** 回传主工作流的 Markdown 硬上限（字符） */
    maxChars: 6_000,
    /** 允许进入摘要的最长原文引用（防止全文回灌） */
    quoteChars: 36,
  },

  /** 需求本身也会被截断，防止一次把上下文喂爆 */
  maxRequirementChars: 4_000,

  /** 调试：把辩论全文写到 DSH_HOME/quorum/runs/<id>.json（绝不回传上下文） */
  returnTranscript: false,

  /** mock provider 的剧本：auto | converge-r2 | converge-r3 | never | water | overbudget */
  mockScenario: 'auto',

  /** 是否让主工作流（Critic）也走 LLM；false 则用确定性评分表 */
  llmCritic: true,

  /**
   * 匿名互评：送给评审团的发言不署名，只给「席位 A/B/C」（每轮确定性洗牌）。
   * 借鉴 karpathy/llm-council 的匿名化评审——防止评审团对某个席位有先验偏好。
   */
  anonymize: true,

  /** 评审团独立模型：留空则沿用席位模型；填了就是「任务模型 ≠ 评审模型」 */
  criticProvider: '',
  criticModel: '',

  /**
   * 评审独立性策略：
   *   auto —— 评审团与席位同模型时，把 LLM 评审的权重从 0.6 降到 0.4（自评偏好补偿）
   *   off  —— 不管是不是同模型，都用 0.6
   */
  criticIndependence: 'auto',

  /**
   * 主席裁定：所有轮次结束后，再让一个模型把结构化结论写成一段执行摘要。
   *   auto —— 非 mock provider 时启用
   *   on / off —— 强制开关
   * 借鉴 karpathy/llm-council 的 chairman 阶段与 fufengyuan/dsh-council 的「主席」设定。
   */
  chairman: 'auto',
  chairmanMaxChars: 600,
};

const num = (value, fallback, min, max) => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const str = (value, fallback, maxLen = 400) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed.slice(0, maxLen);
};

/**
 * 归一化配置。
 * @param {Record<string, unknown>} [input] 调用方传入的局部覆盖。
 * @returns {typeof DEFAULTS & { warnings: string[] }}
 */
export function resolveConfig(input = {}) {
  const warnings = [];
  const src = input && typeof input === 'object' ? input : {};

  const providerRaw = str(src.provider, DEFAULTS.provider, 32);
  const provider = PROVIDERS.includes(providerRaw) ? providerRaw : 'auto';
  if (provider !== providerRaw) warnings.push(`未知 provider「${providerRaw}」已回退 auto`);

  const maxRounds = Math.round(num(src.maxRounds, DEFAULTS.maxRounds, 1, 3));
  if (Number(src.maxRounds) > 3) warnings.push('maxRounds 上限 3 轮（熔断硬约束），已夹到 3');

  const weightsInput = { ...DEFAULTS.weights, ...(src.weights ?? {}) };
  let min = num(weightsInput.min, DEFAULTS.weights.min, 0.01, 0.34);
  let max = num(weightsInput.max, DEFAULTS.weights.max, 0.34, 0.95);
  if (min > max) {
    warnings.push('weights.min > weights.max，已交换');
    [min, max] = [max, min];
  }
  if (min * 3 > 1) {
    min = 1 / 3 - 1e-6;
    warnings.push('weights.min 过大（3 席无法同时满足下限），已下调');
  }

  const cfg = {
    ...DEFAULTS,
    provider,
    model: str(src.model, DEFAULTS.model, 200),
    baseUrl: str(src.baseUrl, DEFAULTS.baseUrl, 500),
    apiKey: str(src.apiKey, DEFAULTS.apiKey, 500),
    apiKeyEnv: str(src.apiKeyEnv, DEFAULTS.apiKeyEnv, 100),
    timeoutMs: Math.round(num(src.timeoutMs, DEFAULTS.timeoutMs, 5_000, 300_000)),
    retries: Math.round(num(src.retries, DEFAULTS.retries, 0, 3)),

    maxRounds,
    earlyStop: bool(src.earlyStop, DEFAULTS.earlyStop),

    weights: {
      eta: num(weightsInput.eta, DEFAULTS.weights.eta, 0, 3),
      min,
      max,
      rejectFactor: num(weightsInput.rejectFactor, DEFAULTS.weights.rejectFactor, 0.05, 1),
      harshQuality: num(weightsInput.harshQuality, DEFAULTS.weights.harshQuality, 0, 10),
      harshFactor: num(weightsInput.harshFactor, DEFAULTS.weights.harshFactor, 0.05, 1),
      silentShrink: num(weightsInput.silentShrink, DEFAULTS.weights.silentShrink, 0, 1),
    },

    thresholds: {
      consensusQuality: num(src.thresholds?.consensusQuality, DEFAULTS.thresholds.consensusQuality, 0, 10),
      consensusSpread: num(src.thresholds?.consensusSpread, DEFAULTS.thresholds.consensusSpread, 0, 10),
      optimalQuality: num(src.thresholds?.optimalQuality, DEFAULTS.thresholds.optimalQuality, 0, 10),
      economyReject: num(src.thresholds?.economyReject, DEFAULTS.thresholds.economyReject, 0, 10),
      muteRatio: num(src.thresholds?.muteRatio, DEFAULTS.thresholds.muteRatio, 0.2, 1),
      noProgressDelta: num(src.thresholds?.noProgressDelta, DEFAULTS.thresholds.noProgressDelta, 0, 5),
      driftCoverage: num(src.thresholds?.driftCoverage, DEFAULTS.thresholds.driftCoverage, 0, 1),
    },

    budget: {
      perAgentTokens: Math.round(num(src.budget?.perAgentTokens, DEFAULTS.budget.perAgentTokens, 120, 4_000)),
      minTokens: Math.round(num(src.budget?.minTokens, DEFAULTS.budget.minTokens, 80, 2_000)),
      maxTokens: Math.round(num(src.budget?.maxTokens, DEFAULTS.budget.maxTokens, 200, 8_000)),
      totalTokens: Math.round(num(src.budget?.totalTokens, DEFAULTS.budget.totalTokens, 1_000, 200_000)),
    },

    water: {
      waterChars: Math.round(num(src.water?.waterChars, DEFAULTS.water.waterChars, 200, 20_000)),
      hardChars: Math.round(num(src.water?.hardChars, DEFAULTS.water.hardChars, 300, 40_000)),
    },

    report: {
      maxChars: Math.round(num(src.report?.maxChars, DEFAULTS.report.maxChars, 800, 20_000)),
      quoteChars: Math.round(num(src.report?.quoteChars, DEFAULTS.report.quoteChars, 10, 120)),
    },

    maxRequirementChars: Math.round(num(src.maxRequirementChars, DEFAULTS.maxRequirementChars, 200, 20_000)),
    returnTranscript: bool(src.returnTranscript, DEFAULTS.returnTranscript),
    mockScenario: str(src.mockScenario, DEFAULTS.mockScenario, 40),
    llmCritic: bool(src.llmCritic, DEFAULTS.llmCritic),
    anonymize: bool(src.anonymize, DEFAULTS.anonymize),
    criticProvider: str(src.criticProvider, DEFAULTS.criticProvider, 32),
    criticModel: str(src.criticModel, DEFAULTS.criticModel, 200),
    criticIndependence: ['auto', 'off'].includes(str(src.criticIndependence, 'auto', 8))
      ? str(src.criticIndependence, 'auto', 8)
      : 'auto',
    chairman: ['auto', 'on', 'off'].includes(str(src.chairman, 'auto', 8)) ? str(src.chairman, 'auto', 8) : 'auto',
    chairmanMaxChars: Math.round(num(src.chairmanMaxChars, DEFAULTS.chairmanMaxChars, 120, 3_000)),
    warnings,
  };

  if (cfg.budget.minTokens > cfg.budget.perAgentTokens) {
    cfg.budget.minTokens = cfg.budget.perAgentTokens;
    cfg.warnings.push('budget.minTokens > perAgentTokens，已对齐');
  }
  if (cfg.budget.perAgentTokens > cfg.budget.maxTokens) {
    cfg.budget.perAgentTokens = cfg.budget.maxTokens;
    cfg.warnings.push('budget.perAgentTokens > maxTokens，已对齐');
  }
  return cfg;
}
