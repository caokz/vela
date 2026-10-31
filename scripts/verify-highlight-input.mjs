// 高亮真实输入路径 e2e：不用程序化 .click()，全部走 CDP Input.dispatchMouseEvent
// （真实信任事件：pointerdown → mousedown → selectionchange → mouseup → click 完整时序）。
// 若这条路径挂而程序化路径过，说明真实点击在事件时序里被某处拦截。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9341;
const WEB = 39311;

// 普通段落留足边距：顶部 220px 让工具条按常态弹在选区上方（胶囊在高亮下方，鼠标得穿过正文才够得着）
const PAGE = `<!doctype html><html><head><style>body{margin:220px 40px 40px;font:20px/1.6 serif;}p{max-width:600px;}</style></head><body>
<p id="txt">The quick brown fox jumps over the lazy dog near the river bank and runs away.</p>
</body></html>`;
const server = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'vela-hl-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  `http://127.0.0.1:${WEB}/page`,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
  let msgId = 0;
  const pending = new Map();
  const contexts = new Map(); // executionContextCreated 事件收集：主世界 + 扩展 ISOLATED 世界
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return; }
    if (m.method === 'Runtime.executionContextCreated') {
      const ctx = m.params.context;
      contexts.set(ctx.id, ctx);
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return {
    send, contexts, close: () => ws.close(),
    // 在扩展 ISOLATED 世界求值（content script 的 window 与异常都在这个世界，主世界看不到）
    evalIsolated: async (expr) => {
      for (const [id, ctx] of contexts) {
        if (ctx.auxData?.isDefault) continue; // 主世界跳过
        const probe = await send('Runtime.evaluate', { expression: 'typeof chrome?.runtime?.id', contextId: id, returnByValue: true });
        if (probe?.result?.value !== 'string') continue; // 不是扩展世界（chrome.runtime 未暴露）
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
// clickCount 必带：CDP 合成输入不带 clickCount 时 Chrome 不派发 click 事件
const mouse = (sess, type, x, y, extra = {}) => sess.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, pointerType: 'mouse', clickCount: 1, ...extra });

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
  await sess.send('Page.reload');
  await sleep(2000);
  await sess.send('Page.bringToFront');
  await sleep(300);

  // 页面控制台报错全收集
  const logs = [];
  await sess.send('Log.enable');
  sess.send('Runtime.discardConsoleEntries').catch(() => {});
  // Runtime.consoleAPICalled 需要事件回调；本脚本 connect 不派发事件，改走注入 hook 兜底后置读取
  await evalInPage(sess, `(() => { window.__omLogs = []; const orig = console.warn; console.warn = (...a) => { window.__omLogs.push(a.join(' ')); orig(...a); }; window.addEventListener('error', (e) => window.__omLogs.push('ERROR: ' + e.message + ' @ ' + (e.filename || '') + ':' + e.lineno)); return true; })()`);
  // 扩展 ISOLATED 世界同样挂错误钩子：content script 内的异常主世界看不到
  await sess.evalIsolated(`window.addEventListener('error', (e) => (window.__omIsoErrs = window.__omIsoErrs || []).push(e.message + ' @' + (e.filename || '') + ':' + e.lineno))`);

  // 1) 真实拖选 quick brown fox（字符 4..19）
  const marks = JSON.parse(await evalInPage(sess, `(() => {
    const node = document.createTreeWalker(document.getElementById('txt'), NodeFilter.SHOW_TEXT).nextNode();
    const r1 = document.createRange(); r1.setStart(node, 5); r1.setEnd(node, 6);
    const r2 = document.createRange(); r2.setStart(node, 18); r2.setEnd(node, 19);
    const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
    return JSON.stringify({ x1: a.left, y: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
  })()`));
  await mouse(sess, 'mousePressed', marks.x1, marks.y);
  for (let k = 1; k <= 6; k++) await mouse(sess, 'mouseMoved', marks.x1 + (marks.x2 - marks.x1) * k / 6, marks.y);
  await mouse(sess, 'mouseReleased', marks.x2, marks.y2);
  let host = false;
  for (let i = 0; i < 15 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
  const selText = await evalInPage(sess, `String(getSelection())`);
  check('真实拖选后工具条弹出', host, `selection="${selText}"`);

  // 2) 真实点击「高亮」钮：完整 pointerdown→mousedown→mouseup→click 时序
  const btn = JSON.parse(await evalInPage(sess, `(() => {
    const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]');
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  const selAfterDown = {};
  await mouse(sess, 'mousePressed', btn.x, btn.y);
  await sleep(120); // mousedown 后、mouseup 前：观察选区/工具条是否已被清掉
  selAfterDown.host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`);
  selAfterDown.sel = await evalInPage(sess, `String(getSelection())`);
  await mouse(sess, 'mouseReleased', btn.x, btn.y);
  let hl = '';
  for (let i = 0; i < 15 && !hl; i++) { await sleep(200); hl = await evalInPage(sess, `document.querySelector('.om-hl')?.textContent || ''`); }
  check('真实点击高亮生效', !!hl && hl === selText.trim(), JSON.stringify(hl));
  if (!host || !hl) {
    console.log('调试: mousedown 后工具条存活=' + selAfterDown.host + ' 选区="' + selAfterDown.sel + '"');
    console.log('调试: 页面 warn:', JSON.stringify(await evalInPage(sess, `window.__omLogs || []`)));
  }

  // 2b) Monica 式即时反馈：高亮生成后悬停胶囊直接挂出（无需再悬停一次）
  const pill = !!await evalInPage(sess, `!!document.getElementById('om-sel-hlbtn-host')`);
  check('高亮后悬停胶囊即时挂出', pill);
  if (!pill) {
    console.log('调试: 页面日志:', JSON.stringify(await evalInPage(sess, `window.__omLogs || []`)));
    console.log('调试: isolated 异常:', JSON.stringify(await sess.evalIsolated(`window.__omIsoErrs || []`)));
    console.log('调试: hlState:', JSON.stringify(await sess.evalIsolated(`window.__omSelPopup?.hlState?.()`)));
  }

  if (pill) {
    // 2c) 真实点击绿色色点换色：按真人轨迹从「高亮」钮位置分步移到色点（中途必然划过正文
    //     与选区外空白——旧版在第一个正文 mouseover 就把胶囊收掉，色点永远点不到）
    const dot = JSON.parse(await evalInPage(sess, `(() => {
      const d = document.getElementById('om-sel-hlbtn-host').shadowRoot.querySelector('.dot[data-c="g"]');
      const r = d.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`));
    await sleep(350); // 真人反应时间：看到胶囊再动鼠标
    await mouse(sess, 'mouseMoved', btn.x, btn.y + 1); // 光标原地微动：触发 Blink 对「工具条消失后光标下元素」的 hover 重算
    await sleep(600);
    check('高亮后光标停在原处 950ms 胶囊仍在（旧版约 260ms 被收）', !!await evalInPage(sess, `!!document.getElementById('om-sel-hlbtn-host')`));
    // 细步长（≤3px）：高亮与胶囊之间有 6px 空隙，粗步长会跳过空隙、测不出「划过空隙即收」
    const steps = Math.max(12, Math.ceil(Math.hypot(dot.x - btn.x, dot.y - btn.y) / 3));
    for (let k = 1; k <= steps; k++) {
      await mouse(sess, 'mouseMoved', btn.x + (dot.x - btn.x) * k / steps, btn.y + (dot.y - btn.y) * k / steps);
      await sleep(15);
    }
    check('鼠标从工具条移向胶囊途中胶囊不消失', !!await evalInPage(sess, `!!document.getElementById('om-sel-hlbtn-host')`));
    await mouse(sess, 'mousePressed', dot.x, dot.y);
    await mouse(sess, 'mouseReleased', dot.x, dot.y);
    const rd = JSON.parse(await evalInPage(sess, `(() => {
      const s = document.querySelector('.om-hl');
      return JSON.stringify({ c: s?.dataset.c || '', bg: s ? getComputedStyle(s).backgroundColor : '' });
    })()`));
    check('点击色点换色生效', rd.c === 'g' && rd.bg === 'rgba(96, 220, 140, 0.5)', JSON.stringify(rd));
    check('换色后胶囊保持（可继续试色）', !!await evalInPage(sess, `!!document.getElementById('om-sel-hlbtn-host')`));

    // 2c-bis) 双保险：颜色同时写在内联样式上——样式元素被页面移除/改写后仍显色
    //   （真实报障形态：span 在、胶囊在，但看不到颜色）
    const inlineBg = await evalInPage(sess, `document.querySelector('.om-hl').style.background || document.querySelector('.om-hl').style.backgroundColor`);
    check('内联底色已写入 span', /96, ?220, ?140/.test(String(inlineBg)), String(inlineBg));
    await evalInPage(sess, `document.getElementById('om-hl-style')?.remove()`);
    const bgNoSheet = await evalInPage(sess, `getComputedStyle(document.querySelector('.om-hl')).backgroundColor`);
    check('样式表被移除后高亮仍显色（内联兜底）', bgNoSheet === 'rgba(96, 220, 140, 0.5)', String(bgNoSheet));

    // 2d) 鼠标移开胶囊延时收起（悬停胶囊 300ms，刚挂出的即时胶囊 1.5s）；悬停高亮区再挂出
    await mouse(sess, 'mouseMoved', 30, 30);
    let gonePill = false;
    for (let i = 0; i < 15 && !gonePill; i++) { await sleep(200); gonePill = !(await evalInPage(sess, `!!document.getElementById('om-sel-hlbtn-host')`)); }
    check('移出后胶囊收起', gonePill);
    const hlPt = JSON.parse(await evalInPage(sess, `(() => {
      const r = document.querySelector('.om-hl').getBoundingClientRect();
      return JSON.stringify({ x: r.left + 20, y: r.top + r.height / 2 });
    })()`));
    await mouse(sess, 'mouseMoved', hlPt.x, hlPt.y);
    let rehover = false;
    for (let i = 0; i < 15 && !rehover; i++) { await sleep(200); rehover = !!await evalInPage(sess, `!!document.getElementById('om-sel-hlbtn-host')`); }
    check('悬停高亮区胶囊再挂出', rehover);

    // 2e) 真实点击删除钮：span 摘除、文本还原
    if (rehover) {
      const del = JSON.parse(await evalInPage(sess, `(() => {
        const b = document.getElementById('om-sel-hlbtn-host').shadowRoot.querySelector('button[title="删除高亮"]');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`));
      const before = await evalInPage(sess, `document.getElementById('txt').textContent`);
      await mouse(sess, 'mousePressed', del.x, del.y);
      await mouse(sess, 'mouseReleased', del.x, del.y);
      let removed = false;
      for (let i = 0; i < 15 && !removed; i++) { await sleep(200); removed = !await evalInPage(sess, `!!document.querySelector('.om-hl')`); }
      const after = await evalInPage(sess, `document.getElementById('txt').textContent`);
      check('点击删除高亮并还原文本', removed && before === after);
    }
  }

  // 重建高亮（供第 3 步「工具条 on 态取消」路径；若上面已删除）
  if (!(await evalInPage(sess, `!!document.querySelector('.om-hl')`))) {
    await mouse(sess, 'mousePressed', marks.x1, marks.y);
    for (let k = 1; k <= 6; k++) await mouse(sess, 'mouseMoved', marks.x1 + (marks.x2 - marks.x1) * k / 6, marks.y);
    await mouse(sess, 'mouseReleased', marks.x2, marks.y2);
    let host2 = false;
    for (let i = 0; i < 15 && !host2; i++) { await sleep(200); host2 = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
    if (host2) {
      const btnR = JSON.parse(await evalInPage(sess, `(() => {
        const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`));
      await mouse(sess, 'mousePressed', btnR.x, btnR.y);
      await mouse(sess, 'mouseReleased', btnR.x, btnR.y);
      for (let i = 0; i < 15; i++) { await sleep(200); if (await evalInPage(sess, `!!document.querySelector('.om-hl')`)) break; }
    }
  }

  // 3) 再选同一段（已在高亮 span 内），真实点击取消
  const marks2 = JSON.parse(await evalInPage(sess, `(() => {
    const node = document.createTreeWalker(document.querySelector('.om-hl'), NodeFilter.SHOW_TEXT).nextNode();
    const len = node.textContent.length;
    const r1 = document.createRange(); r1.setStart(node, 0); r1.setEnd(node, 1);
    const r2 = document.createRange(); r2.setStart(node, len - 1); r2.setEnd(node, len);
    const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
    return JSON.stringify({ x1: a.left, y: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
  })()`));
  await mouse(sess, 'mousePressed', marks2.x1, marks2.y);
  for (let k = 1; k <= 6; k++) await mouse(sess, 'mouseMoved', marks2.x1 + (marks2.x2 - marks2.x1) * k / 6, marks2.y);
  await mouse(sess, 'mouseReleased', marks2.x2, marks2.y2);
  host = false;
  for (let i = 0; i < 15 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
  check('高亮区内再选工具条弹出', host);
  const onCls = await evalInPage(sess, `document.getElementById('om-sel-host')?.shadowRoot.querySelector('[data-act="highlight"]')?.className || ''`);
  check('高亮钮亮 on 态', onCls.includes('on'), onCls);
  const btn2 = JSON.parse(await evalInPage(sess, `(() => {
    const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]');
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  await mouse(sess, 'mousePressed', btn2.x, btn2.y);
  await mouse(sess, 'mouseReleased', btn2.x, btn2.y);
  let gone = false;
  for (let i = 0; i < 15 && !gone; i++) { await sleep(200); gone = !await evalInPage(sess, `!!document.querySelector('.om-hl')`); }
  check('真实点击取消高亮', gone);

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
