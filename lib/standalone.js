// dsh-quorum / standalone.js —— 脱离 DSH 宿主的面板进程
//
// 为什么要它：桌面快捷方式不能依赖「DSH 恰好开着、而且面板恰好启动过」。
// 这个模块把面板做成一个可独立运行的小服务：读同一份 personas.json、同一套 provider 配置，
// 关掉窗口也不影响 DSH 里的插件；DSH 里的面板在跑时优先复用它（见 launch.mjs）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPanel } from './panel.js';
import { resolveConfig } from './config.js';
import { createBridge } from './llm/bridge.js';
import { runQuorum } from './orchestrator.js';
import { translateProcess } from './translate.js';
import { normalizePersonas, PERSONAS } from './personas.js';

export function quorumHome() {
  const home = (process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'quorum');
}

function loadPersonas() {
  const file = path.join(quorumHome(), 'personas.json');
  try {
    if (!fs.existsSync(file)) return PERSONAS.map((p) => ({ ...p }));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizePersonas(parsed?.personas ?? parsed).personas;
  } catch {
    return PERSONAS.map((p) => ({ ...p }));
  }
}

/**
 * 起一个独立面板。
 *
 * @param {object} [options]
 * @param {number} [options.port] 首选端口（被占用自动顺延）
 * @param {object} [options.config] 配置覆盖；缺省读环境变量
 * @returns {Promise<{url: string, port: number, personas: object[], close: () => Promise<void>}>}
 */
export async function startStandalone({ port = 7845, config = {} } = {}) {
  const effective = resolveConfig({
    provider: process.env.DSH_QUORUM_PROVIDER || 'auto',
    baseUrl: process.env.DSH_QUORUM_BASE_URL || '',
    model: process.env.DSH_QUORUM_MODEL || '',
    apiKey: process.env.DSH_QUORUM_API_KEY || '',
    mockScenario: process.env.DSH_QUORUM_SCENARIO || 'auto',
    llmCritic: process.env.DSH_QUORUM_LLM_CRITIC !== '0',
    ...config,
  });

  const bridge = createBridge(effective);
  const runs = [];
  let personas = loadPersonas();

  const savePersonas = (input) => {
    const { personas: next, warnings } = normalizePersonas(input);
    personas = next;
    try {
      fs.mkdirSync(quorumHome(), { recursive: true });
      fs.writeFileSync(path.join(quorumHome(), 'personas.json'), JSON.stringify({ updatedAt: new Date().toISOString(), personas: next }, null, 2), 'utf8');
    } catch (error) {
      warnings.push(`落盘失败：${String(error?.message ?? error)}`);
    }
    return { personas: next, warnings };
  };

  const runDebate = async ({ requirement, maxRounds, mockScenario }) => {
    const configForRun = mockScenario ? resolveConfig({ ...effective, mockScenario }) : effective;
    const result = await runQuorum({
      requirement,
      config: configForRun,
      personas,
      capture: true,
      llm: bridge,
      criticNote: `独立面板｜provider=${bridge.id}｜匿名互评：${effective.anonymize ? '开' : '关'}`,
    });
    runs.push({
      ...result.meta,
      requirement: String(requirement).slice(0, 120),
      markdown: result.markdown,
      transcript: result.transcript ?? [],
      timeLabel: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    });
    if (runs.length > 20) runs.shift();
    return result;
  };

  const panel = await startPanel({
    port,
    getState: () => ({
      version: 'standalone',
      provider: bridge.id,
      personas,
      defaultPersonas: PERSONAS,
      sandboxCount: runs.length,
      runs: runs.slice().reverse(),
    }),
    runDebate,
    savePersonas,
    translate: async ({ runId, target }) => {
      const run = runs.find((r) => r.runId === runId);
      if (!run) {
        const err = new Error(`找不到运行记录：${runId}`);
        err.status = 404;
        throw err;
      }
      return translateProcess({ transcript: run.transcript, requirement: run.requirement, target, llm: bridge });
    },
  });

  return { ...panel, personas, close: panel.close };
}
