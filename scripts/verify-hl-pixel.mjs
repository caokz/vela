// 0.7.10 像素终验专项：DOM 全绿但屏幕不显色时，captureVisibleTab 采样链路是否
// 1) 正常页打出「像素验证通过」；2) 绘制被吃（background-clip:text + 透明文字——
//    computed backgroundColor 不变，400ms 首检照过）→ 自动增强绘制（box-shadow/outline
//    独立于 background）后恢复显色；3) 增强层也救不回（filter:brightness(0) 把整个元素
//    渲染压黑，含 box-shadow/outline）→ 红 toast + 「像素验证失败」日志。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe');
const PORT = 9362;
const WEB = 39323;

const P = '<p id="txt">The quick brown fox jumps over the lazy dog near the river bank.</p>';
const pages = {
  normal: P,
  // 用户报障签名的确定性复刻：opacity:0 不改 computed backgroundColor、不影响命中测试，
  // 400ms 首检全绿，但屏幕零绘制；增强层（box-shadow/outline）同在元素内也被透明掉
  hidden: `<style>.om-hl{opacity:0 !important}</style>${P}`,
  // 增强层被吃掉的另一种形态：brightness(0) 把整个元素渲染压黑（含 box-shadow/outline）
  dead: `<style>.om-hl{filter:brightness(0) !important}</style>${P}`,
};
const server = createServer((req, res) => {
  const m = req.url.match(/^\/(\w+)/);
  if (m && pages[m[1]]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><style>body{margin:40px;background:#fff;font:20px/1.6 serif}p{max-width:600px}</style></head><body>${pages[m[1]]}</body></html>`);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'vela-pix-'));
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

async function runCase(sess, path, wait = 3500) {
  await sess.send('Page.navigate', { url: `http://127.0.0.1:${WEB}/${path}` });
  await sleep(1200);
  await evalInPage(sess, `document.getElementById('txt')?.scrollIntoView()`);
  await sleep(200);
  const p = JSON.parse(await evalInPage(sess, `(() => {
    const node = document.createTreeWalker(document.getElementById('txt'), NodeFilter.SHOW_TEXT).nextNode();
    // 同行内选一段（首尾字符跨行的对角拖会把选区塌缩成单字，span 太小采样无意义）
    const r1 = document.createRange(); r1.setStart(node, 2); r1.setEnd(node, 3);
    const r2 = document.createRange(); r2.setStart(node, 29); r2.setEnd(node, 30);
    const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
    return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
  })()`));
  check(`${path}: 拖选两端在同一行`, Math.abs(p.y1 - p.y2) < 2, `y1=${p.y1.toFixed(1)} y2=${p.y2.toFixed(1)}`);
  await mouse(sess, 'mousePressed', p.x1, p.y1);
  for (let k = 1; k <= 8; k++) await mouse(sess, 'mouseMoved', p.x1 + (p.x2 - p.x1) * k / 8, p.y1);
  await mouse(sess, 'mouseReleased', p.x2, p.y1);
  let host = false;
  for (let i = 0; i < 15 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
  if (!host) throw new Error(`${path}: 工具条未弹出`);
  const btn = JSON.parse(await evalInPage(sess, `(() => { const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
  await mouse(sess, 'mousePressed', btn.x, btn.y);
  await mouse(sess, 'mouseReleased', btn.x, btn.y);
  let hl = '';
  for (let i = 0; i < 15 && !hl; i++) { await sleep(200); hl = await evalInPage(sess, `document.querySelector('.om-hl')?.textContent.slice(0, 10) || ''`); }
  if (!hl) throw new Error(`${path}: 高亮未生效`);
  const w = await evalInPage(sess, `document.querySelector('.om-hl')?.getBoundingClientRect().width ?? 0`);
  check(`${path}: 选区覆盖同行一段（span 宽度足够采样）`, w > 120, `宽=${w}`);
  await sleep(wait); // 400ms 首检 + 700ms 首次像素验（失败 +400ms 复验）
  const toast = await evalInPage(sess, `document.getElementById('om-hl-diag')?.textContent || ''`);
  const logs = sess.logs.filter((l) => l.text.includes('[Vela]'));
  sess.logs.length = 0;
  return { toast, logs };
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
  check('正常路径：像素验证通过日志', normal.logs.some((l) => l.text.includes('像素验证通过')), normal.logs.map((l) => l.text).join(' | ').slice(0, 140));
  check('正常路径：无红色提示', normal.toast === '', JSON.stringify(normal.toast));

  const hidden = await runCase(sess, 'hidden');
  const shadow = await evalInPage(sess, `getComputedStyle(document.querySelector('.om-hl')).boxShadow`);
  check('opacity:0 复刻用户签名：首检全绿照打应用成功日志（DOM 层看不出）', hidden.logs.some((l) => l.text.includes('高亮已应用')), hidden.logs.map((l) => l.text).filter((t) => t.includes('高亮已应用')).join(' | ').slice(0, 90));
  check('opacity:0：红 toast 报「未测到高亮色」', hidden.toast.includes('未测到高亮色'), JSON.stringify(hidden.toast));
  check('opacity:0：像素验证失败日志', hidden.logs.some((l) => l.text.includes('像素验证失败')), hidden.logs.map((l) => l.text).join(' | ').slice(0, 160));
  check('opacity:0：增强绘制已落上（box-shadow 非 none，救不回是 opacity 所致）', shadow !== 'none', String(shadow).slice(0, 60));

  const dead = await runCase(sess, 'dead');
  check('增强层也被吃（brightness(0)）：红 toast 报「未测到高亮色」', dead.toast.includes('未测到高亮色'), JSON.stringify(dead.toast));
  check('增强层也被吃：像素验证失败日志', dead.logs.some((l) => l.text.includes('像素验证失败')), dead.logs.map((l) => l.text).join(' | ').slice(0, 160));

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
