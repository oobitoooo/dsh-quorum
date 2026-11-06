// dsh-quorum / breaker.js —— 熔断与收敛判定
//
// 判定顺序是有讲究的：先看硬上限，再看"已经足够好"，最后才看"再辩也没用"。
// 任何一条命中都立刻跳出循环——第 1 或第 2 轮达成共识就不再烧 Token 走完 3 轮。

export const STOP_REASONS = {
  'max-rounds': '达到轮次硬上限',
  consensus: '达成共识（提前终止）',
  optimal: '最优解已产出（提前终止）',
  'no-progress': '连续两轮无进展（提前终止）',
  'all-rejected': '全员建议被驳回（提前终止）',
  budget: 'Token 预算耗尽（提前终止）',
};

/**
 * @param {object} input
 * @param {number} input.round 刚结束的轮次
 * @param {{weightedQuality: number, spread: number, openBlockers: Array, rejectedCount: number, consensus: boolean, optimal: boolean, allRejected: boolean}} input.summary
 * @param {object|null} input.previous 上一轮 summary
 * @param {ReturnType<import('./config.js').resolveConfig>} input.config
 * @param {number} [input.tokensSpent]
 * @returns {{stop: boolean, reason: string, detail: string}}
 */
export function decideStop({ round, summary, previous, config, tokensSpent = 0 }) {
  if (round >= config.maxRounds) {
    return {
      stop: true,
      reason: 'max-rounds',
      detail: `已跑满 ${config.maxRounds} 轮，加权质量 ${summary.weightedQuality}，未解决阻断 ${summary.openBlockers.length} 项`,
    };
  }

  if (!config.earlyStop) {
    return { stop: false, reason: 'continue', detail: 'earlyStop=false，按轮次跑满' };
  }

  if (summary.consensus) {
    return {
      stop: true,
      reason: 'consensus',
      detail: `加权质量 ${summary.weightedQuality} ≥ ${config.thresholds.consensusQuality}，离散度 ${summary.spread} ≤ ${config.thresholds.consensusSpread}，阻断项清零`,
    };
  }

  if (summary.optimal) {
    return {
      stop: true,
      reason: 'optimal',
      detail: `加权质量 ${summary.weightedQuality} ≥ ${config.thresholds.optimalQuality}，判定最优解已产出`,
    };
  }

  if (summary.allRejected) {
    return { stop: true, reason: 'all-rejected', detail: '本轮所有建议均被驳回，继续辩论无增量' };
  }

  if (previous && round >= 2) {
    const delta = summary.weightedQuality - previous.weightedQuality;
    if (delta < config.thresholds.noProgressDelta && summary.openBlockers.length === 0) {
      return {
        stop: true,
        reason: 'no-progress',
        detail: `质量提升仅 ${delta.toFixed(2)}（< ${config.thresholds.noProgressDelta}），且无未解决阻断`,
      };
    }
  }

  if (tokensSpent >= config.budget.totalTokens) {
    return {
      stop: true,
      reason: 'budget',
      detail: `已用约 ${tokensSpent} token ≥ 预算 ${config.budget.totalTokens}`,
    };
  }

  return { stop: false, reason: 'continue', detail: '继续下一轮' };
}
