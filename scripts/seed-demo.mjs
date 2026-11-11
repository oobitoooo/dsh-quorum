#!/usr/bin/env node
// scripts/seed-demo.mjs —— 把「产品小分队」应用到运行中的面板，并跑两场示例辩论
//
// 用途：新装/重启后让面板不是空白；也给「模拟客户」这一席做一次现场演示。
// 用法：node scripts/seed-demo.mjs [--port 7845]

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 7845;
const base = `http://127.0.0.1:${port}`;

const html = await (await fetch(`${base}/`)).text();
const token = html.match(/const TOKEN = "([0-9a-f]{32})"/)?.[1];
if (!token) throw new Error(`面板没响应或页面结构变了：${base}`);

const state = await (await fetch(`${base}/api/state`)).json();
const preset = state.presetData?.product_squad;
if (!preset) throw new Error('面板里没有 product_squad 预设（版本太旧？）');

const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quorum-token': token },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error ?? ''}`);
  return data;
};

const saved = await post('/api/personas', { personas: preset });
console.log('席位已切换：' + saved.personas.map((p) => p.name).join(' / '));

const demos = [
  { requirement: '给控制面板加一个「导出评审报告为 PDF」的按钮，两周内可交付', scenario: 'converge-r2', maxRounds: 2 },
  { requirement: '让面板支持多人共用：同事也能看到我的评审记录，一周内可交付', scenario: 'overbudget', maxRounds: 2 },
];

for (const demo of demos) {
  const run = await post('/api/debate', demo);
  console.log(`跑完：${run.run.runId} ｜ ${run.run.rounds} 轮 ｜ ${run.run.stopLabel} ｜ 质量 ${run.run.quality}`);
}

const after = await (await fetch(`${base}/api/state`)).json();
console.log(`历史记录：${after.runs.length} 场，席位：${after.personas.map((p) => p.name).join(' / ')}`);
