// dsh-council / report.js —— 唯一允许回传主上下文的产物
//
// 硬约束：
//   - 只由结构化字段生成，不搬运任何席位原文；引用一律压成单行短句（≤72 字）。
//   - 长度有硬上限（report.maxChars），超出按章节边界砍断。
//   - 生成后过出口守卫 assertNoTranscript：连续 90 字原文命中即报错。

import { assertNoTranscript } from './sandbox.js';
import { oneLine } from './text.js';
import { STOP_REASONS } from './breaker.js';

function verdictOf({ consensus, openBlockers, rejected }) {
  if (openBlockers.some((b) => b.severity === 'P0')) return { label: '打回重做', tone: 'P0 级阻断未解决' };
  if (rejected.length > 0 && !consensus) return { label: '有条件通过（需重估成本）', tone: '存在被驳回的超预算建议' };
  if (openBlockers.length > 0) return { label: '有条件通过', tone: '存在 P1 级待办' };
  if (consensus) return { label: '通过', tone: '已达成共识且无阻断' };
  return { label: '有条件通过（未完全收敛）', tone: '轮次用尽仍无完全共识' };
}

const fmt = (n, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : '—');

export function collectNextSteps(rounds, openBlockers) {
  const latest = rounds.at(-1);
  const steps = [];

  for (const blocker of openBlockers.slice(0, 2)) {
    steps.push(`先解阻断：${oneLine(blocker.claim, 72)}（${blocker.severity}）`);
  }

  const pm = latest?.statements?.find((s) => s.persona.id === 'product_manager');
  if (pm) {
    const candidates = pm.text
      .split('\n')
      .map((line) => line.replace(/^\s*(?:\d+[.、)]|[-*])\s*/, '').replace(/^关键动作[：:]\s*/, '').trim())
      .filter((line) => line.length > 12 && !/[：:]$/.test(line) && !/^(?:\[?P[0-3]\b|已解决)/.test(line));
    const actionLine = candidates.find((line) => /关键动作|第一步|先做|接入|复用|落地/.test(line)) ?? candidates[0];
    if (actionLine) steps.push(`落地第一步：${oneLine(actionLine, 72)}`);
  }

  const architect = latest?.statements?.find((s) => s.persona.id === 'architect');
  if (architect) {
    const alt = architect.text
      .split('\n')
      .map((line) => line.replace(/^\s*(?:成本|替代方案)[（(]?[^)）]*[)）]?[：:]\s*/, '').trim())
      .find((line) => /替代|更省|成本|不做|不需要/.test(line));
    if (alt) steps.push(`成本控制：${oneLine(alt, 72)}`);
  }

  if (steps.length === 0) steps.push('按评审结论先做最小验证，再决定是否扩大范围');
  return steps.slice(0, 3);
}

function metaLines({ runId, provider, rounds, decision, weights, tokensSpent, sandboxStats, transcriptFile, criticNote }) {
  const lines = [
    `- 运行：${runId}｜provider=${provider}｜轮次 ${rounds.length}｜终止原因：${
      STOP_REASONS[decision.reason] ?? decision.reason
    }`,
    `- 终止依据：${oneLine(decision.detail, 140)}`,
    `- 最终权重：${Object.entries(weights)
      .map(([id, w]) => `${id} ${(w * 100).toFixed(0)}%`)
      .join(' / ')}`,
    `- 预算：约 ${tokensSpent} token（上限见 budget.totalTokens）`,
    `- 沙箱：${sandboxStats.map((s) => `${s.id} ${s.messages} 条 / ${s.chars} 字`).join('；')}`,
  ];
  if (criticNote) lines.push(`- 评审独立性：${criticNote}`);
  lines.push('- 隔离声明：三个席位的上下文互不可见；本文件由结构化评分生成，未回灌任何席位原文。');
  if (transcriptFile) lines.push(`- 辩论全文（仅调试，未进入上下文）：${transcriptFile}`);
  return lines;
}

/**
 * @param {object} input
 * @param {string} input.requirement
 * @param {string} input.runId
 * @param {Array} input.rounds
 * @param {Record<string, number>} input.weights
 * @param {object} input.config
 * @param {{reason: string, detail: string}} input.decision
 * @param {string} input.provider
 * @param {number} input.tokensSpent
 * @param {object} [input.sandbox] 用于出口守卫
 * @param {Array} [input.sandboxStats]
 * @param {string|null} [input.transcriptFile]
 */
export function buildReport({
  requirement,
  runId,
  rounds,
  weights,
  config,
  decision,
  provider,
  tokensSpent,
  sandbox = null,
  sandboxStats = [],
  transcriptFile = null,
  personaNames = {},
  chairman = null,
  criticNote = '',
}) {
  const latest = rounds.at(-1);
  const summary = latest?.summary ?? {
    weightedQuality: 0,
    spread: 0,
    openBlockers: [],
    rejectedCount: 0,
    consensus: false,
    optimal: false,
  };
  const rejected = rounds.flatMap((r) => (r.verdicts ?? []).filter((v) => v.rejected));
  // 同一席位多轮被驳回只报最后一次，否则成本红线段落会被重复条目占满
  const rejectedLatest = new Map();
  for (const r of rejected) rejectedLatest.set(r.id, r);
  const verdict = verdictOf({ consensus: summary.consensus, openBlockers: summary.openBlockers, rejected });

  /** 有内容的章节才编号，避免"一、四、五"这种跳号。 */
  const blocks = [];
  const push = (title, lines) => {
    if (lines.length > 0) blocks.push({ title, lines });
  };

  push(
    '主席裁定',
    chairman ? chairman.split('\n').map((line) => line.trim()).filter(Boolean) : [],
  );

  const scoreRows = Object.keys(weights)
    .sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0))
    .map((id) => {
      const v = (latest?.verdicts ?? []).find((x) => x.id === id);
      const w = weights[id] ?? 0;
      const delta = latest?.weightDelta?.[id];
      const arrow =
        typeof delta === 'number' && Math.abs(delta) >= 0.01
          ? delta > 0
            ? ` ↑${fmt(delta * 100, 0)}%`
            : ` ↓${fmt(Math.abs(delta) * 100, 0)}%`
          : '';
      if (!v) {
        // 本轮被静默：仍然列出，否则主工作流会以为这一席消失了
        return `| ${personaNames[id] ?? id}（本轮静默） | ${(w * 100).toFixed(0)}%${arrow} | — | — | — | — |`;
      }
      return `| ${v.name} | ${(w * 100).toFixed(0)}%${arrow} | ${fmt(v.scores.relevance)} | ${fmt(
        v.scores.feasibility,
      )} | ${fmt(v.scores.economy)} | ${fmt(v.quality)} |`;
    });

  push(
    '评分（按席位）',
    scoreRows.length > 0
      ? ['| 席位 | 权重 | 相关性 | 可行性 | 经济性 | 综合 |', '| --- | --- | --- | --- | --- | --- |', ...scoreRows]
      : [],
  );

  push(
    '未解决阻断',
    summary.openBlockers.slice(0, 6).map((b) => `- **[${b.severity}]** ${oneLine(b.claim, config.report.quoteChars * 2)}`),
  );

  // 同一席位多轮被驳回只报最后一次，否则成本红线段落会被重复条目占满
  push(
    '成本红线（被驳回的建议）',
    [...rejectedLatest.values()].slice(0, 4).map((r) => `- ${r.name}：${oneLine(r.rejectReason ?? '超预算', 90)}`),
  );

  push(
    '下一步',
    collectNextSteps(rounds, summary.openBlockers).map((step, i) => `${i + 1}. ${step}`),
  );

  push(
    '辩论轨迹',
    rounds.map(
      (round) =>
        `- 第 ${round.round} 轮：质量 ${fmt(round.summary.weightedQuality)}｜离散度 ${fmt(
          round.summary.spread,
          2,
        )}｜阻断 ${round.summary.openBlockers.length}｜驳回 ${round.summary.rejectedCount}｜评分源 ${round.source}`,
    ),
  );

  push(
    '元数据',
    metaLines({ runId, provider, rounds, decision, weights, tokensSpent, sandboxStats, transcriptFile, criticNote }),
  );

  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八'];
  const head = [
    '# 内阁评审结论',
    '',
    `**需求**：${oneLine(requirement, 140)}`,
    `**结论**：${verdict.label}（${verdict.tone}）｜第 ${rounds.length} 轮 · ${
      STOP_REASONS[decision.reason] ?? decision.reason
    }`,
    `**质量**：加权 ${fmt(summary.weightedQuality)}/10｜离散度 ${fmt(summary.spread, 2)}｜未解决阻断 ${
      summary.openBlockers.length
    }｜被驳回建议 ${rejectedLatest.size}`,
    '',
  ].join('\n');

  const body = blocks
    .map((block, i) => `## ${numerals[i] ?? i + 1}、${block.title}\n${block.lines.join('\n')}`)
    .join('\n\n');

  let text = `${head}\n${body}`;
  if (text.length > config.report.maxChars) {
    const cut = text.slice(0, config.report.maxChars);
    const boundary = Math.max(cut.lastIndexOf('\n## '), cut.lastIndexOf('\n- '));
    text = `${cut.slice(0, boundary > 0 ? boundary : config.report.maxChars - 80)}\n\n…（已按 report.maxChars=${
      config.report.maxChars
    } 截断）`;
  }

  let egress = { ok: true, leaked: 0 };
  if (sandbox) {
    const result = assertNoTranscript(text, sandbox);
    egress = { ...result, ok: true };
  }

  return { text, egress };
}
