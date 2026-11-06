// dsh-quorum / translate.js —— 辩论过程翻译
//
// 两种引擎：
//   llm      —— 有真实模型时，逐轮逐席翻译（保留 P0/P1 标记、数字、席位名）
//   glossary —— 没有模型（mock/离线）时，只做术语替换，并明确标注"不是机器翻译"
//
// 刻意不假装：glossary 引擎会在结果顶部写清楚它没做翻译，避免把半成品当中文/英文译文用。

export const TARGETS = ['en', 'zh'];

const GLOSSARY = [
  ['产品经理', 'ProductManager'],
  ['架构师', 'Architect'],
  ['红队', 'RedTeam'],
  ['评审团', 'critic panel'],
  ['虚拟内阁', 'virtual cabinet'],
  ['席位', 'seat'],
  ['权重', 'weight'],
  ['质量', 'quality'],
  ['相关性', 'relevance'],
  ['可行性', 'feasibility'],
  ['经济性', 'economy'],
  ['阻断', 'blocker'],
  ['驳回', 'rejected'],
  ['共识', 'consensus'],
  ['熔断', 'circuit breaker'],
  ['需求', 'requirement'],
  ['验收', 'acceptance'],
  ['范围', 'scope'],
  ['超预算', 'over budget'],
  ['上下文', 'context'],
  ['沙箱', 'sandbox'],
  ['摘要', 'summary'],
  ['下一步', 'next step'],
];

const TARGET_LABEL = { en: '英文', zh: '中文' };

function buildTranscriptMarkdown(transcript) {
  const lines = [];
  for (const round of transcript) {
    lines.push(`### 第 ${round.round} 轮`, '');
    for (const statement of round.statements) {
      const s = statement.scores ?? {};
      lines.push(
        `**${statement.name}**（相关性 ${s.relevance} / 可行性 ${s.feasibility} / 经济性 ${s.economy}，综合 ${statement.quality}）`,
      );
      lines.push('');
      lines.push(statement.text);
      lines.push('');
    }
    if (round.summary?.openBlockers?.length) {
      lines.push('未解决阻断：');
      for (const b of round.summary.openBlockers) lines.push(`- [${b.severity}] ${b.claim}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function glossaryTranslate(markdown, target) {
  if (target !== 'en') {
    return {
      text: `> 源文本已经是中文，无需翻译。\n\n${markdown}`,
      engine: 'glossary',
      note: '未配置 LLM；且目标语言为中文，原样返回',
    };
  }
  const dictionary = new Map(GLOSSARY);
  let out = markdown;
  for (const [zh, en] of dictionary) out = out.split(zh).join(`${en}（${zh}）`);
  const header = [
    '> ⚠️ 离线术语替换，不是机器翻译：未配置真实模型（当前 provider=mock），',
    '> 只对常见术语做了「英文（中文）」标注，正文仍是中文。配置 `baseUrl` + key 后这里会走真模型翻译。',
    '',
  ].join('\n');
  return { text: `${header}\n${out}`, engine: 'glossary', note: '未配置 LLM，已回退术语表' };
}

/**
 * 翻译一场辩论的过程记录。
 *
 * @param {object} input
 * @param {Array} input.transcript runQuorum(capture: true) 产出的逐轮记录
 * @param {string} input.requirement 原始需求（给模型做上下文）
 * @param {'en'|'zh'} input.target
 * @param {{id: string, complete: Function}} [input.llm] 翻译用的 provider
 * @param {number} [input.maxChars]
 * @returns {Promise<{text: string, engine: 'llm'|'glossary', note?: string}>}
 */
export async function translateProcess({ transcript, requirement = '', target = 'en', llm, maxChars = 12_000 }) {
  if (!TARGETS.includes(target)) throw new Error(`不支持的目标语言：${target}`);
  if (!Array.isArray(transcript) || transcript.length === 0) throw new Error('没有可翻译的辩论记录');

  const markdown = buildTranscriptMarkdown(transcript);

  const canUseLlm = llm && typeof llm.complete === 'function' && llm.id !== 'mock';
  if (!canUseLlm) {
    const fallback = glossaryTranslate(markdown, target);
    return { ...fallback, text: fallback.text.slice(0, maxChars) };
  }

  try {
    const response = await llm.complete({
      purpose: 'translate',
      system: [
        `你是严谨的技术翻译。把给定的辩论记录翻译成${TARGET_LABEL[target]}。`,
        '规则：',
        '- 保留 P0/P1/P2 标记、数字、百分比、代码标识符、席位名原样。',
        '- 不要总结、不要合并段落、不要增删内容。',
        '- 输出 Markdown，保持每轮每席的层级。',
        '- 只输出译文，不要任何前言。',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: `主任务需求（仅供上下文）：${requirement}\n\n待翻译的辩论记录：\n\n${markdown}`,
        },
      ],
      maxTokens: Math.min(4000, Math.ceil(markdown.length * 1.6)),
      temperature: 0.1,
    });
    const text = String(response?.text ?? '').trim();
    if (!text) throw new Error('模型返回空翻译');
    return { text: text.slice(0, maxChars), engine: 'llm' };
  } catch (error) {
    const fallback = glossaryTranslate(markdown, target);
    return {
      ...fallback,
      text: fallback.text.slice(0, maxChars),
      note: `模型翻译失败，已回退术语表：${String(error?.message ?? error)}`,
    };
  }
}
