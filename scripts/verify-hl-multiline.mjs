// e2e：跨行高亮不误报「被 P 遮挡」。高亮从第 1 行中间延伸到第 2 行中间时，span 外接矩形的
// 中心点落在两行之间 / 段落里未高亮的文字上，旧版遮挡自检按外接矩形中心取点，误报
// 「[Vela] 高亮颜色未生效 | 被 P 遮挡」（用户在 github.com README 上报障）。
// 同时保留真遮挡的检出：覆盖层盖住整段高亮时仍要报。
// 用法：node scripts/verify-hl-multiline.mjs
import { createServer } from 'node:http';
import { launch, sleep, waitFor, createChecker } from './lib/cdp.mjs';

const { check, summary } = createChecker();
const TEXT = 'Openbot is an open source agent framework that lets you build assistants which browse the web, call tools and remember context across long running sessions without any glue code.';
const page = (cover) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:220px 40px 40px;font:20px/1.6 serif}p{width:420px}
#cover{position:absolute;left:0;top:200px;width:100%;height:300px;background:rgba(255,255,255,.01)}
</style></head><body><p id="t">${TEXT}</p>${cover ? '<div id="cover"></div>' : ''}</body></html>`;
const web = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(page(q.url.includes('cover'))); });
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;
const b = await launch({ port: 9371 });

// 在第 1 行中段到第 2 行中段之间做一次真实拖选并点高亮；返回 15s 内是否出现遮挡告警
async function runCase(url, { viaSelection }) {
  const s = await b.openTab(url, { wait: 2000 });
  await s.send('Page.bringToFront');
  const warns = [];
  s.on((m) => { if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') warns.push(m.params.args.map((a) => a.value).join(' ')); });
  const m = JSON.parse(await s.evaluate(`(() => {
    const n = document.getElementById('t').firstChild;
    const at = (i) => { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); return r.getBoundingClientRect(); };
    const a = at(25), z = at(70);
    return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: z.right, y2: z.top + z.height / 2, lines: Math.round((z.top - a.top) / a.height) });
  })()`));
  if (viaSelection) {
    // 覆盖层挡住鼠标：直接程序化建选区后触发工具条
    await s.evaluate(`(() => { const n = document.getElementById('t').firstChild; const r = document.createRange(); r.setStart(n, 25); r.setEnd(n, 71); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return 1; })()`);
  } else {
    await s.mouse('mousePressed', m.x1, m.y1);
    for (let k = 1; k <= 8; k++) await s.mouse('mouseMoved', m.x1 + (m.x2 - m.x1) * k / 8, m.y1 + (m.y2 - m.y1) * k / 8, { buttons: 1 });
    await s.mouse('mouseReleased', m.x2, m.y2);
  }
  await waitFor(() => s.evaluate(`!!document.getElementById('om-sel-host')`), { timeout: 3000 });
  const btn = JSON.parse(await s.evaluate(`(() => { const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
  if (viaSelection) await s.evaluate(`document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]').click()`);
  else await s.click(btn.x, btn.y);
  const rects = await waitFor(() => s.evaluate(`document.querySelector('.om-hl')?.getClientRects().length || 0`), { timeout: 3000 });
  await sleep(1500); // 400ms 首检 + 700ms 像素终验
  const coverWarn = warns.find((w) => /遮挡/.test(w)) || '';
  s.close();
  return { lines: m.lines, rects, coverWarn };
}

try {
  const a = await runCase(`${BASE}/plain`, { viaSelection: false });
  check('高亮跨两行（多个行盒）', a.rects >= 2, a);
  check('跨行高亮不误报「被 P 遮挡」', !a.coverWarn, a.coverWarn);
  const c = await runCase(`${BASE}/cover`, { viaSelection: true });
  check('真被覆盖层整段盖住时仍报遮挡', /遮挡/.test(c.coverWarn), c.coverWarn || '无告警');
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await b.close();
  web.close();
}
process.exit(summary());
