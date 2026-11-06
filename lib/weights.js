// dsh-quorum / weights.js —— 动态话语权（Hedge / 乘法权重更新）
//
// 为什么用乘法更新而不是「按名次发权重」：
//   1. 权重连续、可微、可解释：掉 1 分对应固定比例的权重折损。
//   2. 有下限：再差的席位也保留 8% 话语权，避免一次误判把红队彻底灭口。
//   3. 有上限：再强的席位也不能超过 60%，避免单点垄断导致"共识"变成独裁。
//
// 权重不是装饰：它同时决定下一轮的发言顺序、静默名单和 token 配额。
// 也就是说，水字数的直接后果是「下一轮你能说的话变少」。

import { clamp, round } from './text.js';

/** 均分权重。 */
export function initialWeights(personaIds) {
  const n = personaIds.length;
  const w = 1 / n;
  return Object.fromEntries(personaIds.map((id) => [id, round(w, 6)]));
}

/**
 * 把任意正数向量投影到「和为 1 且每项落在 [min, max]」的单纯形子集上。
 * 先用夹紧，再对仍可移动的分量做缩放；有残差就均摊。最多 200 轮，必收敛。
 */
export function projectWeights(raw, min, max) {
  const n = raw.length;
  if (n === 0) return [];
  if (min * n > 1 + 1e-9 || max * n < 1 - 1e-9) {
    throw new Error(`权重边界不可行：n=${n}, min=${min}, max=${max}`);
  }
  const values = raw.map((v) => (Number.isFinite(v) && v > 0 ? v : 1 / n));

  // 欧氏投影到 {Σx=1, min≤x≤max}：找平移量 θ，使 Σ clamp(x_i - θ, min, max) = 1。
  // 单调函数，二分必收敛；比"先夹紧再归一"稳妥——后者在有人顶到上限时会丢质量。
  const clampSum = (theta) => values.reduce((acc, v) => acc + clamp(v - theta, min, max), 0);
  let lo = Math.min(...values) - 2;
  let hi = Math.max(...values) + 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (clampSum(mid) > 1) lo = mid;
    else hi = mid;
  }
  const theta = (lo + hi) / 2;
  let w = values.map((v) => clamp(v - theta, min, max));

  // 浮点残差归位：把差量给一个没贴边的席位
  let sum = w.reduce((a, b) => a + b, 0);
  const drift = 1 - sum;
  if (Math.abs(drift) > 1e-9) {
    const idx = w.findIndex((v) => v > min + 1e-9 && v < max - 1e-9);
    if (idx >= 0) w[idx] = clamp(w[idx] + drift, min, max);
  }

  // 四舍五入后再修一次，保证调用方拿到的和精确等于 1
  const rounded = w.map((v) => round(v, 6));
  const tail = round(1 - rounded.reduce((a, b) => a + b, 0), 6);
  if (tail !== 0) {
    const idx = rounded.findIndex((v) => v > min + 1e-6 && v < max - 1e-6);
    const target = idx >= 0 ? idx : rounded.indexOf(Math.max(...rounded));
    rounded[target] = round(clamp(rounded[target] + tail, min, max), 6);
  }
  return rounded;
}

/**
 * 一轮结束后的权重更新。
 *
 * @param {object} input
 * @param {Record<string, number>} input.prev 上一轮权重
 * @param {Array<{id: string, quality: number, rejected: boolean}>} input.verdicts 本轮判定（只含实际发言者）
 * @param {string[]} input.personaIds 全部席位
 * @param {{weights: {eta: number, min: number, max: number, rejectFactor: number, silentShrink: number}}} input.config
 * @returns {{ weights: Record<string, number>, deltas: Record<string, number>, muted: string[] }}
 */
export function updateWeights({ prev, verdicts, personaIds, config }) {
  const { eta, min, max, rejectFactor, harshQuality, harshFactor, silentShrink } = config.weights;
  const n = personaIds.length;
  const uniform = 1 / n;
  const verdictById = new Map(verdicts.map((v) => [v.id, v]));

  const raw = personaIds.map((id) => {
    const base = prev[id] ?? uniform;
    const verdict = verdictById.get(id);
    if (!verdict) {
      // 本轮没说话（被静默/未轮转到）：向均分回归，避免"沉默者红利"
      return base * (1 - silentShrink) + uniform * silentShrink;
    }
    const loss = 1 - clamp(verdict.quality, 0, 10) / 10;
    // 以 0.5 为中性点：质量 5 分时权重不动
    let factor = Math.exp(-eta * (loss - 0.5));
    if (verdict.rejected) factor *= rejectFactor;
    if (verdict.quality < harshQuality) factor *= harshFactor;
    return clamp(base * factor, 1e-6, 1);
  });

  const projected = projectWeights(raw, min, max);
  const weights = {};
  const deltas = {};
  personaIds.forEach((id, i) => {
    weights[id] = projected[i];
    deltas[id] = round(projected[i] - (prev[id] ?? uniform), 4);
  });

  return { weights, deltas, muted: mutedIds(weights, config, personaIds) };
}

/** 权重低于「均分 × muteRatio」的席位下一轮静默；但不允许全员静默（至少留权重最高的一位）。 */
export function mutedIds(weights, config, personaIds) {
  const n = personaIds.length;
  if (n === 0) return [];
  const floor = (1 / n) * config.thresholds.muteRatio;
  let muted = personaIds.filter((id) => (weights[id] ?? 0) < floor);
  if (muted.length >= n) {
    const top = [...personaIds].sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0))[0];
    muted = muted.filter((id) => id !== top);
  }
  return muted;
}

/** 下一轮发言顺序：权重降序；同权重按席位固定顺序，保证可复现。 */
export function speakingOrder(weights, personaIds) {
  return [...personaIds].sort((a, b) => {
    const d = (weights[b] ?? 0) - (weights[a] ?? 0);
    if (Math.abs(d) > 1e-9) return d;
    return personaIds.indexOf(a) - personaIds.indexOf(b);
  });
}

/**
 * 权重 → token 配额。权重 1/3 时约等于基准值；高权重最多 1.6 倍，低权重压到 0.6 倍。
 */
export function tokenBudgetFor(id, weights, config) {
  const w = weights[id] ?? 1 / 3;
  const factor = clamp(0.6 + 1.8 * w, 0.6, 1.6);
  const base = config.budget.perAgentTokens;
  return Math.round(clamp(base * factor, config.budget.minTokens, config.budget.maxTokens));
}
