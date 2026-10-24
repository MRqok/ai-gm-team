// 冒烟测试:启动一个演示模式任务,验证全流程跑通(需先启动 server.js)
const BASE = process.env.GMT_BASE || 'http://127.0.0.1:8787';
const task = '帮我做一份社区奶茶店的开业方案,包括选址分析、产品定价和开业活动策划';

const res = await fetch(BASE + '/api/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ task, mock: true, maxWorkers: 3, maxRounds: 2 }),
});
if (!res.ok) { console.error('启动失败:', await res.text()); process.exit(1); }
const { runId } = await res.json();
console.log('runId:', runId);

let since = 0, done = false;
for (let i = 0; i < 60 && !done; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const d = await (await fetch(BASE + '/api/events?runId=' + runId + '&since=' + since)).json();
  for (const ev of d.events) {
    if (ev.type === 'phase') console.log('[阶段]', ev.data.phase);
    else if (ev.type === 'log') console.log('[日志]', ev.data.msg);
    else if (ev.type === 'worker') console.log('[员工' + ev.data.no + ']', ev.data.status, '|', (ev.data.summary || '').slice(0, 40));
    else if (ev.type === 'done') {
      console.log('[完成] 报告:', ev.data.reportFile);
      console.log('[结论]', ev.data.conclusion);
    } else if (ev.type === 'error') console.log('[错误]', ev.data.message);
  }
  since = d.next;
  done = d.status !== 'running';
}
console.log(done ? 'SMOKE TEST OK' : 'SMOKE TEST TIMEOUT');
process.exit(done ? 0 : 1);
