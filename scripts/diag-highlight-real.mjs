// 诊断：高亮在真实文档页（Apache Flink docs，含行内 <code> 的段落）是否生效。
// 用户两轮反馈「高亮功能还是没有用」，本地静态页 e2e 全过——差异在真实页面结构。
// 本脚本走真实 CDP 输入：拖选 → 工具条 → 点高亮 → 检查 .om-hl / 计算样式 / 是否被框架清掉。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, killTree } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9347;
const URL_ = 'https://nightlies.apache.org/flink/flink-docs-release-2.0-preview1/docs/learn-flink/etl';

const profile = mkdtempSync(join(tmpdir(), 'vela-diag-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  `--window-size=1400,2000`,
  URL_,
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
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
  return r?.result?.value;
};
const mouse = (sess, type, x, y) => sess.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, pointerType: 'mouse', clickCount: 1 });

// 页面侧：定位含短语的 <p>，返回拖选起止字符坐标。
// anchor: 'plain' = 只选 <code> 前的纯文本；'cross' = 跨到行内 <code> 末尾
const marksJs = (mode) => `(() => {
  const mode = ${JSON.stringify(mode)};
  // 只认不在 <pre> 里、可见的正文段落文本节点（代码示例里也可能出现同短语）
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let tn = null;
  let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement;
    if (!el || el.closest('pre')) continue;
    if (!n.textContent.includes('together with a')) continue;
    if (el.getBoundingClientRect().height > 0) { tn = n; break; }
  }
  if (!tn) return JSON.stringify({ err: '未找到正文文本节点' });
  const p = tn.parentElement.closest('p') || tn.parentElement;
  p.scrollIntoView({ block: 'center' });
  const start = tn.textContent.indexOf('together');
  const r1 = document.createRange(); r1.setStart(tn, start); r1.setEnd(tn, start + 1);
  const a = r1.getBoundingClientRect();
  let endNode = tn, endOff = start + 'together with a'.length;
  if (mode === 'cross') {
    const code = p.querySelector('code');
    if (!code) return JSON.stringify({ err: '段内无 <code>' });
    endNode = code.firstChild; endOff = endNode.textContent.length;
  }
  const r2 = document.createRange(); r2.setStart(endNode, Math.max(0, endOff - 1)); r2.setEnd(endNode, endOff);
  const b = r2.getBoundingClientRect();
  return JSON.stringify({ x1: a.left, y: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2, inCode: endNode.parentElement.tagName === 'CODE' });
})()`;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = 1;
};

async function runCase(sess, label, mode) {
  let m = JSON.parse(await evalInPage(sess, marksJs(mode)));
  if (m.err) { check(label + ': 定位选区', false, m.err); return; }
  await sleep(300);
  // 首屏图片/字体加载会挪动布局导致拖选塌陷：选区为空时重取坐标再拖一次
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      m = JSON.parse(await evalInPage(sess, marksJs(mode)));
      await sleep(300);
    }
    await mouse(sess, 'mousePressed', m.x1, m.y1 ?? m.y);
    for (let k = 1; k <= 8; k++) await mouse(sess, 'mouseMoved', m.x1 + (m.x2 - m.x1) * k / 8, m.y);
    await mouse(sess, 'mouseReleased', m.x2, m.y2);
    await sleep(400);
    if (await evalInPage(sess, `String(getSelection())`).then((s) => s.trim())) break;
  }
  let host = false;
  for (let i = 0; i < 15 && !host; i++) { await sleep(200); host = !!await evalInPage(sess, `!!document.getElementById('om-sel-host')`); }
  const selText = await evalInPage(sess, `String(getSelection())`);
  if (!host) { check(`${label}: 工具条弹出`, false, `selection="${selText.slice(0, 40)}"`); return; }
  console.log(`  selection="${selText.slice(0, 40)}"`);
  const btn = JSON.parse(await evalInPage(sess, `(() => {
    const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]');
    if (!b) return JSON.stringify({ err: '无高亮钮(代码模式?)' });
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  if (btn.err) { check(`${label}: 高亮钮存在`, false, btn.err); return; }
  await mouse(sess, 'mousePressed', btn.x, btn.y);
  await mouse(sess, 'mouseReleased', btn.x, btn.y);
  let info = null;
  for (let i = 0; i < 15 && !info; i++) {
    await sleep(200);
    info = await evalInPage(sess, `(() => {
      const s = document.querySelector('p .om-hl') || document.querySelector('.om-hl');
      if (!s) return null;
      const cs = getComputedStyle(s);
      return JSON.stringify({ text: s.textContent.slice(0, 40), bg: cs.backgroundColor, cls: s.className, connected: !!s.isConnected });
    })()`);
  }
  check(`${label}: 点击高亮后出现 .om-hl`, !!info, info || '未出现任何 .om-hl span');
  if (info) {
    const d = JSON.parse(info);
    check(`${label}: 背景色已绘制`, d.bg !== 'rgba(0, 0, 0, 0)' && d.bg !== 'transparent', d.bg);
    // Monica 式即时反馈：高亮后悬停胶囊直接挂出；点绿色色点换色；点删除还原
    const pill = !!await evalInPage(sess, `!!document.getElementById('om-sel-hlbtn-host')`);
    check(`${label}: 悬停胶囊即时挂出`, pill);
    if (pill) {
      const dot = JSON.parse(await evalInPage(sess, `(() => {
        const d = document.getElementById('om-sel-hlbtn-host').shadowRoot.querySelector('.dot[data-c="g"]');
        const r = d.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`));
      await mouse(sess, 'mousePressed', dot.x, dot.y);
      await mouse(sess, 'mouseReleased', dot.x, dot.y);
      const c = await evalInPage(sess, `document.querySelector('.om-hl')?.dataset.c || ''`);
      check(`${label}: 真实点击色点换色`, c === 'g', c);
      const del = JSON.parse(await evalInPage(sess, `(() => {
        const b = document.getElementById('om-sel-hlbtn-host').shadowRoot.querySelector('button[title="删除高亮"]');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`));
      await mouse(sess, 'mousePressed', del.x, del.y);
      await mouse(sess, 'mouseReleased', del.x, del.y);
      let gone = false;
      for (let i = 0; i < 15 && !gone; i++) { await sleep(200); gone = !await evalInPage(sess, `!!document.querySelector('.om-hl')`); }
      check(`${label}: 真实点击删除高亮`, gone);
      return;
    }
    await sleep(2500); // 等一轮框架重渲/懒加载
    const still = await evalInPage(sess, `!!document.querySelector('.om-hl')`);
    check(`${label}: 2.5s 后高亮仍在`, still);
  }
}

try {
  let sess = null;
  for (let i = 0; i < 40 && !sess; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = targets.find((x) => x.type === 'page' && x.url.startsWith('https://nightlies.apache.org'));
      if (t) { sess = await connect(t.webSocketDebuggerUrl); await sess.send('Runtime.enable'); }
    } catch { /* retry */ }
  }
  if (!sess) throw new Error('Flink docs target 未出现');
  await sess.send('Page.enable');
  await sess.send('Page.bringToFront');
  // 等页面渲染完成（找得到目标段落为准）
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    await sleep(1000);
    ready = await evalInPage(sess, `[...document.querySelectorAll('p')].some((x) => x.textContent.includes('together with a FlatMapFunction'))`);
  }
  if (!ready) throw new Error('页面未渲染出目标段落');
  await evalInPage(sess, `(() => { window.__omLogs = []; const ow = console.warn; console.warn = (...a) => { window.__omLogs.push(a.join(' ')); ow(...a); }; return true; })()`);

  await runCase(sess, '纯文本段内选(together with a)', 'plain');
  await runCase(sess, '跨行内 <code> 选(together with a FlatMapFunction)', 'cross');
  console.log('页面 warn:', JSON.stringify(await evalInPage(sess, `window.__omLogs || []`)));
  sess.close();
} catch (e) {
  console.error('FAIL 异常', e.message);
  failed = 1;
} finally {
  await killTree(chrome);
  await sleep(800);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  process.exit(failed);
}
