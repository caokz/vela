// 复制按钮兜底 e2e：聊天卡是嵌在宿主页里的扩展源 iframe。
// 1) 普通页（无 Permissions-Policy 头）：iframe 加了 allow="clipboard-write"，
//    原生 Clipboard API 应直接可用（修复前默认 allowlist=self 挡跨源 iframe）。
// 2) 严格页（响应头 Permissions-Policy: clipboard-write=()）：原生 API 必被挡
//    （复现用户报错），复制按钮须走 execCommand 兜底并提示「已复制」。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9345;
const WEB = 39321;

const PAGE = '<!doctype html><html><body><p id="txt">The quick brown fox jumps over the lazy dog.</p></body></html>';
const server = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  } else if (req.url === '/strict') {
    // 页面自身及所有子 frame 都禁掉 clipboard-write：allow 属性也救不回来，
    // 只能靠 execCommand 兜底（复现用户「聊天框点击复制报错」的极端形态）
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'permissions-policy': 'clipboard-write=()' });
    res.end(PAGE);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'vela-cp-'));
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
async function waitTarget(urlPart) {
  for (let i = 0; i < 24; i++) {
    await sleep(400);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const t = targets.find((x) => ['page', 'iframe'].includes(x.type) && x.url.includes(urlPart) && x.webSocketDebuggerUrl);
    if (t) {
      try {
        const s = await connect(t.webSocketDebuggerUrl);
        await s.send('Runtime.enable');
        return s;
      } catch { continue; }
    }
  }
  return null;
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = 1;
};

try {
  // 扩展 ID + 种子：一条 engine:llm 会话，预置一问一答（答案带可复制内容）
  let extId = '';
  for (let i = 0; i < 40 && !extId; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js'));
      if (sw) extId = new URL(sw.url).host;
    } catch { /* retry */ }
  }
  if (!extId) throw new Error('SW 未注册');
  const optTarget = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/src/options/options.html`, { method: 'PUT' })).json();
  await sleep(800);
  const optSess = await connect(optTarget.webSocketDebuggerUrl);
  await optSess.send('Runtime.enable');
  const seed = await evalIn(optSess, `(async () => {
    const now = Date.now();
    await chrome.storage.local.set({
      llmSettings: {
        providers: [{ id: 'p1', name: 'fake', kind: 'openai', baseUrl: 'http://127.0.0.1:${WEB}/v1', apiKey: 'k', models: ['fake-model'] }],
        activeProviderId: 'p1',
      },
      conversations: [{
        id: 'conv:t', title: '复制测试', createdAt: now, updatedAt: now, engine: 'llm',
        items: [
          { id: 'msg:q', conversationId: 'conv:t', type: 'question', parentItemId: '', content: '问题', createdAt: now },
          { id: 'msg:a', conversationId: 'conv:t', type: 'answer', parentItemId: 'msg:q', content: 'COPY-ME-12345', model: 'fake-model', createdAt: now, stopped: false, error: '' },
        ],
      }],
    });
    return 'ok';
  })()`);
  if (seed !== 'ok') throw new Error('种子未落 storage: ' + seed);
  optSess.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${optTarget.id}`);

  async function runCardCase(path, label) {
    // 走到目标页（种子写完后重开页面，卡片才会读到会话）
    const pageSess0 = await waitTarget(`127.0.0.1:${WEB}/page`);
    await evalIn(pageSess0, `location.href = 'http://127.0.0.1:${WEB}${path}'`);
    await sleep(1500);
    let page = null;
    for (let i = 0; i < 10 && !page; i++) {
      page = await waitTarget(`127.0.0.1:${WEB}${path}`);
      if (page) break;
    }
    if (!page) throw new Error(`${path} 页未就绪`);
    await page.send('Page.enable');
    await page.send('Page.bringToFront');
    await sleep(300);
    // 点浮窗胶囊开聊天卡（真实点击路径不必需，程序化即可：只测卡片内行为）
    await evalIn(page, `document.getElementById('om-widget-host')?.shadowRoot.querySelector('.pill').click()`);
    const card = await waitTarget('src/sidepanel/sidepanel.html');
    if (!card) throw new Error('聊天卡 target 未出现');
    // 等答案渲染出动作行
    let copyBtn = false;
    for (let i = 0; i < 20 && !copyBtn; i++) {
      await sleep(400);
      copyBtn = !!await evalIn(card, `!!document.querySelector('.om-msg-actions [aria-label="复制 Markdown"]')`);
    }
    check(`${label}: 会话答案带复制钮`, copyBtn);
    // iframe 里原生 Clipboard API 是否可用（allow 委托 vs 页面策略头）
    const nativeOk = await evalIn(card, `(async () => { try { await navigator.clipboard.writeText('probe'); return true; } catch (e) { return e.message.slice(0, 60); } })()`);
    return { card, nativeOk };
  }

  // 场景 1：普通页 —— allow="clipboard-write" 让原生 API 直接可用
  {
    const { card, nativeOk } = await runCardCase('/page', '普通页');
    check('普通页: 聊天卡 iframe 原生剪贴板可用（allow 委托）', nativeOk === true, String(nativeOk));
    await evalIn(card, `document.querySelector('.om-msg-actions [aria-label="复制 Markdown"]').click()`);
    await sleep(500);
    const toast = await evalIn(card, `document.getElementById('om-toast')?.textContent || ''`);
    check('普通页: 点击复制提示已复制', toast === '已复制 Markdown', toast);
    card.close();
  }

  // 场景 2：严格页（Permissions-Policy: clipboard-write=()）—— 复现报错，兜底须生效
  {
    const { card, nativeOk } = await runCardCase('/strict', '严格页');
    check('严格页: 原生剪贴板被页面策略挡住（复现条件）', nativeOk !== true, String(nativeOk));
    await evalIn(card, `document.querySelector('.om-msg-actions [aria-label="复制 Markdown"]').click()`);
    await sleep(500);
    const toast = await evalIn(card, `document.getElementById('om-toast')?.textContent || ''`);
    check('严格页: 复制走 execCommand 兜底成功', toast === '已复制 Markdown', toast);
    card.close();
  }
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
