// 高亮无色问题诊断（Request G）：在用户报障的真实页面
// nightlies.apache.org/flink/.../docs/learn-flink/etl/ 的 Non-keyed State 段落
// 真实拖选 → 点高亮，然后逐层检查：
//   span 是否生成 / #om-hl-style 是否在 DOM / 规则是否可从 styleSheets 解析出来 /
//   computed backgroundColor / 页面 CSS 是否覆盖（匹配规则列表） / 截图看实际渲染
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, killTree } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9347;
const URL_ = 'https://nightlies.apache.org/flink/flink-docs-master/docs/learn-flink/etl/';
const SHOT = join(EXT_ROOT, 'dist', 'diag-hl-real.png');

const profile = mkdtempSync(join(tmpdir(), 'vela-diag-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
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
const evalIn = async (sess, expr) => {
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r?.result?.value;
};
const mouse = (sess, type, x, y) => sess.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, pointerType: 'mouse', clickCount: 1 });

try {
  let sess = null;
  for (let i = 0; i < 40 && !sess; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = targets.find((x) => x.type === 'page' && x.url.includes('learn-flink/etl'));
      if (t) { sess = await connect(t.webSocketDebuggerUrl); await sess.send('Runtime.enable'); }
    } catch { /* retry */ }
  }
  if (!sess) throw new Error('页面 target 未出现');
  await sess.send('Page.enable');
  await sess.send('Page.bringToFront');
  await sleep(2500); // 等文档页渲染稳定

  // 滚到 Non-keyed State 段落（选段与用户报障截图一致，含 operator state 链接）。
  // 页面加载慢时正文还没解析出来，轮询等 h3 出现
  const FIND_H = `[...document.querySelectorAll('h3')].filter((x) => x.getBoundingClientRect().width > 0).find((x) => x.textContent.includes('Non-keyed State'))`;
  let scrolled = false;
  for (let i = 0; i < 30 && !scrolled; i++) {
    scrolled = await evalIn(sess, `(() => { const h = ${FIND_H}; if (!h) return false; h.nextElementSibling.scrollIntoView({ block: 'center' }); return true; })()`);
    if (!scrolled) await sleep(500);
  }
  if (!scrolled) throw new Error('正文 Non-keyed State 段落未出现（页面没加载完？）');
  await sleep(1200); // 首屏图片/字体加载会挪布局，多等一拍再取坐标

  // 真实拖选整段；真实页首屏资源会挪布局致拖选塌陷，重取坐标重拖一次（老坑）
  const dragPara = async () => {
    const p = JSON.parse(await evalIn(sess, `(() => {
      const h = ${FIND_H};
      const node = document.createTreeWalker(h.nextElementSibling, NodeFilter.SHOW_TEXT).nextNode();
      const len = node.textContent.length;
      const r1 = document.createRange(); r1.setStart(node, 0); r1.setEnd(node, 1);
      const r2 = document.createRange(); r2.setStart(node, len - 1); r2.setEnd(node, len);
      const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
      return JSON.stringify({ x1: a.left, y: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 });
    })()`));
    await mouse(sess, 'mousePressed', p.x1, p.y);
    for (let k = 1; k <= 8; k++) await mouse(sess, 'mouseMoved', p.x1 + (p.x2 - p.x1) * k / 8, p.y);
    await mouse(sess, 'mouseReleased', p.x2, p.y2);
  };
  let host = false;
  for (let attempt = 0; attempt < 3 && !host; attempt++) {
    await dragPara();
    for (let i = 0; i < 10 && !host; i++) { await sleep(200); host = !!await evalIn(sess, `!!document.getElementById('om-sel-host')`); }
  }
  console.log('工具条弹出:', host, '选区:', await evalIn(sess, `String(getSelection()).slice(0, 60)`));

  // 真实点击高亮钮
  const btn = JSON.parse(await evalIn(sess, `(() => {
    const b = document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]');
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`));
  await mouse(sess, 'mousePressed', btn.x, btn.y);
  await mouse(sess, 'mouseReleased', btn.x, btn.y);
  let hl = '';
  for (let i = 0; i < 15 && !hl; i++) { await sleep(200); hl = await evalIn(sess, `document.querySelector('.om-hl')?.textContent.slice(0, 50) || ''`); }
  console.log('span 文本:', JSON.stringify(hl));

  // 逐层检查：span / 样式元素 / 可解析规则 / computed / 匹配规则链
  const diag = JSON.parse(await evalIn(sess, `(() => {
    const s = document.querySelector('.om-hl');
    if (!s) return JSON.stringify({ span: false });
    const st = document.getElementById('om-hl-style');
    let rules = [];
    for (const ss of document.styleSheets) {
      let list = [];
      try { list = ss.cssRules; } catch { rules.push({ sheet: ss.href || 'inline', err: 'cross-origin' }); continue; }
      for (const r of list) if (r.selectorText && r.selectorText.includes('om-hl')) rules.push({ sel: r.selectorText, css: r.cssText.slice(0, 120), sheet: ss.href ? ss.href.split('/').pop() : 'inline' });
    }
    const cs = getComputedStyle(s);
    const matched = [];
    if (window.getMatchedCSSRules === undefined) {
      // 无 getMatchedCSSRules：用手写特异性判断 + element.matches
      for (const ss of document.styleSheets) {
        let list; try { list = ss.cssRules; } catch { continue; }
        for (const r of list) {
          if (!r.selectorText) continue;
          try { if (s.matches(r.selectorText) && r.style && (r.style.background || r.style.backgroundColor)) matched.push({ sel: r.selectorText, bg: r.style.background || r.style.backgroundColor }); } catch {}
        }
      }
    }
    const r = s.getBoundingClientRect();
    return JSON.stringify({
      span: true,
      styleEl: { inDoc: !!st, parent: st?.parentElement?.nodeName, sheets: st?.sheet ? st.sheet.cssRules.length : -1 },
      rules,
      computed: { bg: cs.backgroundColor, display: cs.display, color: cs.color },
      matched,
      rect: { w: r.width, h: r.height },
    });
  })()`));
  console.log('诊断:', JSON.stringify(diag, null, 2));

  // 页面里对 span 的祖先有没有 background 干扰（如混入透明覆盖层）
  const anc = await evalIn(sess, `(() => {
    const s = document.querySelector('.om-hl'); const out = [];
    let el = s;
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.filter !== 'none' || cs.mixBlendMode !== 'normal') {
        out.push({ tag: el.tagName + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''), bg: cs.backgroundColor, filter: cs.filter, blend: cs.mixBlendMode });
      }
      el = el.parentElement;
    }
    return out;
  })()`);
  console.log('祖先异常样式:', JSON.stringify(anc));

  // 截图高亮区域（含胶囊）看真实渲染
  const clip = await evalIn(sess, `(() => {
    const s = document.querySelector('.om-hl');
    const r = s.getBoundingClientRect();
    return { x: Math.max(0, r.left - 40), y: Math.max(0, r.top - 60), width: Math.min(r.width + 80, innerWidth), height: r.height + 120, scale: 1 };
  })()`);
  const shot = await sess.send('Page.captureScreenshot', { format: 'png', clip });
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log('截图:', SHOT);

  sess.close();
} catch (e) {
  console.error('FAIL 异常', e.message);
} finally {
  await killTree(chrome);
  await sleep(800);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
