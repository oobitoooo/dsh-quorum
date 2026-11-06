// dsh-quorum / llm/mock.js —— 确定性 mock provider
//
// 存在的理由不是"占位"，而是让整个编排在零 API、零网络下可回归：
//   - 五个剧本覆盖 共识早停 / 三轮跑满 / 水字数掉权 / 超预算驳回；
//   - 同样的需求 + 轮次 + 席位 → 逐字相同的输出（FNV 种子）；
//   - 尊重 maxTokens（超了就像真模型一样被截断），所以"水字数被砍"也能被测到。
//
// 评审团调用返回空 verdicts：让确定性评分表成为 mock 模式下的权威判分，
// LLM 合并路径由单元测试单独覆盖（见 test/smoke.mjs 的 mergeVerdict 用例）。

import { stableHash, truncate } from '../text.js';

export const MOCK_SCENARIOS = ['auto', 'converge-r2', 'converge-r3', 'never', 'water', 'overbudget'];

export function resolveScenario(config, requirement) {
  if (config.mockScenario && config.mockScenario !== 'auto') return config.mockScenario;
  const text = String(requirement ?? '');
  if (/GTA\s*6|从零手搓|自研引擎|自研框架/i.test(text)) return 'overbudget';
  if (/水字数|废话|凑字数|长篇/.test(text)) return 'water';
  return 'converge-r2';
}

const PM = {
  r1: `结论：复用现有 dsh-tools 增量接入，不做平台化重写，两周内交付最小可用闭环。
做：需求解析 → 三席辩论 → 结论回传；不做：Web 控制台、权限体系、计费。
关键动作：
1. 用 defineTool 注册 quorum_debate，签名与现有工具一致，不新起框架。
2. 三席各自独立 messages 数组，单席上限 3000 字，超限先摘要再入仓。
3. 评审团一次调用评完三席并输出 JSON，解析失败回落确定性评分表。
验收：同一需求连跑 3 次结论一致；单次 ≤ 3 轮、≤ 9000 token。`,
  r2: `按红队意见逐条收口：
1. P0 自证循环：评审团与席位强制不同 provider；同源时评审判定降级为确定性评分表。
2. P1 上下文撑爆：单席 3000 字硬截断，超限摘要入仓，轮次硬上限 3。
3. P2 假动态权重：权重直接绑定 token 配额，低于均分 55% 的席位下一轮静默。
范围不变：不做可视化、多租户、权限。验收仍是连跑 3 次结论一致。`,
  r3: `第三轮不再加功能，只锁死边界：三席固定为产品/红队/架构，可由配置替换但不再运行时增删；
评审团 JSON 必须过 schema 才进入汇总，坏输出整轮作废并回落确定性评分；
全文只落盘调试，回传只保留 Markdown 摘要与元数据。现在可以封板实施。`,
};

const RT = {
  r1: `[P0] 评审团与席位共用同一模型时，评分会自我强化 → 后果：红队形同虚设，过设计照样通过 → 触发条件：连续两轮评审团给同一席位 8 分以上。
[P1] 席位输出超长会撑爆沙箱上下文 → 后果：第 3 轮请求被截断，结论失真 → 触发条件：单席位累计超过 6000 字。
[P2] 权重只用于排序、不影响输出长度 → 后果：扣了权但没有实际约束，是假动态权重。`,
  r2: `[P0] 已解决：评审团与席位强制不同 provider，同源时降级为确定性评分表，自证循环被切断。
[P1] 已解决：单席 3000 字硬截断加摘要入仓，撑爆风险消除。
[P2] 已解决：权重绑定 token 配额，低于均分 55% 静默，约束落到实际输出上。
本轮无新增阻断，剩余风险仅剩"摘要可能丢细节"，列为 P2 接受。`,
  r3: `[P2] 报告的 quote 截断可能让长论证失真 → 后果：主工作流误读结论强度 → 触发条件：单条引用超过 36 字。
本轮无 P0/P1 级阻断，接受当前方案。`,
  never: `[P0] 本轮新发现：席位之间没有互相可见的假设清单 → 后果：同一前提被三方各自假设成不同内容，结论不可比 → 触发条件：任意两席对同一术语给出不同定义。
[P1] 权重更新使用质量分，而质量分来自评审团，评审团又是同一模型 → 后果：误差被放大而非抑制。`,
  overbudget: `[P0] 该方案要求从零手搓一个游戏引擎级渲染管线 → 后果：两周变两年 → 触发条件：真的按提案排期。`,
};

const AR = {
  r1: `结构成立，三处要收：席位做成可配置数组而非硬编码；评审团输出必须先过 schema 再进汇总；全文落盘、回传只给 Markdown。
替代方案（更省）：不做辩论可视化，一次运行产出「JSON 摘要 + 一段 Markdown」，界面后置。
成本：约为提案的 60%，一周可起步。`,
  r2: `同意收口方案。补一条边界：权重与 token 配额必须是同一份状态，不能再派生第二套计分，否则两处判定会漂。
扩展性判断：三席足够，第四席（安全）等真有需求再加，现在加就是过度设计。
成本：不变，仍是一周内可起步。`,
  r3: `封板前确认三点：schedule 与 breaker 的判定顺序写死并测过；出口守卫的 verbatim 阈值有测试；mock 剧本覆盖四种终止路径。
其余无异议，可以实施。`,
  never: `扩展性上我不反对，但每轮都在新增阻断项，说明需求边界本身没定清。建议先冻结范围再继续辩论。`,
  overbudget: `成本上明确反对：这套东西需要独立团队和季度级排期，与"两周可交付"的前提直接冲突。`,
};

const RT3 = {
  r2: `[P0] 已解决：评审团与席位强制不同 provider，自证循环被切断。
[P1] 已解决：单席 3000 字硬截断加摘要入仓，撑爆风险消除。
[P1] 本轮新增：权重与 token 配额是两份状态 → 后果：扣了权仍能写满配额 → 触发条件：两处配额不同步。`,
  r3: `[P1] 已解决：权重与配额合并为同一份状态，低于均分 55% 直接静默，配额同步收缩。
本轮无新增阻断，接受当前方案。`,
};

const WATER = `在当前数字化转型的大背景下，我们需要以更强的使命感推动整体方案的全面赋能，形成可复用的能力矩阵与生态闭环。
从顶层设计来看，这个需求本身具备极强的战略价值，我们要以抓手思维打造一体化平台，实现全链路的共振与协同。
第一，在认知层面统一颗粒度，让各方在同一个维度上对齐，形成组合拳；第二，在机制层面建立闭环，让赋能可持续；第三，在生态层面构建护城河，让能力可沉淀。
我们还要重视组织的维度升级，把流程、工具、文化三者拉通，形成一体化推进的整体合力，真正做到赋能业务、赋能团队、赋能生态。
总体而言，只要坚持顶层设计与基层探索相结合，坚持生态共建与能力复用相结合，就一定能够实现从单点突破到体系化能力的跃迁，形成可复制、可推广、可持续的整体闭环。
这套打法不仅适用于当前需求，也为后续的维度升级预留了充足的想象空间，是真正意义上的一体化生态闭环。`;

function pickScenarioText(scenario, personaId, round) {
  const r = Math.min(3, Math.max(1, round));
  const pick = (table) => table[`r${r}`] ?? table.r3;
  if (personaId === 'product_manager') {
    if (scenario === 'water') return WATER;
    if (scenario === 'overbudget') {
      return `结论：从零手搓一个 GTA6 级别的自研引擎，把渲染、物理、AI 全链路一次性做透。
范围：全部重写现有运行时，自建集群承载，预计三到五年完成，代码量十万行以上。
关键动作：先自研框架，再自研内核，最后推倒重来整合。
成本：需要独立团队与季度级排期，但天花板极高。`;
    }
    if (scenario === 'never') return round === 1 ? PM.r1 : PM.r2;
    return pick(PM);
  }
  if (personaId === 'red_team') {
    if (scenario === 'overbudget') return round === 1 ? RT.r1.split('\n')[0] + '\n' + RT.overbudget : RT.overbudget;
    if (scenario === 'never') return round === 1 ? RT.r1 : RT.never;
    if (scenario === 'converge-r3') return round === 1 ? RT.r1 : round === 2 ? RT3.r2 : RT3.r3;
    return pick(RT);
  }
  if (personaId === 'architect') {
    if (scenario === 'overbudget') return AR.overbudget;
    if (scenario === 'never') return round === 1 ? AR.r1 : AR.never;
    return pick(AR);
  }
  return '（未知席位）';
}

function detectPersona(system) {
  if (/RedTeam/.test(system)) return 'red_team';
  if (/Architect/.test(system)) return 'architect';
  if (/ProductManager/.test(system)) return 'product_manager';
  return 'unknown';
}

function detectRound(system, messages = []) {
  // 只看最后一条 user 消息（就是本轮 relay）。扫全历史会撞上转述里的"第 3 轮请求被截断"。
  const users = messages.filter((m) => m?.role === 'user');
  const probe = String(users.at(-1)?.content ?? messages.at(-1)?.content ?? system ?? '');
  const m = probe.match(/第\s*(\d+)\s*(?:[\/／]\s*\d+\s*)?轮/u);
  return m ? Number(m[1]) : 1;
}

/**
 * 创建 mock provider。
 * @param {{config: ReturnType<import('../config.js').resolveConfig>, requirement?: string}} options
 */
export function createMockProvider({ config, requirement = '' }) {
  const scenario = resolveScenario(config, requirement);

  return {
    id: 'mock',
    scenario,
    async complete({ system = '', messages = [], maxTokens = 700, purpose = 'agent', meta = {} } = {}) {
      if (purpose === 'critic') {
        // 空 verdicts：让确定性评分表成为权威判分（merge 路径由单测覆盖）
        return { text: JSON.stringify({ verdicts: [], blockers: [], consensus: false, optimal: false }), usage: { output: 0 } };
      }
      if (purpose === 'chairman') {
        const digest = messages.at(-1)?.content ?? '';
        const round = Number(digest.match(/轮次[：:]\s*(\d+)/)?.[1] ?? detectRound('', messages));
        const blockers = (digest.match(/\[P[01]\]/g) ?? []).length;
        const text = truncate(
          blockers > 0
            ? `可以开工，但先解 P0/P1。第 ${round} 轮仍剩 ${blockers} 条阻断，先把它们落到具体动作再排期；范围按结论锁死，不追加平台化能力。`
            : `可以开工。按第 ${round} 轮结论锁死范围，先做最小闭环并留回滚点；剩余 P2 风险接受并记录，可视化与多租户明确后置。`,
          Math.max(60, Math.round(maxTokens * 0.95)),
        );
        return { text, usage: { output: text.length }, meta: { purpose, round, scenario } };
      }
      // 自定义席位没有内置名字可匹配，按「第几席」映射到内置剧本：
      // 真实模型会读人设，mock 只能按槽位演——这样面板换人设后仍然有像样的输出。
      const seatSlots = ['product_manager', 'red_team', 'architect'];
      const slot = Number.isInteger(meta?.seatIndex) ? seatSlots[meta.seatIndex] ?? seatSlots[0] : null;
      const personaId = slot ?? detectPersona(system);
      const round = Number.isInteger(meta?.round) ? meta.round : detectRound(system, messages);
      const seed = stableHash(`${scenario}|${personaId}|${round}|${requirement}`);
      const base = pickScenarioText(scenario, personaId, round);
      // 用种子做一点无害扰动，证明"同样的输入→同样的输出"而非硬编码
      const jitter = (seed % 7 === 0 && personaId === 'architect') ? '\n（本轮无新增结构风险。）' : '';
      const text = truncate(base + jitter, Math.max(60, Math.round(maxTokens * 0.95)));
      return {
        text,
        usage: { output: text.length },
        meta: { scenario, personaId, round, seed },
      };
    },
    info() {
      return { id: 'mock', scenario };
    },
  };
}
