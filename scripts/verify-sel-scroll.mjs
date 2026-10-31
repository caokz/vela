// e2e：划词工具条与页面滚动。页面里无关的滚动容器（轮播/自动滚动挂件）持续发 scroll 时
// 工具条不能被收掉；页面本身滚动（锚点真的移动）时照常收起。
// 用法：node scripts/verify-sel-scroll.mjs
import { createServer } from 'node:http';
import { launch, sleep, waitFor, createChecker } from './lib/cdp.mjs';

const { check, summary } = createChecker();
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:220px 40px 40px;font:20px/1.6 serif;height:3000px}
#ticker{position:fixed;right:20px;top:20px;width:200px;height:60px;overflow:auto;border:1px solid #ccc;font-size:14px}
</style></head><body>
<div id="ticker">${'<div>滚动挂件条目</div>'.repeat(40)}</div>
<p id="t">The quick brown fox jumps over the lazy dog near the river bank and runs away.</p>
<script>setInterval(() => { const t = document.getElementById('ticker'); t.scrollTop = (t.scrollTop + 3) % 600; }, 50);</script>
</body></html>`;
const web = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(PAGE); });
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const b = await launch({ port: 9367 });
try {
  await sleep(1500);
  const s = await b.openTab(`http://127.0.0.1:${web.address().port}/`, { wait: 2000 });
  await s.send('Page.bringToFront');
  const m = JSON.parse(await s.evaluate(`(() => { const n = document.getElementById('t').firstChild; const r1 = document.createRange(); r1.setStart(n, 4); r1.setEnd(n, 5); const r2 = document.createRange(); r2.setStart(n, 18); r2.setEnd(n, 19); const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect(); return JSON.stringify({ x1: a.left, x2: b.right, y: a.top + a.height / 2 }); })()`));
  await s.mouse('mousePressed', m.x1, m.y);
  for (let k = 1; k <= 6; k++) await s.mouse('mouseMoved', m.x1 + (m.x2 - m.x1) * k / 6, m.y, { buttons: 1 });
  await s.mouse('mouseReleased', m.x2, m.y);
  const shown = await waitFor(() => s.evaluate(`!!document.getElementById('om-sel-host')`), { timeout: 3000 });
  check('划词工具条弹出', !!shown);
  await sleep(1200); // 挂件期间持续滚动约 24 次
  check('无关滚动容器持续滚动时工具条保持', await s.evaluate(`!!document.getElementById('om-sel-host')`));
  await s.evaluate(`window.scrollBy(0, 120)`);
  check('页面本身滚动时工具条收起', !!(await waitFor(async () => !(await s.evaluate(`!!document.getElementById('om-sel-host')`)), { timeout: 2000 })));
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await b.close();
  web.close();
}
process.exit(summary());
