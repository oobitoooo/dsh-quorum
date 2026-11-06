// dsh-quorum / orchestrator.js —— 内阁编排：沙箱 → 辩论 → 评分 → 调权 → 熔断 → 摘要
//
// 一次 runQuorum() 的生命周期：
//   1. 建沙箱（三席各一个独立上下文），写入各自 system prompt
//   2. 每轮：按权重排序 → 静默低权席位 → 逐席生成（并行）→ 各自写回自己的上下文
//   3. 评审团对本轮所有发言打分（相关性/可行性/经济性）→ 汇总阻断项
//   4. Hedge 调权 → 熔断判定（共识/最优/无进展/预算/轮次上限）
//   5. 只把 buildReport 的 Markdown 交出去；全文（如开启）落盘，绝不回上下文

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveConfig } from './config.js';
import { PERSONAS, buildSystemPrompt, buildChairmanSystemPrompt, buildChairmanUserPrompt } from './personas.js';
import { QuorumSandbox } from './sandbox.js';
import { evaluateRound } from './critic.js';
import { initialWeights, updateWeights, speakingOrder, tokenBudgetFor } from './weights.js';
import { decideStop, STOP_REASONS } from './breaker.js';
import { buildReport, collectNextSteps } from './report.js';
import { estimateTokens, truncate, oneLine } from './text.js';

export class QuorumRunError extends Error {
  constructor(message, { code = 'QUORUM_RUN_ERROR', detail } = {}) {
    super(message);
    this.name = 'QuorumRunError';
    this.code = code;
    this.detail = detail;
  }
}

function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `quorum-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function dshHome() {
  const fromEnv = (process.env.DSH_HOME ?? '').trim();
  return fromEnv || path.join(os.homedir(), '.dsh');
}

/** 轮次简报：只有这张卡片会进入某个席位的上下文，其余席位全文不进。 */
function buildRelay({ persona, round, requirement, personaIds, statements, verdicts, openBlockers, weights, muted, config }) {
  const mine = verdicts.find((v) => v.id === persona.id);
  const lines = [`【第 ${round}/${config.maxRounds} 轮 · 主任务】${requirement}`, ''];

  if (mine) {
    const s = mine.scores;
    lines.push(
      `【你上一轮的评分】相关性 ${s.relevance} / 可行性 ${s.feasibility} / 经济性 ${s.economy}｜综合 ${mine.quality}` +
        (mine.rejectReason ? `｜被驳回：${mine.rejectReason}` : ''),
    );
    if (mine.llmNotes) lines.push(`【评审团点评】${mine.llmNotes}`);
    lines.push('');
  }

  if (openBlockers.length > 0) {
    lines.push('【未解决阻断项】');
    for (const blocker of openBlockers.slice(0, 4)) lines.push(`- [${blocker.severity}] ${blocker.claim}`);
    lines.push('');
  }

  const others = statements.filter((s) => s.persona.id !== persona.id);
  if (others.length > 0) {
    lines.push('【其他席位要点（截断）】');
    for (const statement of others) {
      lines.push(`- ${statement.persona.name}: ${truncate(statement.text.replace(/\s+/g, ' '), 110)}`);
    }
    lines.push('');
  }

  lines.push(
    `【权重现状】${personaIds
      .map((id) => `${id}=${((weights[id] ?? 0) * 100).toFixed(0)}%`)
      .join(' / ')}${muted.length ? `｜本轮静默：${muted.join(', ')}` : ''}`,
  );
  lines.push(
    round === 1
      ? '【本轮要求】给出你的第一版判断，控制在规定行数内，不要复述需求。'
      : '【本轮要求】针对上面的阻断项逐条回应（解决或明确不接受并给理由），不要重复已通过的结论。',
  );

  const text = lines.join('\n');
  return truncate(text, config.maxRequirementChars);
}

async function persistTranscript({ runId, sandbox, meta, config, onEvent }) {
  if (!config.returnTranscript) return null;
  try {
    const dir = path.join(dshHome(), 'quorum', 'runs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${runId}.json`);
    fs.writeFileSync(file, JSON.stringify({ meta, transcript: sandbox.transcript() }, null, 2), 'utf8');
    return file;
  } catch (error) {
    onEvent?.('transcript/persist-failed', { error: String(error?.message ?? error) });
    return null;
  }
}

/**
 * 主席裁定：把结构化结论收敛成一段执行摘要。
 * 借鉴 karpathy/llm-council 的 chairman 阶段；输入刻意只给结构化材料，不给全文。
 *
 * @returns {Promise<{text: string|null, error?: string}>}
 */
async function runChairman({ llm, requirement, rounds, summary, config, onEvent }) {
  if (!llm || typeof llm.complete !== 'function') return { text: null, error: 'no-provider' };
  const latest = rounds.at(-1);
  const verdictLines = (latest?.verdicts ?? []).map(
    (v) =>
      `- ${v.name}：相关性 ${v.scores.relevance}／可行性 ${v.scores.feasibility}／经济性 ${v.scores.economy}，综合 ${v.quality}` +
      (v.rejected ? '（被驳回）' : ''),
  );
  const blockers = summary.openBlockers.map((b) => ({ severity: b.severity, claim: oneLine(b.claim, 72) }));
  const rejected = rounds
    .flatMap((r) => (r.verdicts ?? []).filter((v) => v.rejected))
    .slice(-2)
    .map((v) => ({ name: v.name, reason: oneLine(v.rejectReason ?? '超预算', 60) }));
  const nextSteps = collectNextSteps(rounds, summary.openBlockers);

  try {
    const response = await llm.complete({
      purpose: 'chairman',
      system: buildChairmanSystemPrompt(config.chairmanMaxChars),
      messages: [
        {
          role: 'user',
          content: buildChairmanUserPrompt({
            requirement,
            rounds: rounds.length,
            verdictLines,
            blockers,
            rejected,
            nextSteps,
            decision: STOP_REASONS[rounds.length ? (rounds.at(-1)?.stopReason ?? '') : ''] ?? '评审结束',
          }),
        },
      ],
      maxTokens: Math.round(config.chairmanMaxChars * 1.8),
      temperature: 0.2,
    });
    const text = truncate(String(response?.text ?? '').trim(), config.chairmanMaxChars);
    if (!text) return { text: null, error: 'empty' };
    return { text, usage: response?.usage?.output ?? estimateTokens(text) };
  } catch (error) {
    onEvent?.('chairman/failed', { error: String(error?.message ?? error) });
    return { text: null, error: String(error?.message ?? error) };
  }
}

/**
 * 跑一场内阁评审。
 *
 * @param {object} input
 * @param {string} input.requirement 主任务需求
 * @param {object} [input.config] 配置覆盖
 * @param {object} [input.llm] 席位 provider（由 createBridge 生成）
 * @param {object} [input.criticLlm] 评审团 provider（独立模型时传入；缺省沿用 llm）
 * @param {number} [input.criticWeight] LLM 评审的融合权重（同模型时应降到 0.4）
 * @param {string} [input.criticNote] 写进报告元数据的评审独立性说明
 * @param {Function} [input.onEvent] 事件回调 (type, payload)
 * @returns {Promise<{markdown: string, meta: object}>}
 */
export async function runQuorum({
  requirement,
  config: rawConfig = {},
  llm,
  criticLlm = null,
  criticWeight = 0.6,
  criticNote = '',
  onEvent,
}) {
  const config = resolveConfig(rawConfig);
  const emit = (type, payload) => {
    try {
      onEvent?.(type, payload);
    } catch {
      /* 事件回调失败不能中断评审 */
    }
  };

  const text = String(requirement ?? '').trim();
  if (!text) throw new QuorumRunError('需求为空：至少给一句话', { code: 'QUORUM_EMPTY_REQUIREMENT' });
  const normalized = truncate(text, config.maxRequirementChars);
  if (!llm || typeof llm.complete !== 'function') {
    throw new QuorumRunError('缺少 llm provider，先用 createBridge(config, { ctx }) 构造', { code: 'QUORUM_NO_PROVIDER' });
  }

  const runId = newRunId();
  const sandbox = new QuorumSandbox(PERSONAS);
  const personaIds = PERSONAS.map((p) => p.id);
  let weights = initialWeights(personaIds);
  let muted = [];
  const rounds = [];
  const allStatements = [];
  let tokensSpent = 0;
  let decision = { stop: false, reason: 'continue', detail: '' };
  let previousSummary = null;

  emit('run/start', { runId, provider: llm.id, requirement: normalized.slice(0, 80) });

  for (let round = 1; round <= config.maxRounds; round++) {
    sandbox.assertIsolated();

    // 1) 决定本轮谁说话、说多少
    const order = speakingOrder(weights, personaIds);
    const muteSet = new Set(muted);
    let speakers = order.filter((id) => !muteSet.has(id));
    if (speakers.length === 0) speakers = order.slice(0, 1);

    const previousStatements = allStatements.slice(-3);
    const previousVerdicts = rounds.at(-1)?.verdicts ?? [];
    const carriedBlockers = rounds.at(-1)?.summary?.openBlockers ?? [];

    // 2) 并行生成：每个席位只读自己的上下文
    const results = await Promise.all(
      speakers.map(async (id) => {
        const persona = PERSONAS.find((p) => p.id === id);
        const ctx = sandbox.get(id);
        if (round === 1) {
          ctx.seedSystem(buildSystemPrompt(persona, { config }));
        }
        const relay = buildRelay({
          persona,
          round,
          requirement: normalized,
          personaIds,
          statements: previousStatements,
          verdicts: previousVerdicts,
          openBlockers: carriedBlockers,
          weights,
          muted,
          config,
        });
        ctx.brief(relay);

        const maxTokens = tokenBudgetFor(id, weights, config);
        try {
          const response = await llm.complete({
            purpose: 'agent',
            system: ctx.messages[0]?.content ?? '',
            messages: ctx.view.filter((m) => m.role !== 'system'),
            maxTokens,
            temperature: 0.4,
          });
          const body = String(response?.text ?? '').trim();
          if (!body) throw new Error('空输出');
          tokensSpent += response?.usage?.output ?? estimateTokens(body);
          ctx.record(body, { round });
          return { id, persona, text: body, ok: true };
        } catch (error) {
          const message = String(error?.message ?? error);
          emit('agent/failed', { round, id, error: message });
          // 记一条失败占位，让上下文里留下"这轮跑挂了"的事实，但不参与评分
          ctx.record(`（本轮调用失败：${message}）`, { round });
          return { id, persona, text: '', ok: false, error: message };
        }
      }),
    );

    const statements = results.filter((r) => r.ok).map((r) => ({ persona: r.persona, text: r.text }));
    const failures = results.filter((r) => !r.ok);

    if (statements.length === 0) {
      throw new QuorumRunError(`第 ${round} 轮所有席位调用失败：${failures.map((f) => f.error).join('; ').slice(0, 300)}`, {
        code: 'QUORUM_ALL_AGENTS_FAILED',
      });
    }

    // 3) 评审团打分
    emit('round/statements', {
      round,
      statements: statements.map((s) => ({ id: s.persona.id, chars: s.text.length, head: s.text.slice(0, 24) })),
    });
    const evaluation = await evaluateRound({
      round,
      requirement: normalized,
      statements,
      weights,
      carriedBlockers,
      config,
      llm: criticLlm ?? llm,
      llmWeight: criticWeight,
      anonymize: config.anonymize,
      onEvent: emit,
    });

    // 4) 调权
    const updated = updateWeights({ prev: weights, verdicts: evaluation.verdicts, personaIds, config });
    const weightDelta = updated.deltas;
    weights = updated.weights;
    const mutedNext = updated.muted;

    rounds.push({
      round,
      statements,
      verdicts: evaluation.verdicts,
      summary: evaluation.summary,
      weights: { ...weights },
      weightDelta,
      muted: mutedNext,
      source: evaluation.source,
      anonymized: evaluation.anonymized,
      failures: failures.map((f) => ({ id: f.id, error: f.error })),
    });
    allStatements.push(...statements);

    // 5) 熔断
    decision = decideStop({
      round,
      summary: evaluation.summary,
      previous: previousSummary,
      config,
      tokensSpent,
    });
    previousSummary = evaluation.summary;
    muted = mutedNext;

    emit('round/end', {
      round,
      quality: evaluation.summary.weightedQuality,
      spread: evaluation.summary.spread,
      openBlockers: evaluation.summary.openBlockers.length,
      weights: { ...weights },
      muted: mutedNext,
      decision,
      tokensSpent,
    });

    if (decision.stop) break;
  }

  // 6) 出口：全文（可选）先落盘，再生成只含结构化字段的摘要
  const transcriptFile = await persistTranscript({
    runId,
    sandbox,
    meta: { requirement: normalized, config: { ...config, apiKey: undefined }, rounds: rounds.length, decision, weights, tokensSpent },
    config,
    onEvent: emit,
  });

  const sandboxStats = sandbox.stats();
  const summary = rounds.at(-1)?.summary ?? {
    weightedQuality: 0,
    spread: 0,
    openBlockers: [],
    rejectedCount: 0,
    consensus: false,
    optimal: false,
  };

  // 6.5) 主席裁定（可选）：只把结构化材料交给主席，不给全文
  const chairmanEnabled =
    config.chairman === 'on' || (config.chairman === 'auto' && llm.id !== 'mock');
  const chairmanResult = chairmanEnabled
    ? await runChairman({ llm: criticLlm ?? llm, requirement: normalized, rounds, summary, config, onEvent: emit })
    : { text: null, error: 'disabled' };
  if (chairmanResult.text) tokensSpent += chairmanResult.usage ?? estimateTokens(chairmanResult.text);
  emit('chairman/done', { used: Boolean(chairmanResult.text), error: chairmanResult.error });

  const reportArgs = {
    requirement: normalized,
    runId,
    rounds,
    weights,
    config,
    decision,
    provider: llm.id,
    tokensSpent,
    sandbox,
    sandboxStats,
    transcriptFile,
    personaNames: Object.fromEntries(PERSONAS.map((p) => [p.id, p.name])),
    criticNote,
    chairman: chairmanResult.text,
  };

  let report;
  try {
    report = buildReport(reportArgs);
  } catch (error) {
    // 主席把原文成段抄进摘要时，出口守卫会拦；这里降级去掉主席段落重出，而不是整场作废
    if (chairmanResult.text && error?.code === 'QUORUM_EGRESS_LEAK') {
      emit('chairman/egress-dropped', { error: String(error.message) });
      report = buildReport({ ...reportArgs, chairman: null });
      chairmanResult.text = null;
    } else {
      throw error;
    }
  }

  return {
    markdown: report.text,
    meta: {
      runId,
      provider: llm.id,
      scenario: llm.scenario,
      rounds: rounds.length,
      stopReason: decision.reason,
      stopLabel: STOP_REASONS[decision.reason] ?? decision.reason,
      quality: rounds.at(-1)?.summary?.weightedQuality ?? 0,
      weights,
      muted: rounds.at(-1)?.muted ?? [],
      tokensSpent,
      openBlockers: rounds.at(-1)?.summary?.openBlockers ?? [],
      rejected: rounds.flatMap((r) => r.verdicts.filter((v) => v.rejected)),
      transcriptFile,
      sandbox: sandbox.stats(),
      egress: report.egress,
      anonymized: rounds.at(-1)?.anonymized ?? false,
      criticWeight,
      criticNote,
      chairman: { used: Boolean(chairmanResult.text), error: chairmanResult.error },
    },
  };
}
