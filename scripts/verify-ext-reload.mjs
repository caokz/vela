// e2e：扩展重载（开发者点「重新加载」/ 商店更新）后，已打开标签页里的划词工具条仍可用。
// 重载后新内容脚本跑在新的隔离世界，旧实例上下文失效但页面级监听还在：
// 旧版会在每次划词时多弹一个死工具条（点了只报「扩展未响应」）。
// 断言：重载前后都只有一个工具条；重载后「提问」能真正打开聊天卡；高亮正常。
// 用法：node scripts/verify-ext-reload.mjs
import { createServer } from 'node:http';
import { launch, sleep, waitFor, createChecker } from './lib/cdp.mjs';

const { check, summary } = createChecker();
const web = createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end('<html><body style="margin:220px 40px;font:20px serif"><p id="t">The quick brown fox jumps over the lazy dog near the river bank.</p></body></html>');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const W = `http://127.0.0.1:${web.address().port}/p`;
const b = await launch({ port: 9365 });
try {
  await sleep(1500);
  const s = await b.openTab(W, { wait: 2000 });
  const warns = [];
  s.on((m) => { if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') warns.push(m.params.args.map((a) => a.value).join(' ')); });
  const drag = async () => {
    await s.click(10, 10);
    await sleep(200);
    // 每次先复原段落：上一步的高亮 span 会把文本节点切开
    const m = JSON.parse(await s.evaluate(`(() => { const p = document.getElementById('t'); p.textContent = 'The quick brown fox jumps over the lazy dog near the river bank.'; const n = p.firstChild; const r1 = document.createRange(); r1.setStart(n, 4); r1.setEnd(n, 5); const r2 = document.createRange(); r2.setStart(n, 18); r2.setEnd(n, 19); const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect(); return JSON.stringify({ x1: a.left, x2: b.right, y: a.top + a.height / 2 }); })()`));
    await s.mouse('mousePressed', m.x1, m.y);
    for (let k = 1; k <= 6; k++) await s.mouse('mouseMoved', m.x1 + (m.x2 - m.x1) * k / 6, m.y, { buttons: 1 });
    await s.mouse('mouseReleased', m.x2, m.y);
    await waitFor(() => s.evaluate(`!!document.getElementById('om-sel-host')`), { timeout: 3000 });
    await sleep(300);
    return s.evaluate(`document.querySelectorAll('#om-sel-host').length`);
  };
  const btnPos = (act) => s.evaluate(`(() => { const h = document.getElementById('om-sel-host'); const b = h && h.shadowRoot && h.shadowRoot.querySelector('[data-act="${act}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`).then((v) => v && JSON.parse(v));

  check('重载前划词只弹一个工具条', (await drag()) === 1);

  // 走 chrome://extensions 的「重新加载」同款接口（developerPrivate.reload），比 runtime.reload 稳定
  const ext = await b.openTab('chrome://extensions/', { wait: 1500 });
  // 真实用户点「重新加载」时必在开发者模式；测试 profile 默认关，关着重载会被判 unsupportedDeveloperExtension 停用
  await ext.evaluate(`new Promise((res) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => res(1)))`);
  const r = await ext.evaluate(`new Promise((res) => chrome.developerPrivate.reload('${b.extId}', { failQuietly: true }, () => res(chrome.runtime.lastError?.message || 'ok')))`).catch((e) => e.message);
  if (r !== 'ok') console.log('reload:', r);
  const reloaded = await waitFor(async () => {
    const op = await b.openTab(`chrome-extension://${b.extId}/src/options/options.html`, { wait: 1200 });
    const id = await op.evaluate('chrome.runtime.id').catch(() => '');
    op.close();
    return id === b.extId;
  }, { timeout: 20000, interval: 800 });
  ext.close();
  check('扩展重载完成', !!reloaded);
  await sleep(1500);
  await b.activate(s.targetId);
  await sleep(800);

  check('重载后划词仍只有一个工具条（旧实例自行注销）', (await drag()) === 1);
  const hl = await btnPos('highlight');
  await s.click(hl.x, hl.y);
  check('重载后高亮生效', !!(await waitFor(() => s.evaluate(`document.querySelector('.om-hl')?.textContent || ''`), { timeout: 3000 })));
  await drag();
  const ask = await btnPos('ask');
  await s.click(ask.x, ask.y);
  check('重载后「提问」能打开聊天卡（不再报扩展未响应）', !!(await waitFor(() => s.evaluate(`!!document.getElementById('om-card-host')`), { timeout: 6000 })) && !warns.some((w) => /扩展未响应/.test(w)), warns);
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await b.close();
  web.close();
}
process.exit(summary());
