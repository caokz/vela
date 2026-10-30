// 0.7.9 加固专项：Chrome 自动深色（WebContentsForceDark）下高亮是否仍显色。
// 实测（18.png 取证 + 本车道复现）：WebContentsForceDark 会把 background-color 与
// background-image（gradient）一起深色化，双写救不了它——黄被画成暗琥珀 ≈rgb(56,40,4)，
// 而 computed backgroundColor 不变（它改的是绘制层，computed 看不出来）。
// 判定用「红蓝差 r−b>25」：暖色底还在（哪怕很暗）就算可辨。像素为准，computed 只作记录。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe');
const PORT = 9361;
const WEB = 39321;

function decodePng(buf) {
  let off = 8, idat = [], w = 0, h = 0, ch = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ch = data[9] === 6 ? 4 : 3; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, px = Buffer.alloc(w * h * ch);
  let in_ = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[in_++], row = raw.subarray(in_, (in_ += stride)), prev = y ? px.subarray((y - 1) * w * ch, y * w * ch) : null, dst = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? dst[x - ch] : 0, b = prev ? prev[x] : 0, c = prev && x >= ch ? prev[x - ch] : 0;
      dst[x] = f === 0 ? row[x] : f === 1 ? row[x] + a : f === 2 ? row[x] + b : f === 3 ? row[x] + ((a + b) >> 1) : row[x] + paeth(a, b, c);
    }
  }
  return { w, h, ch, px };
  function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
}

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><style>body{margin:40px;background:#fff;font:20px/1.6 serif}p{max-width:600px}</style></head><body><p id="txt">The quick brown fox jumps over the lazy dog near the river bank.</p></body></html>`);
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'vela-fd-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--enable-features=WebContentsForceDark', '--force-dark-mode',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  `http://127.0.0.1:${WEB}/`,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { send, close: () => ws.close() };
}
const evalInPage = async (sess, expr) => {
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r?.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200));
  return r?.result?.value;
};
const mouse = (sess, type, x, y) => sess.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, pointerType: 'mouse', clickCount: 1 });

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed = 1; };

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
  await sleep(800);

  // 确认强制深色生效：body 背景应被深色化（背景像素不再接近纯白）
  const pre = await sess.send('Page.captureScreenshot', { format: 'png' });
  const preImg = decodePng(Buffer.from(pre.data, 'base64'));
  const o = (Math.floor(preImg.h / 2) * preImg.w + 20) * preImg.ch;
  const darkOn = preImg.px[o] < 128;
  check('WebContentsForceDark 生效（页面背景已深色化）', darkOn, `左缘背景=rgb(${preImg.px[o]},${preImg.px[o + 1]},${preImg.px[o + 2]})`);

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
  let host = false;
  for (let i = 0; i < 15 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
  if (!host) throw new Error('工具条未弹出');
  const btn = JSON.parse(await evalInPage(sess, `(() => { const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
  await mouse(sess, 'mousePressed', btn.x, btn.y);
  await mouse(sess, 'mouseReleased', btn.x, btn.y);
  let hl = '';
  for (let i = 0; i < 15 && !hl; i++) { await sleep(200); hl = await evalInPage(sess, `document.querySelector('.om-hl')?.textContent.slice(0, 10) || ''`); }
  check('强制深色下高亮仍生效', !!hl, JSON.stringify(hl));

  if (hl) {
    const bg = await evalInPage(sess, `getComputedStyle(document.querySelector('.om-hl')).backgroundColor`);
    console.log(`信息: 深色模式下 computed backgroundColor=${bg}（background-color 链路可能被深色化，正常）`);
    const rectDpr = JSON.parse(await evalInPage(sess, `(() => { const r = document.querySelector('.om-hl').getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top, w: Math.min(r.width, 600), h: r.height, dpr: devicePixelRatio }); })()`));
    const shot = await sess.send('Page.captureScreenshot', { format: 'png' });
    const img = decodePng(Buffer.from(shot.data, 'base64'));
    let yellowish = 0, total = 0;
    const x0 = Math.round(rectDpr.l * rectDpr.dpr), y0 = Math.round(rectDpr.t * rectDpr.dpr);
    const x1 = Math.min(img.w, Math.round((rectDpr.l + rectDpr.w) * rectDpr.dpr)), y1 = Math.min(img.h, Math.round((rectDpr.t + rectDpr.h) * rectDpr.dpr));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o2 = (y * img.w + x) * img.ch;
      total++;
      const r = img.px[o2], g = img.px[o2 + 1], b = img.px[o2 + 2];
      if (r - b > 25 && r - g > 8) yellowish++; // 深色化后黄被压成暗琥珀（≈rgb(56,40,4)）：以「红蓝差」判可辨
    }
    check('强制深色下截图像素里高亮仍可辨（黄被深色化为暗琥珀，非灰非无）', total > 0 && yellowish / total > 0.3, `暖色像素占比 ${total ? ((yellowish / total) * 100).toFixed(1) : '0'}%`);
    // 排障：span 区域颜色直方图（量化到 16），看深色化把它画成了什么
    const hist = new Map();
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const o2 = (y * img.w + x) * img.ch;
      const k = `${img.px[o2] >> 4},${img.px[o2 + 1] >> 4},${img.px[o2 + 2] >> 4}`;
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    console.log('信息: span 区域量化色直方图', [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6));
  }

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
