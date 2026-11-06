// dsh-council / critic.js —— 主工作流评分（TTD: 相关性 / 可行性 / 经济性）
//
// 两套评分器并存，这是刻意的：
//   - 确定性评分器（本文件）：零模型、可复现，负责兜底、负责回归测试、负责经济性红线。
//   - LLM 评审团：会读语义，但会飘、会编、会心软。所以 LLM 的分数只占 60%，
//     且「驳回」是取并集——任何一方判定超预算，这条建议本轮就废。
//
// 经济性是本系统的主开关：一个人一周起步不了的方案，质量分再高也压到红线以下。

import { clamp, round, coverage, hitsAny, countMatches, tokens, extractJson, stableHash } from './text.js';
import { buildCriticSystemPrompt, buildCriticUserPrompt } from './personas.js';

export const DIMENSIONS = ['relevance', 'feasibility', 'economy'];

export const DIMENSION_LABELS = {
  relevance: '相关性',
  feasibility: '可行性',
  economy: '经济性',
};

const RE_VAGUE = [/可能/g, /也许/g, /大概/g, /或许/g, /视情况/g, /看情况/g, /原则上/g, /基本可以/g, /再说/g, /后续考虑/g];
const RE_HOLLOW = [/赋能/g, /抓手/g, /闭环/g, /生态/g, /护城河/g, /颗粒度/g, /顶层设计/g, /全链路/g, /一体化/g, /维度升级/g, /组合拳/g, /共振/g];
const RE_HEAVY = [
  /从零(搭建|自研|手搓|实现|写)/g,
  /自研(框架|引擎|内核|中间件|数据库|协议)/g,
  /手搓/g,
  /重写整个/g,
  /(全部|整体)重写/g,
  /推倒重来/g,
  /另起炉灶/g,
  /自建(集群|机房|云)/g,
  /重写内核/g,
  /GTA\s*6|GTA6/gi,
];
const RE_SCALE = [/万行/g, /十万行/g, /百万行/g, /上百个(模块|微服务|服务)/g, /三到五年/g, /三五年/g, /全量迁移/g, /整体迁移/g];
const RE_REUSE = [/复用/g, /现有/g, /增量/g, /最小改动/g, /渐进/g, /原型/g, /\bPoC\b/gi, /灰度/g, /先用现成/g, /小步/g];
const RE_CONCRETE = [/实现/g, /落地/g, /拆解/g, /验证/g, /上线/g, /迁移/g, /替换/g, /封装/g, /压测/g, /埋点/g, /评审/g, /封板/g, /接口/g, /验收/g, /截断/g, /落盘/g];

const RE_BLOCKER_INLINE =
  /(?:^|\n)[ \t]*(?:[-*•]|\d+[.、)])?[ \t]*\[?[ \t]*P([0-3])[ \t]*\]?[ \t]*[：:.\-—]?[ \t]*([^\n]+)/g;
const RE_RESOLVED = /已解决|已修复|已关闭|已取消|不再阻断|已经解决/;

function structureLines(text) {
  return countMatches(text, [/^[-*]\s+/gm, /^\d+[.、)]\s+/gm, /[：:]/g]);
}

/** 重复度：词表去重后剩多少。水字数最典型的特征是一句话换个说法说三遍。 */
function repetitionOf(text) {
  const words = tokens(text);
  if (words.length < 20) return 0;
  const unique = new Set(words);
  return clamp(1 - unique.size / words.length, 0, 1);
}

/** 席位职责加分：只加在"该席位本来就该做的事"上，不能变成无脑送分。 */
function personaBonus(personaId, text, blockers) {
  let relevance = 0;
  let feasibility = 0;
  if (personaId === 'red_team') {
    if (blockers.length > 0) {
      relevance += 1.2;
      feasibility += 0.9;
    }
    if (/后果|触发条件/.test(text)) {
      relevance += 0.5;
      feasibility += 0.4;
    }
    if (/已解决|无新增阻断/.test(text)) {
      relevance += 1.2;
      feasibility += 0.8;
    }
  } else if (personaId === 'architect') {
    if (/结构|边界|扩展|成本|替代|复用/.test(text)) {
      relevance += 1.5;
      feasibility += 0.8;
    }
  } else if (personaId === 'product_manager') {
    if (/结论|验收|范围|不做/.test(text)) {
      relevance += 0.8;
      feasibility += 0.4;
    }
  }
  return { relevance, feasibility };
}

/** 抽取红队式阻断项：`[P0] 问题 → 后果 → 触发条件`。声明已解决的跳过。 */
export function extractBlockers(statement, personaId) {
  const text = String(statement ?? '');
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(RE_BLOCKER_INLINE)) {
    const claim = m[2].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!claim || RE_RESOLVED.test(claim)) continue;
    const id = claim.slice(0, 12);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, severity: `P${m[1]}`, claim, from: personaId });
  }
  return out;
}

/**
 * 确定性评分。
 * @param {object} input
 * @param {string} input.text 该席位本轮发言
 * @param {string} input.requirement 主任务需求
 * @param {{id: string, name: string}} input.persona
 * @param {ReturnType<import('./config.js').resolveConfig>} input.config
 */
export function scoreStatement({ text, requirement, persona, config }) {
  const body = String(text ?? '');
  const chars = body.length;
  // 相关性用「主任务词汇被发言覆盖了多少」来估（召回方向）：
  // 反过来算会把"没有复述需求"的好发言判成跑题。
  const cov = coverage(requirement, body);
  const drift = cov < config.thresholds.driftCoverage;

  const vague = countMatches(body, RE_VAGUE);
  const hollow = countMatches(body, RE_HOLLOW);
  const heavy = countMatches(body, RE_HEAVY);
  const scale = countMatches(body, RE_SCALE);
  const reuse = hitsAny(body, RE_REUSE);
  const concrete = countMatches(body, RE_CONCRETE);
  const numbers = countMatches(body, [/\d+(?:\.\d+)?/g]);
  const structure = structureLines(body);
  const repetition = repetitionOf(body);
  // 重复度 0.35 以下正常，0.85 以上判满
  const waterScore = clamp((repetition - 0.35) / 0.5, 0, 1);

  // 阻断项只从红队发言里抽：产品经理复述 "P0" 是在回应，不是新开一条阻断。
  const blockers = persona.id === 'red_team' ? extractBlockers(body, persona.id) : [];
  // 席位职责加分：红队给出结构化攻击、架构师给出结构判断，本身就是"相关且可执行"。
  // 不加这一项，短而准的专家发言会被长而完整的提案压分，评审团等于奖励啰嗦。
  const bonus = personaBonus(persona.id, body, blockers);

  const relevance = clamp(
    4.2 + 14 * cov + 0.5 * Math.min(numbers, 4) - 2.4 * Math.min(hollow, 6) - 3 * waterScore - (drift ? 2 : 0) + bonus.relevance,
    0,
    10,
  );

  const feasibility = clamp(
    2.8 +
      0.7 * Math.min(structure, 5) +
      0.45 * Math.min(concrete, 6) +
      0.25 * Math.min(numbers, 6) -
      1.0 * vague -
      1.0 * waterScore +
      bonus.feasibility,
    0,
    10,
  );

  const lengthPenalty = Math.min(3, Math.max(0, (chars - config.water.waterChars) / 600));
  const economy = clamp(
    7.4 - 3.4 * heavy - 2.2 * scale + 0.6 * Math.min(reuse, 2) + (concrete >= 2 ? 0.2 : 0) - lengthPenalty - 1.5 * waterScore,
    0,
    10,
  );

  const overWater = Math.max(0, chars - config.water.waterChars);
  const verbosity = Math.min(3, overWater / 500);

  const quality = clamp(
    0.4 * relevance +
      0.3 * feasibility +
      0.3 * economy -
      0.6 * verbosity -
      (drift ? 1.5 : 0) -
      1.5 * waterScore -
      // 空话直接扣综合分：相关性已经被下限截断，不在这里再罚一次水字数就"零成本"了
      0.55 * Math.min(hollow, 8),
    0,
    10,
  );

  const rejected = economy < config.thresholds.economyReject;

  return {
    id: persona.id,
    name: persona.name,
    scores: { relevance: round(relevance), feasibility: round(feasibility), economy: round(economy) },
    quality: round(quality),
    rejected,
    rejectReason: rejected
      ? `经济性 ${round(economy)} < 红线 ${config.thresholds.economyReject}（成本超预算）`
      : null,
    metrics: {
      chars,
      coverage: round(cov, 3),
      structure,
      numbers,
      vague,
      hollow,
      heavy,
      scale,
      reuse,
      concrete,
      repetition: round(repetition, 2),
      waterScore: round(waterScore, 2),
      verbosity: round(verbosity),
    },
    blockers,
    source: 'heuristic',
  };
}

/** 把 LLM 的评分与确定性评分合并：LLM 60%，确定性 40%，驳回取并集。 */
export function mergeVerdict(heuristic, llm, config, llmWeight = 0.6) {
  if (!llm) return heuristic;
  const w = clamp(Number.isFinite(llmWeight) ? llmWeight : 0.6, 0, 1);
  const pick = (dim) => {
    const value = Number(llm[dim]);
    if (!Number.isFinite(value)) return heuristic.scores[dim];
    return clamp(w * clamp(value, 0, 10) + (1 - w) * heuristic.scores[dim], 0, 10);
  };
  const scores = {
    relevance: round(pick('relevance')),
    feasibility: round(pick('feasibility')),
    economy: round(pick('economy')),
  };
  const rejected = Boolean(llm.rejected) || heuristic.rejected || scores.economy < config.thresholds.economyReject;
  const { waterScore } = heuristic.metrics;
  const quality = round(
    clamp(0.4 * scores.relevance + 0.3 * scores.feasibility + 0.3 * scores.economy - 0.6 * heuristic.metrics.verbosity - 1.5 * waterScore, 0, 10),
  );
  return {
    ...heuristic,
    scores,
    quality,
    rejected,
    rejectReason: rejected
      ? llm.rejected
        ? `评审团驳回：${String(llm.notes ?? '超预算/不可执行').slice(0, 60)}`
        : heuristic.rejectReason
      : null,
    source: 'llm+heuristic',
    llmNotes: typeof llm.notes === 'string' ? llm.notes.slice(0, 80) : undefined,
  };
}

/**
 * 汇总本轮：加权质量分、离散度、未解决阻断项、是否达成共识。
 */
export function summarizeRound({ verdicts, weights, carriedBlockers = [], config, llmFlags = {} }) {
  const totalWeight = verdicts.reduce((n, v) => n + (weights[v.id] ?? 0), 0) || 1;
  const weightedQuality = verdicts.reduce((n, v) => n + (weights[v.id] ?? 0) * v.quality, 0) / totalWeight;
  const spread =
    verdicts.reduce((n, v) => n + (weights[v.id] ?? 0) * Math.abs(v.quality - weightedQuality), 0) / totalWeight;

  // 只把"本轮明确声明已解决、且指向同一条问题"的阻断项判为关闭。
  // 用词重合度判定指向关系：模型不会原样复述上轮措辞，硬比对必然漏判。
  const resolvedLines = verdicts
    .flatMap((v) => String(v.text ?? '').split(/\n/))
    .filter((line) => RE_RESOLVED.test(line));
  const resolvedIds = new Set();
  for (const blocker of carriedBlockers) {
    const claimTokens = new Set(tokens(blocker.claim));
    for (const line of resolvedLines) {
      const shared = new Set(tokens(line).filter((t) => claimTokens.has(t))).size;
      if (shared >= 2) {
        resolvedIds.add(blocker.id);
        break;
      }
    }
  }

  const fresh = verdicts.flatMap((v) => v.blockers ?? []);
  const merged = new Map();
  for (const blocker of [...carriedBlockers, ...fresh]) merged.set(blocker.id, blocker);
  const openBlockers = [...merged.values()].filter(
    (blocker) => !resolvedIds.has(blocker.id) && (blocker.severity === 'P0' || blocker.severity === 'P1'),
  );

  const rejectedCount = verdicts.filter((v) => v.rejected).length;
  const consensus =
    weightedQuality >= config.thresholds.consensusQuality &&
    spread <= config.thresholds.consensusSpread &&
    openBlockers.length === 0 &&
    rejectedCount === 0;

  const optimal =
    Boolean(llmFlags.optimal) ||
    (weightedQuality >= config.thresholds.optimalQuality && openBlockers.length === 0 && rejectedCount === 0);

  return {
    weightedQuality: round(weightedQuality),
    spread: round(spread),
    openBlockers,
    resolvedBlockers: [...resolvedIds],
    rejectedCount,
    consensus: Boolean(llmFlags.consensus) || consensus,
    optimal,
    allRejected: rejectedCount === verdicts.length && verdicts.length > 0,
  };
}

/**
 * 匿名化：把席位名换成 A/B/C，顺序按 (轮次, 需求, 席位) 确定性洗牌。
 *
 * 借鉴 karpathy/llm-council 的 stage 2：评审者不知道自己评的是谁，才不会对某个角色
 * 有先验偏好（也不会因为"这是红队说的"就自动给高分）。洗牌确定性是为了可复现。
 *
 * @returns {{entries: {label: string, text: string, weight: number}[], decode: Map<string, string>, encode: Map<string, string>}}
 */
export function anonymizeStatements(statements, weights, { round, requirement, enabled = true }) {
  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  const ordered = [...statements].sort((a, b) => {
    const ha = stableHash(`${round}|${requirement}|${a.persona.id}`);
    const hb = stableHash(`${round}|${requirement}|${b.persona.id}`);
    return ha - hb;
  });
  const decode = new Map();
  const encode = new Map();
  const entries = ordered.map((statement, i) => {
    const label = enabled ? labels[i] ?? `S${i + 1}` : statement.persona.id;
    decode.set(label, statement.persona.id);
    encode.set(statement.persona.id, label);
    return { label, text: statement.text, weight: weights[statement.persona.id] ?? 0 };
  });
  return { entries, decode, encode };
}

/**
 * 一轮完整评审：确定性评分 →（可选）LLM 评审 → 合并 → 汇总。
 *
 * @param {object} input
 * @param {number} [input.llmWeight] LLM 评审的融合权重（默认 0.6；评审团与席位同模型时会被调到 0.4）
 * @param {boolean} [input.anonymize] 是否匿名互评（默认取 config.anonymize）
 */
export async function evaluateRound({
  round,
  requirement,
  statements,
  weights,
  carriedBlockers = [],
  config,
  llm,
  llmWeight = 0.6,
  anonymize = config?.anonymize !== false,
  onEvent,
}) {
  const verdicts = statements.map((statement) => {
    const verdict = scoreStatement({ text: statement.text, requirement, persona: statement.persona, config });
    verdict.text = statement.text;
    return verdict;
  });

  let llmFlags = {};
  let source = 'heuristic';
  let anonymized = false;

  if (config.llmCritic && llm && typeof llm.complete === 'function') {
    try {
      const { entries, decode } = anonymizeStatements(statements, weights, { round, requirement, enabled: anonymize });
      anonymized = anonymize;
      const response = await llm.complete({
        purpose: 'critic',
        system: buildCriticSystemPrompt(),
        messages: [{ role: 'user', content: buildCriticUserPrompt({ requirement, round, entries }) }],
        maxTokens: Math.min(900, config.budget.perAgentTokens + 200),
        temperature: 0,
      });
      const parsed = extractJson(response?.text ?? '');
      const fresh = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
      if (fresh.length > 0) {
        const byId = new Map(
          fresh.map((v) => {
            const raw = String(v?.id ?? v?.agent ?? '').trim();
            return [decode.get(raw) ?? raw, v];
          }),
        );
        let merged = 0;
        for (const verdict of verdicts) {
          const llmVerdict = byId.get(verdict.id);
          if (!llmVerdict) continue;
          Object.assign(verdict, mergeVerdict(verdict, llmVerdict, config, llmWeight));
          merged += 1;
        }
        if (merged > 0) source = llmWeight < 0.6 ? `llm+heuristic(${llmWeight})` : 'llm+heuristic';
        llmFlags = { consensus: parsed?.consensus === true, optimal: parsed?.optimal === true };
        if (Array.isArray(parsed?.blockers)) {
          const seen = new Set(verdicts.flatMap((v) => (v.blockers ?? []).map((b) => b.id)));
          for (const raw of parsed.blockers) {
            const claim = String(raw?.claim ?? '').trim().slice(0, 80);
            if (!claim) continue;
            const id = claim.slice(0, 12);
            if (seen.has(id)) continue;
            seen.add(id);
            const severity = /^p[0-3]$/i.test(String(raw?.severity)) ? String(raw.severity).toUpperCase() : 'P1';
            verdicts[0]?.blockers.push({ id, severity, claim, from: 'critic' });
          }
        }
      }
    } catch (error) {
      onEvent?.('critic/fallback', { round, error: String(error?.message ?? error) });
    }
  }

  const summary = summarizeRound({ verdicts, weights, carriedBlockers, config, llmFlags });
  return { round, verdicts, summary, source, anonymized };
}
