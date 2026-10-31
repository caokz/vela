// 打包产物高亮验证·真实 Flink 页车道：真实 Chrome + nightlies.apache.org + dist zip。
// 覆盖此前矩阵的空格：diag-hl-real 只在 Playwright 跑过真实页，verify-package-hl 只在
// 真实 Chrome 跑过本地页。本脚本两者兼备，并在最后做像素级显色断言。
// 用法：VELA_CHROME=<chrome.exe> node scripts/verify-package-hl-flink.mjs [zip路径]
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WANT_VER = JSON.parse(readFileSync(join(EXT_ROOT, 'manifest.json'), 'utf8')).version; // 产物版本跟随 manifest
const ZIP = process.argv[2] ?? join(EXT_ROOT, 'dist', `vela-${WANT_VER}.zip`);
const CHROME = findChrome();
const REAL = Boolean(process.env.VELA_CHROME);
const PORT = 9356;
const URL_ = process.argv[3] ?? 'https://nightlies.apache.org/flink/flink-docs-master/docs/learn-flink/etl/';

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

const extDir = mkdtempSync(join(tmpdir(), 'vela-flink-ext-'));
const t0 = spawnSync('C:\\Windows\\System32\\tar.exe', ['-xf', ZIP, '-C', extDir], { encoding: 'utf8' });
if (t0.status !== 0) throw new Error('解包失败: ' + t0.stderr);

const profile = mkdtempSync(join(tmpdir(), 'vela-flink-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`,
  ...(REAL ? [] : [`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`]),
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--enable-unsafe-extension-debugging',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  URL_,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
  let msgId = 0;
  const pending = new Map();
  const contexts = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
    if (m.method === 'Runtime.executionContextCreated') contexts.set(m.params.context.id, m.params.context);
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return {
    send, contexts, close: () => ws.close(),
    evalIsolated: async (expr) => {
      for (const [id, ctx] of contexts) {
        if (ctx.auxData?.isDefault) continue;
        const probe = await send('Runtime.evaluate', { expression: 'typeof chrome?.runtime?.id', contextId: id, returnByValue: true });
        if (probe?.result?.value !== 'string') continue;
        const r = await send('Runtime.evaluate', { expression: expr, contextId: id, returnByValue: true });
        return r?.exceptionDetails ? 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300) : r?.result?.value;
      }
      return 'NO-EXT-CTX';
    },
  };
}
const evalInPage = async (sess, expr) => {
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r?.result?.value;
};
const mouse = (sess, type, x, y) => sess.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, pointerType: 'mouse', clickCount: 1 });

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = 1;
};

const FIND_H = `[...document.querySelectorAll('h2,h3')].filter((x) => x.getBoundingClientRect().width > 0).find((x) => x.textContent.includes('Non-keyed State'))`;

try {
  let sess = null;
  for (let i = 0; i < 60 && !sess; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = targets.find((x) => (x.type === 'page' || x.type === 'iframe') && x.url.includes('learn-flink/etl'));
      if (t) { sess = await connect(t.webSocketDebuggerUrl); await sess.send('Runtime.enable'); }
    } catch { /* retry */ }
  }
  if (!sess) throw new Error('Flink 页 target 未出现');
  await sess.send('Page.enable');
  await sess.send('Page.bringToFront');

  await sleep(500);
  // document_idle 注入受外部页网络影响：探测过早时隔离世界还没建出来（曾误报 NO-EXT-CTX），
  // 带重试窗口探测
  let extVer = 'NO-EXT-CTX';
  for (let i = 0; i < 10 && extVer !== WANT_VER; i++) {
    extVer = await sess.evalIsolated(`chrome.runtime.getManifest().version`);
    if (extVer !== WANT_VER) await sleep(1000);
  }
  if (extVer !== WANT_VER && REAL) {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const brws = await connect(ver.webSocketDebuggerUrl);
    const loaded = await brws.send('Extensions.loadUnpacked', { path: extDir });
    if (loaded?.error) throw new Error('Extensions.loadUnpacked 失败: ' + JSON.stringify(loaded.error));
    console.log('已通过 CDP loadUnpacked 装载产物');
    brws.close();
    for (let i = 0; i < 6 && extVer !== WANT_VER; i++) {
      await sleep(1500);
      await sess.send('Page.reload');
      await sleep(2500);
      extVer = await sess.evalIsolated(`chrome.runtime.getManifest().version`);
      console.log(`装载重试 ${i + 1}: 版本=${extVer}`);
    }
  }
  check('真实页上加载的是打包产物扩展', extVer === WANT_VER, `版本=${extVer} 浏览器=${REAL ? '真实Chrome' : 'Playwright'}`);

  // 等正文段落出现并滚到
  let scrolled = false;
  for (let i = 0; i < 40 && !scrolled; i++) {
    scrolled = await evalInPage(sess, `(() => { const h = ${FIND_H}; if (!h) return false; h.nextElementSibling.scrollIntoView({ block: 'center' }); return true; })()`);
    if (!scrolled) await sleep(500);
  }
  if (!scrolled) throw new Error('Non-keyed State 段落未出现');
  await sleep(1500);

  // 真实拖选整段
  const dragPara = async () => {
    const p = JSON.parse(await evalInPage(sess, `(() => {
      const h = ${FIND_H};
      const node = document.createTreeWalker(h.nextElementSibling, NodeFilter.SHOW_TEXT).nextNode();
      const len = node.textContent.length;
      const r1 = document.createRange(); r1.setStart(node, 0); r1.setEnd(node, 1);
      const r2 = document.createRange(); r2.setStart(node, len - 1); r2.setEnd(node, len);
      const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
      return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
    })()`));
    await mouse(sess, 'mousePressed', p.x1, p.y1);
    for (let k = 1; k <= 8; k++) await mouse(sess, 'mouseMoved', p.x1 + (p.x2 - p.x1) * k / 8, p.y1);
    await mouse(sess, 'mouseReleased', p.x2, p.y2);
  };
  let host = false;
  for (let attempt = 0; attempt < 3 && !host; attempt++) {
    await dragPara();
    for (let i = 0; i < 10 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
  }
  const selText = await evalInPage(sess, `String(getSelection()).slice(0, 40)`);
  check('真实拖选后工具条弹出', host, `selection="${selText}"`);
  if (!host) throw new Error('工具条未弹出');

  const btn = JSON.parse(await evalInPage(sess, `(() => {
    const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]');
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, title: document.getElementById('om-sel-host').title });
  })()`));
  check('工具条 title 带版本标记', btn.title === `Vela 划词工具条 v${WANT_VER}`, String(btn.title));
  await mouse(sess, 'mousePressed', btn.x, btn.y);
  await mouse(sess, 'mouseReleased', btn.x, btn.y);
  let hl = '';
  for (let i = 0; i < 15 && !hl; i++) { await sleep(200); hl = await evalInPage(sess, `document.querySelector('.om-hl')?.textContent.slice(0, 40) || ''`); }
  check('真实点击高亮生效', !!hl, JSON.stringify(hl));

  if (hl) {
    const inlineBg = await evalInPage(sess, `document.querySelector('.om-hl').style.backgroundColor`);
    check('span 内联底色已写入', /255, ?222, ?89/.test(String(inlineBg)), String(inlineBg));
    const bg = await evalInPage(sess, `getComputedStyle(document.querySelector('.om-hl')).backgroundColor`);
    check('computed 背景 = 黄', bg === 'rgba(255, 222, 89, 0.6)', String(bg));

    // 像素级：整视口截图后按 span 矩形×DPR 本地裁剪统计。
    // 不能用 captureScreenshot 的 clip：滚动页面上 clip 坐标按布局绝对坐标解释（本地页
    // scrollY=0 掩盖了这一点，Flink 页 scrollY≈7800 时 clip 落到页首空白，曾误报 0%）
    const rectDpr = JSON.parse(await evalInPage(sess, `(() => { const r = document.querySelector('.om-hl').getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top, w: Math.min(r.width, 600), h: r.height, dpr: devicePixelRatio }); })()`));
    const shot = await sess.send('Page.captureScreenshot', { format: 'png' });
    const img = decodePng(Buffer.from(shot.data, 'base64'));
    let near = 0, total = 0;
    const x0 = Math.round(rectDpr.l * rectDpr.dpr), y0 = Math.round(rectDpr.t * rectDpr.dpr);
    const x1 = Math.min(img.w, Math.round((rectDpr.l + rectDpr.w) * rectDpr.dpr)), y1 = Math.min(img.h, Math.round((rectDpr.t + rectDpr.h) * rectDpr.dpr));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * img.w + x) * img.ch;
      total++;
      const dr = img.px[o] - 255, dg = img.px[o + 1] - 235, db = img.px[o + 2] - 155;
      if (dr * dr + dg * dg + db * db < 40 * 40) near++;
    }
    check('真实 Flink 页截图像素里高亮色真实画出', total > 0 && near / total > 0.15, `黄色像素占比 ${total ? ((near / total) * 100).toFixed(1) : '0'}%（区域 ${x1 - x0}x${y1 - y0}）`);
  }

  sess.close();
} catch (e) {
  console.error('FAIL 异常', e.message);
  failed = 1;
} finally {
  chrome.kill();
  await sleep(800);
  rmSync(profile, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
  process.exit(failed);
}
