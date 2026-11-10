#!/usr/bin/env node
// dsh-quorum / bin/panel.mjs —— 独立面板进程（桌面快捷方式走这里）
//
// 行为：
//   1. 先探 7845–7855：已经有面板在跑（DSH 宿主里的那个也算）就直接开浏览器，不重复起服务；
//   2. 没有就自己起一个（读 $DSH_HOME/quorum/personas.json 与 DSH_QUORUM_* 环境变量）；
//   3. 打开浏览器后常驻，Ctrl+C 或关掉窗口结束。
//
// 参数：--port <n> 首选端口 ｜ --no-open 只起服务不开浏览器 ｜ --json 打印地址后退出（调试）

import { spawn } from 'node:child_process';
import { startStandalone } from '../lib/standalone.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

const port = Number(flag('--port')) || 7845;
const open = !has('--no-open');
const jsonOnly = has('--json');

async function probe(start, end) {
  for (let p = start; p <= end; p++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(400) });
      if (res.ok) return `http://127.0.0.1:${p}/`;
    } catch {
      /* 该端口没有面板 */
    }
  }
  return null;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

const existing = await probe(port, port + 10);
if (existing) {
  if (jsonOnly) console.log(JSON.stringify({ url: existing, reused: true }));
  else {
    console.log(`面板已在运行：${existing}`);
    if (open) openBrowser(existing);
  }
  process.exit(0);
}

const panel = await startStandalone({ port });
if (jsonOnly) {
  console.log(JSON.stringify({ url: panel.url, reused: false }));
  await panel.close();
  process.exit(0);
}
console.log(`dsh-quorum 控制面板：${panel.url}`);
console.log('（关掉这个窗口即停止面板；DSH 里的面板不受影响）');
if (open) openBrowser(panel.url);

const shutdown = async () => {
  await panel.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
