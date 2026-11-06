# dsh-council

> DSH 插件：在正式启动大型项目前，拉起一个**虚拟内阁**做需求评审。
> 三席辩论 → 主工作流打分 → 动态话语权 → 最多 3 轮熔断 → **只回一份 Markdown 摘要**。

解决的三个具体问题：

1. **上下文污染**：辩论过程又长又碎，全量倒进主上下文会挤掉真正的任务上下文 → 三席各自独立沙箱，出口只放结构化摘要。
2. **没有裁决**：三个 Agent 各说各话，谁声音大听谁的 → 主工作流按相关性 / 可行性 / 经济性打分，用分数改权重。
3. **过度设计**：方案越辩越大，最后变成"从零手搓一个 GTA6" → 经济性红线直接驳回，被驳回者掉权并静默。

## 架构

```
                    ┌───────────────────────── 主工作流（Orchestrator）─────────────────────────┐
                    │                                                                          │
  requirement ─────▶│  ① 建沙箱：三席各一个 messages 数组（互不可见，system 只写一次）              │
                    │  ② 每轮：按权重排序 → 低权静默 → 并行生成（各自只读自己的上下文）              │
                    │  ③ 评审团（Critic）：席位匿名化（A/B/C）→ 相关性 / 可行性 / 经济性 → 阻断项 │
                    │  ④ Hedge 调权：高分加权、驳回重罚 → 权重绑定下一轮发言顺序 / 静默 / token 配额  │
                    │  ⑤ 熔断：共识 / 最优解 / 无进展 / 预算 / 3 轮上限 → 命中即停                    │
                    │  ⑥ 主席（Chairman，可选）：把结构化结论收敛成一段执行摘要                      │
                    │  ⑦ 出口：buildReport() 生成 Markdown（过出口守卫）──▶ 主上下文                │
                    │     辩论全文（可选）──▶ $DSH_HOME/council/runs/<runId>.json（只落盘，不回传）  │
                    └──────────────────────────────────────────────────────────────────────────┘
                          ▲                    ▲                      ▲
                   ProductManager          RedTeam                Architect
                   提案者 / 8 行内         攻击者 / P0–P2         评估者 / 结构 + 替代
```

## 三条不变量（机械保证，不靠提示词自觉）

| 不变量 | 落地位置 | 测试 |
| --- | --- | --- |
| **隔离**：任两席不共享 messages 数组或消息对象 | `sandbox.js#assertIsolated()`，每轮开跑前调用 | `test/smoke.mjs`（含"手工共享数组会被拦下"反例） |
| **单向入站**：外部文本只能经 `brief()` 进入，且是编排器构造的简报 | `sandbox.js#AgentContext` | 同上 |
| **出口收窄**：报告里出现连续 90 字原文即报错 | `sandbox.js#assertNoTranscript()` + `report.js` | 同上（含回灌原文的反例） |

> 出口阈值 90 字是刻意的：报告允许 ≤72 字的短引用（阻断项、下一步动作），但连续 90 字只可能是倒灌。

## 评分与调权

**三维打分**（`critic.js`，0–10，确定性实现可复现，LLM 评审占 60%）：

- **相关性**：主任务词汇召回 + 空洞词惩罚 + 水字数惩罚；席位职责加分（红队结构化攻击、架构师结构判断本身就是"相关"）。
- **可行性**：结构密度、具体动作词、数字；含糊措辞（可能 / 也许 / 视情况）扣分。
- **经济性**：`从零自研 / 重写整个 / 手搓 / 十万行 / 三到五年` 直接压到红线以下；复用、增量、PoC 加分；超长文本本身也扣分（成本=阅读成本）。

**权重更新**（`weights.js`，Hedge / 乘法更新）：

```
factor = exp(-η · (loss - 0.5))      # 质量 5 分为中性点
       × 0.45  若被经济性驳回
       × 0.5   若质量 < 3（水字数/跑题）
w' = project(w · factor → 单纯形, 下限 8%, 上限 60%)
```

- 权重即时生效于：**发言顺序**、**静默名单**（低于均分 55%）、**token 配额**（0.6–1.6 倍）。
- 上限 60% 是防独裁，下限 8% 是防误杀——红队不能被一次低分灭口。

**评审团的三层防偏**（第二部分借鉴自 llm-council / portable-dsh-multi-agent-plugin，见文末致谢）：

1. **匿名互评**：发言进评审团前换成「席位 A/B/C」，每轮按 `(轮次, 需求, 席位)` 确定性洗牌。评审团不知道谁说的，就没有「红队说的肯定尖锐」这类先验。
2. **评审独立性**：没配 `criticModel` = 自己评自己 → LLM 评分权重自动从 0.6 降到 **0.4**，剩下的交给确定性评分表；配了独立评审模型才用满 0.6。
3. **主席裁定**：轮次结束后由主席写一段 ≤600 字执行摘要。主席只拿到**结构化材料**（评分、阻断项、成本红线、下一步），拿不到全文——所以它没法把辩论过程重新灌回主上下文。

**熔断**（`breaker.js`，按顺序判定）：

| 原因 | 条件 |
| --- | --- |
| `max-rounds` | 跑满 3 轮（硬上限） |
| `consensus` | 加权质量 ≥ 6.8 且离散度 ≤ 1.6 且阻断清零且无驳回 |
| `optimal` | 加权质量 ≥ 8.2 且无阻断（或评审团直接判定） |
| `no-progress` | 第 2 轮起质量提升 < 0.15 且无阻断 |
| `budget` | 累计 token ≥ 9000 |
| `all-rejected` | 全员被驳回 |

## 工具

| 工具 | 用途 |
| --- | --- |
| `council_debate` | 跑一场评审，回 Markdown（`json: true` 回元数据） |
| `council_rules` | 打印席位职责、评分口径、权重与熔断规则 |
| `council_score` | 对一段发言做确定性评分（零模型，调提示词时对齐口径） |
| `council_status` | 本会话最近几次运行的轮次 / 终止原因 / 最终权重 |

## 安装

```powershell
# 1) 挂进 desktop profile（link 安装：源目录不能移动）
dsh plugin --profile desktop add "C:\Users\17359\Documents\deepseek-harness\plugins\dsh-council"
# 2) 重启客户端（宿主启动时挂载插件）
```

不装 DSH 也能直接跑（零依赖、纯 ESM，Node ≥ 18）：

> ⚠️ 生态里已经有同名插件 [`fufengyuan/dsh-council`](https://github.com/fufengyuan/dsh-council)（18 位历史人物议会）。本插件与它**不是同一个实现**；同一个 profile 同时安装会撞包名与工具名，二选一。

```powershell
node bin/council.mjs "为插件设计多 Agent 辩论评审，两周内交付" --scenario=converge-r2
node test/smoke.mjs      # 21 项：隔离 / 调权 / 熔断 / 出口 / 端到端
node test/http.test.mjs  # 4 项：真实 HTTP 形状、重试、错误路径
```

## 配置

优先级：工具参数 > `apply(ctx, config)` > 环境变量 > 默认值。

```yaml
dsh-council:
  provider: http            # auto | mock | http | harness
  baseUrl: https://api.deepseek.com/v1
  model: deepseek-chat
  apiKeyEnv: DSH_COUNCIL_API_KEY   # key 只从环境变量读，不写配置
  maxRounds: 3
  earlyStop: true
  anonymize: true                  # 匿名互评（评审团只看到 A/B/C）
  criticModel: ''                  # 评审团独立模型；留空 = 同源，LLM 权重自动降到 0.4
  criticProvider: ''               # 评审团可走另一个 provider
  criticIndependence: auto         # auto（同源降权）| off（不降权）
  chairman: auto                   # auto（非 mock 启用）| on | off
  chairmanMaxChars: 600
  weights: { eta: 0.9, min: 0.08, max: 0.6 }
  thresholds: { consensusQuality: 6.8, consensusSpread: 1.6, economyReject: 3.0 }
  budget: { perAgentTokens: 700, totalTokens: 9000 }
  returnTranscript: false   # true 时全文落盘 $DSH_HOME/council/runs/
```

**provider 行为**：`auto` = 有 `baseUrl` + key 走 http → 否则有 `ctx.llm` 走 harness → 否则 mock。
mock 是确定性剧本（`converge-r2 / converge-r3 / never / water / overbudget`），所以离线也能验证整条编排。

## 代码地图

```
lib/
  index.js       插件入口：4 个工具 + 配置合并
  orchestrator.js 一轮一轮跑：建沙箱 → 并行生成 → 评审 → 调权 → 熔断 → 主席 → 出口
  sandbox.js      上下文隔离、简报入站、出口守卫
  personas.js     三席角色、评审团提示词、主席提示词
  critic.js       确定性评分 + 匿名互评 + LLM 评审融合 + 轮次汇总（共识/阻断）
  weights.js      Hedge 调权、单纯形投影、token 配额
  breaker.js      熔断判定与原因表
  report.js       唯一的出口产物（结构化字段生成，长度硬上限）
  config.js       默认值与归一化（错配置夹到安全区间并记 warning）
  text.js         分词/覆盖度/JSON 抽取/稳定哈希
  llm/
    bridge.js            provider 选择（auto/mock/http/harness）
    mock.js              五套确定性剧本
    openai-compatible.js 任意 OpenAI 兼容端点（无 SDK 依赖，带超时与重试）
```

## 扩展点

- **加席位**：往 `PERSONAS` 加一项即可，权重与沙箱自动适配（`n` 由数组长度推导）。
- **换评审团**：`critic.js#evaluateRound` 里 LLM 输出只需满足 `{verdicts[], blockers[], consensus, optimal}`；解析失败自动回落确定性评分。
- **接宿主子代理**：`llm/bridge.js#harnessProvider` 是探测式接缝；宿主若暴露 `ctx.subagents`，把它换成真子会话即可，沙箱接口不用动。
- **持久化审计**：`returnTranscript: true` 已把全文写盘；接审计系统时只读该 JSON，别把内容再灌回上下文。

## 致谢与借鉴

调研方式：本机 `dsh-capability-scout`（`find_capability` / `find_dsh_plugin`，精选注册表 7,924 条）+ 外部检索。
本机 hosts 把 `github.com` 指向 `127.0.0.1`，GitHub 实时搜索不可用（scout 也报了 CA/叶证书错误并回退到本地注册表），
所以下面的结论基于注册表元数据与公开资料，具体实现以各仓库为准。

| 项目 | 作者 | 借鉴了什么 | 落地位置 |
| --- | --- | --- | --- |
| [karpathy/llm-council](https://github.com/karpathy/llm-council) | Andrej Karpathy | ① 匿名互评（评审者看不到署名）② 主席收敛出最终答案 | `critic.js#anonymizeStatements`、`orchestrator.js#runChairman` |
| [fufengyuan/dsh-council](https://github.com/fufengyuan/dsh-council) | fufengyuan | 「议会 + 主席 + 项目级默认配置」的产品形态（与本插件同名、不同实现） | 主席段、配置层、报告结构 |
| [WDahah/portable-dsh-multi-agent-plugin](https://github.com/WDahah/portable-dsh-multi-agent-plugin) | WDahah | 「任务派给一个模型、评审交给另一个模型」→ 同源时评审权重降级 | `config.criticModel/criticProvider`、`index.js` 独立性判定 |
| [lkshjd/dsh-debate](https://github.com/lkshjd/dsh-debate) | lkshjd | 「辩手互不可见（防人云亦云）→ 交叉质询 → 评审收敛」的流程编排 | relay 简报 + 轮次循环（隔离本身是本项目独立设计） |
| [shlouai/dsh-debate](https://github.com/shlouai/dsh-debate) | shlouai | 「辩论记录交由主代理裁决」的角色划分，印证 Critic 不应参与提案 | `critic.js` 的评审团与席位分离 |
| Du et al., *Improving Factuality and Reasoning in Language Models through Multiagent Debate*（[arXiv:2305.14325](https://arxiv.org/abs/2305.14325)） | Yilun Du 等 | 多轮辩论优于单轮自洽的学术依据 | 轮次设计、收敛判定 |

说明：**只借鉴设计思路，未复制上述项目代码**；各项目的许可与署名要求以其仓库页面为准。
如果其中有你希望显式引用许可文本的项目，告诉我，我按对方 LICENSE 补 `NOTICE`。

## 已知取舍

- 确定性评分器是**启发式**：它不读语义，靠词汇/结构/成本信号。所以它只负责"兜底 + 经济性红线"，语义判断交给 LLM 评审团（占 60%）。
- 阻断项只从红队发言抽：产品经理复述 `P0` 是在回应，不是新开阻断（否则每轮都会"复活"已解决的阻断）。
- 权重上限 60% 意味着极端情况下仍可能靠投票而非真理收敛——这是有意的：评审系统的目标是最小可行共识，不是选最优宇宙方案。
