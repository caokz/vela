// 0.7.9 诊断自检 + 持续监测验证：故障注入下红色提示/日志是否给出正确原因，正常路径无提示。
// 故障 1：页面 CSS !important 覆盖底色 → 提示「computed 背景=…覆盖了颜色」
// 故障 2：外部扩展 1.5s 后移除 span → 提示「…后被移除」（旧版窗口 2.5s，0.7.9 持续监测）
// 故障 3：上方覆盖层遮挡 → 提示「被 … 遮挡」
// 故障 4（0.7.9）：3.5s 后注入非 !important 覆盖 → 内联双写（color+image）顶得住，无提示
// 故障 5（0.7.9）：3.5s 后注入 !important 覆盖 → 自动修复 3 次无效后提示「仍被覆盖」
// 故障 6（0.7.9）：4.5s 后移除 span（超出旧 2.5s 窗口）→ 提示「…秒后被移除」
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9359;
const WEB = 39319;

const P = '<p id="txt">The quick brown fox jumps over the lazy dog near the river bank.</p>';
const pages = {
  normal: P,
  override: `<style>span.om-hl{background:transparent !important}</style>${P}`,
  removed: P,
  covered: `<style>#cover{position:fixed;left:0;top:0;width:100%;height:100%;background:#fff;z-index:99999}</style>${P}`,
  latecss: P,
  lateimportant: P,
  lateremoved: P,
};
// 延迟故障注入脚本：等 .om-hl 出现再延时动手（旧版「removed」在 DCL+1s 就删，span 还不存在）
const lateScripts = {
  removed: `const iv=setInterval(()=>{const s=document.querySelector('.om-hl');if(s){clearInterval(iv);setTimeout(()=>s.remove(),1500)}},200)`,
  latecss: `const iv=setInterval(()=>{const s=document.querySelector('.om-hl');if(s){clearInterval(iv);setTimeout(()=>{const st=document.createElement('style');st.textContent='span.om-hl{background:transparent}';document.head.appendChild(st)},3500)}},200)`,
  lateimportant: `const iv=setInterval(()=>{const s=document.querySelector('.om-hl');if(s){clearInterval(iv);setTimeout(()=>{const st=document.createElement('style');st.textContent='span.om-hl{background:transparent !important}';document.head.appendChild(st)},3500)}},200)`,
  lateremoved: `const iv=setInterval(()=>{const s=document.querySelector('.om-hl');if(s){clearInterval(iv);setTimeout(()=>s.remove(),4500)}},200)`,
};
const server = createServer((req, res) => {
  const m = req.url.match(/^\/(\w+)/);
  if (m && pages[m[1]]) {
    const sc = lateScripts[m[1]] ? `<script>${lateScripts[m[1]]}</script>` : '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><style>body{margin:40px;background:#fff;font:20px/1.6 serif}p{max-width:600px}</style></head><body>${pages[m[1]]}${sc}</body></html>`);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'vela-diag-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  `http://127.0.0.1:${WEB}/normal`,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
  let msgId = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') logs.push({ level: m.params.type, text: (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ') });
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { send, logs, close: () => ws.close() };
}
const evalInPage = async (sess, expr) => {
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200));
  return r?.result?.value;
};
const mouse = (sess, type, x, y) => sess.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, pointerType: 'mouse', clickCount: 1 });

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed = 1; };

async function runCase(sess, path, wait = 3400) {
  await sess.send('Page.navigate', { url: `http://127.0.0.1:${WEB}/${path}` });
  await sleep(1200);
  // 拖选 → 工具条弹出：busy 机器上真实指针事件会打断合成拖选（选区被清），重试 3 次
  let host = false;
  for (let attempt = 0; attempt < 3 && !host; attempt++) {
    await evalInPage(sess, `document.getElementById('txt')?.scrollIntoView()`);
    await sleep(200);
    const p = JSON.parse(await evalInPage(sess, `(() => {
      const node = document.createTreeWalker(document.getElementById('txt'), NodeFilter.SHOW_TEXT).nextNode();
      const len = node.textContent.length;
      const r1 = document.createRange(); r1.setStart(node, 0); r1.setEnd(node, 1);
      const r2 = document.createRange(); r2.setStart(node, len - 1); r2.setEnd(node, len);
      const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
      return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
    })()`));
    await mouse(sess, 'mousePressed', p.x1, p.y1);
    for (let k = 1; k <= 8; k++) await mouse(sess, 'mouseMoved', p.x1 + (p.x2 - p.x1) * k / 8, p.y1);
    await mouse(sess, 'mouseReleased', p.x2, p.y2);
    for (let i = 0; i < 15 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
  }
  if (!host) throw new Error(`${path}: 工具条未弹出`);
  const btn = JSON.parse(await evalInPage(sess, `(() => { const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
  await mouse(sess, 'mousePressed', btn.x, btn.y);
  await mouse(sess, 'mouseReleased', btn.x, btn.y);
  let hl = '';
  for (let i = 0; i < 15 && !hl; i++) { await sleep(200); hl = await evalInPage(sess, `document.querySelector('.om-hl')?.textContent.slice(0, 10) || ''`); }
  if (!hl) throw new Error(`${path}: 高亮未生效`);
  if (path === 'covered') await evalInPage(sess, `const c=document.createElement('div');c.id='cover';c.textContent='';document.body.appendChild(c)`);
  // 等诊断跑完（400ms 首检 + 持续监测；延迟注入的用例按各自时序等更久）
  await sleep(wait);
  const toast = await evalInPage(sess, `document.getElementById('om-hl-diag')?.textContent || ''`);
  const warns = sess.logs.filter((l) => l.text.includes('[Vela]')).slice(-8);
  sess.logs.length = 0;
  return { toast, warns };
}

try {
  let sess = null;
  for (let i = 0; i < 30 && !sess; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = targets.find((x) => x.type === 'page' && x.url.includes(`127.0.0.1:${WEB}`));
      if (t) { sess = await connect(t.webSocketDebuggerUrl); await sess.send('Runtime.enable'); }
    } catch { /* retry */ }
  }
  await sess.send('Page.enable');
  await sess.send('Page.bringToFront');

  const normal = await runCase(sess, 'normal');
  check('正常路径：无红色提示', normal.toast === '', JSON.stringify(normal.toast));
  check('正常路径：console 打出应用成功日志', normal.warns.some((l) => l.text.includes('高亮已应用')), normal.warns.map((l) => l.text).join(' | ').slice(0, 90));

  const ov = await runCase(sess, 'override');
  check('页面 !important 覆盖：红色提示给出原因', ov.toast.includes('覆盖了颜色') && ov.toast.includes('computed'), JSON.stringify(ov.toast));

  const rm = await runCase(sess, 'removed');
  check('外部移除 span：红色提示报「被移除」', rm.toast.includes('被移除'), JSON.stringify(rm.toast));

  const cv = await runCase(sess, 'covered');
  check('覆盖层遮挡：红色提示报「遮挡」', cv.toast.includes('遮挡'), JSON.stringify(cv.toast));

  const lc = await runCase(sess, 'latecss', 6000);
  const lcBg = await evalInPage(sess, `getComputedStyle(document.querySelector('.om-hl')).backgroundColor`);
  check('3.5s 后注入非 !important 覆盖：内联双写顶得住，无提示', lc.toast === '', JSON.stringify(lc.toast));
  check('非 !important 覆盖后 computed 仍为黄', lcBg === 'rgba(255, 222, 89, 0.6)', String(lcBg));

  const li = await runCase(sess, 'lateimportant', 9000);
  check('3.5s 后注入 !important 覆盖：自动修复 3 次无效后报「仍被覆盖」', li.toast.includes('仍被覆盖'), JSON.stringify(li.toast));
  check('!important 覆盖：修复尝试有日志', li.warns.some((l) => l.text.includes('已自动重写修复')), li.warns.map((l) => l.text).join(' | ').slice(0, 120));

  const lr = await runCase(sess, 'lateremoved', 6500);
  check('4.5s 后移除 span（超出旧 2.5s 窗口）：带时间戳提示「被移除」', lr.toast.includes('被移除') && lr.toast.includes('秒后'), JSON.stringify(lr.toast));

  sess.close();
} catch (e) {
  console.error('FAIL 异常', e.message);
  failed = 1;
} finally {
  chrome.kill();
  server.close();
  await sleep(800);
  rmSync(profile, { recursive: true, force: true });
  process.exit(failed);
}
