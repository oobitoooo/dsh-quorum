// dsh-quorum / history.js —— 运行记录落盘
//
// 内存里只留最近 20 场，但「最近 20 场」如果每次重启就清零，面板看起来永远像新装的。
// 这里把记录写到 $DSH_HOME/quorum/runs.json：插件、独立面板、重启后的进程共用同一份。
//
// 写盘用「临时文件 + rename」：写到一半被杀也不会留下半个 JSON。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HISTORY_LIMIT = 20;

export function quorumDir() {
  const home = (process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'quorum');
}

export function historyFile() {
  return path.join(quorumDir(), 'runs.json');
}

/** 读取历史；文件不存在/损坏/结构不对都当空历史，绝不抛错。 */
export function loadHistory(limit = HISTORY_LIMIT) {
  try {
    const file = historyFile();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.runs) ? parsed.runs : [];
    return list.filter((r) => r && typeof r.runId === 'string').slice(-limit);
  } catch {
    return [];
  }
}

/** 覆盖写历史（原子替换）。失败只返回 false，不影响辩论本身。 */
export function saveHistory(runs, limit = HISTORY_LIMIT) {
  try {
    const list = (Array.isArray(runs) ? runs : []).slice(-limit);
    fs.mkdirSync(quorumDir(), { recursive: true });
    const file = historyFile();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 追加一条并截断；返回截断后的列表。 */
export function appendHistory(run, limit = HISTORY_LIMIT) {
  const next = [...loadHistory(limit), run].slice(-limit);
  saveHistory(next, limit);
  return next;
}
