// 打包产物高亮验证（Request G 收尾）：不测源码目录，测 dist/vela-X.Y.Z.zip 解包后的产物。
// 覆盖到像素级：截图 span 区域并解码 PNG，断言画面里真有高亮色（computed style 只能证明
// CSS 算对了，证明不了画出来了）。另测 forced-colors（Windows 高对比度）下颜色是否保住。
// 用法：node scripts/verify-package-hl.mjs [zip路径]
//   VELA_CHROME=<chrome.exe> 可换浏览器（默认 Playwright Chromium，可指真实安装的 Chrome）
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ZIP = process.argv[2] ?? join(EXT_ROOT, 'dist', 'vela-0.7.10.zip');
const CHROME = process.env.VELA_CHROME ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe');
const REAL = Boolean(process.env.VELA_CHROME); // 真实 Chrome 137+：--load-extension 已移除，走 CDP loadUnpacked
const PORT = 9352;
const WEB = 39317;

// ---- 最小 PNG 解码：8-bit 非隔行，RGB(2)/RGBA(6)，只要像素采样 ----
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('非 PNG');
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

const PAGE = `<!doctype html><html><head><style>body{margin:40px;background:#fff;font:20px/1.6 serif;}p{max-width:600px;}</style></head><body>
<p id="txt">The quick brown fox jumps over the lazy dog near the river bank and runs away quickly.</p>
</body></html>`;
const server = createServer((req, res) => {
  if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

// 解包产物目录（Windows 自带 bsdtar 可读 zip）
const extDir = mkdtempSync(join(tmpdir(), 'vela-pkg-ext-'));
const t0 = spawnSync('C:\\Windows\\System32\\tar.exe', ['-xf', ZIP, '-C', extDir], { encoding: 'utf8' });
if (t0.status !== 0) throw new Error('解包失败: ' + t0.stderr);

const profile = mkdtempSync(join(tmpdir(), 'vela-pkg-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`,
  ...(process.env.VELA_CHROME ? [] : [`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`]),
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  // Chrome 137+ 移除 --load-extension：真实 Chrome 走 CDP Extensions.loadUnpacked（需要本 flag）
  '--enable-unsafe-extension-debugging',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  `http://127.0.0.1:${WEB}/page`,
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

try {
  let sess = null;
  for (let i = 0; i < 30 && !sess; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = targets.find((x) => x.type === 'page' && x.url.startsWith(`http://127.0.0.1:${WEB}/page`));
      if (t) { sess = await connect(t.webSocketDebuggerUrl); await sess.send('Runtime.enable'); }
    } catch { /* retry */ }
  }
  if (!sess) throw new Error('测试页 target 未出现');
  await sess.send('Page.enable');
  await sess.send('Page.bringToFront');
  await sleep(1500);

  // Chrome 137+ 移除了 --load-extension：真实 Chrome 上要经 CDP Extensions.loadUnpacked 装载。
  // 先探测扩展是否已在（Playwright Chromium 认 --load-extension），不在再走 loadUnpacked + 重载
  await sleep(500); // 等事件把 isolated context 收全
  let extVer = await sess.evalIsolated(`chrome.runtime.getManifest().version`);
  if (extVer !== '0.7.10' && REAL) {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const brws = await connect(ver.webSocketDebuggerUrl);
    const loaded = await brws.send('Extensions.loadUnpacked', { path: extDir });
    if (loaded?.error) throw new Error('Extensions.loadUnpacked 失败: ' + JSON.stringify(loaded.error));
    console.log('已通过 CDP loadUnpacked 装载产物');
    brws.close();
    // SW 启动 + registerContentScripts 需要时间；reload 后重试取 isolated context
    for (let i = 0; i < 5 && extVer !== '0.7.10'; i++) {
      await sleep(1500);
      await sess.send('Page.reload');
      await sleep(2000);
      extVer = await sess.evalIsolated(`chrome.runtime.getManifest().version`);
      console.log(`装载重试 ${i + 1}: 版本=${extVer} contexts=${sess.contexts.size}`);
    }
  }
  check('加载的是打包产物扩展', extVer === '0.7.10', `版本=${extVer}`);
  console.log('产物文件数:', readdirSync(extDir).length);

  // 1) 真实拖选 → 工具条 → 真实点高亮
  const marks = JSON.parse(await evalInPage(sess, `(() => {
    const node = document.createTreeWalker(document.getElementById('txt'), NodeFilter.SHOW_TEXT).nextNode();
    const r1 = document.createRange(); r1.setStart(node, 4); r1.setEnd(node, 5);
    const r2 = document.createRange(); r2.setStart(node, 30); r2.setEnd(node, 31);
    const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
    return JSON.stringify({ x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
  })()`));
  await mouse(sess, 'mousePressed', marks.x1, marks.y1);
  for (let k = 1; k <= 8; k++) await mouse(sess, 'mouseMoved', marks.x1 + (marks.x2 - marks.x1) * k / 8, marks.y1);
  await mouse(sess, 'mouseReleased', marks.x2, marks.y2);
  let host = false;
  for (let i = 0; i < 15 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
  const selText = await evalInPage(sess, `String(getSelection())`);
  check('真实拖选后工具条弹出', host, `selection="${selText}"`);
  const btn = JSON.parse(await evalInPage(sess, `(() => {
    const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]');
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  await mouse(sess, 'mousePressed', btn.x, btn.y);
  await mouse(sess, 'mouseReleased', btn.x, btn.y);
  let hl = '';
  for (let i = 0; i < 15 && !hl; i++) { await sleep(200); hl = await evalInPage(sess, `document.querySelector('.om-hl')?.textContent || ''`); }
  check('真实点击高亮生效', !!hl && hl.trim() === selText.trim(), JSON.stringify(hl));

  // 2) 内联底色 + computed + 样式表移除兜底
  const inlineBg = await evalInPage(sess, `document.querySelector('.om-hl').style.backgroundColor`);
  check('span 内联底色已写入（不依赖样式表）', /255, ?222, ?89/.test(String(inlineBg)), String(inlineBg));
  await evalInPage(sess, `document.getElementById('om-hl-style')?.remove()`);
  const bgNoSheet = await evalInPage(sess, `getComputedStyle(document.querySelector('.om-hl')).backgroundColor`);
  check('样式表被移除后仍显色', bgNoSheet === 'rgba(255, 222, 89, 0.6)', String(bgNoSheet));

  // 3) 像素级验证：截图 span 区域，解码 PNG，统计接近黄色混合值的像素占比
  //    黄 rgba(255,222,89,.6) 叠白底 → (255, 235, 155)
  const clip = await evalInPage(sess, `(() => {
    const r = document.querySelector('.om-hl').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, scale: 1 };
  })()`);
  const shot = await sess.send('Page.captureScreenshot', { format: 'png', clip });
  const img = decodePng(Buffer.from(shot.data, 'base64'));
  let near = 0, total = 0;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const o = (y * img.w + x) * img.ch;
    total++;
    const dr = img.px[o] - 255, dg = img.px[o + 1] - 235, db = img.px[o + 2] - 155;
    if (dr * dr + dg * dg + db * db < 40 * 40) near++;
  }
  const ratio = near / total;
  check('截图像素里高亮色真实画出', ratio > 0.15, `黄色像素占比 ${(ratio * 100).toFixed(1)}%（画面 ${img.w}x${img.h}）`);

  // 4) forced-colors（Windows 高对比度）下颜色保住：forced-color-adjust:none
  await sess.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  await sleep(300);
  const bgFc = await evalInPage(sess, `getComputedStyle(document.querySelector('.om-hl')).backgroundColor`);
  check('forced-colors 激活下高亮色保住', bgFc === 'rgba(255, 222, 89, 0.6)', String(bgFc));
  await sess.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: '' }] });

  // 5) 悬停胶囊 + 版本标记（title）
  const hlPt = JSON.parse(await evalInPage(sess, `(() => {
    const r = document.querySelector('.om-hl').getBoundingClientRect();
    return JSON.stringify({ x: r.left + 20, y: r.top + r.height / 2 });
  })()`));
  await mouse(sess, 'mouseMoved', hlPt.x, hlPt.y);
  let pill = false;
  for (let i = 0; i < 15 && !pill; i++) { await sleep(200); pill = !!await evalInPage(sess, `!!document.getElementById('om-sel-hlbtn-host')`); }
  check('悬停胶囊挂出', pill);
  if (pill) {
    const t = await evalInPage(sess, `document.getElementById('om-sel-hlbtn-host').title`);
    check('胶囊 title 带版本标记', t === 'Vela 高亮 v0.7.10', String(t));
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
  rmSync(extDir, { recursive: true, force: true });
  process.exit(failed);
}
