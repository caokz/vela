// 一次性 e2e：沉浸翻译全链路。本地起假 OpenAI SSE 服务 + 测试页（纯文本段/带链接段/带行内代码段），
// 浮窗「翻译此页」点击 → runner 跑管线 → 断言沉浸模式三段全部整块替换（旧行为：带 <a>/<code>
// 的块降级成对照插入）；再点一次翻译按钮 → 断言原文与行内标记（<a>/<code>）按快照完整还原。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9333;
const WEB = 39302;

// ---- 本地测试页 + 假 OpenAI SSE ----
const PAGE = `<!doctype html><html><body>
<p id="plain">The quick brown fox jumps over the lazy dog near the river bank.</p>
<p id="linked">See the <a href="https://example.com/docs">official documentation</a> for advanced usage.</p>
<p id="coded">Run <code>npm install vela</code> first, then start the bridge process.</p>
</body></html>`;
const server = createServer((req, res) => {
  console.log('[web]', req.method, req.url);
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let prompt = '';
      try { prompt = JSON.parse(body).messages.at(-1).content; } catch { /* 忽略 */ }
      const items = [...prompt.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
      const arr = JSON.stringify(items.map((t) => `【中】${t.replace(/\s+/g, ' ')}`));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: arr } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'vela-im-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  // 窗口被其他窗口完全遮挡时 Chrome 会把标签页判为 hidden，IntersectionObserver 回调不派发；
  // 关掉遮挡降级，管线在后台窗口也照常跑
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
  return { send, ws, close: () => ws.close() };
}
const evalInPage = async (sess, expr) => (await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = 1;
};

try {
  // 等 SW 就绪（SW 上下文会休眠，storage 读写走 options 页上下文更稳）
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
  console.log('扩展 ID:', extId);

  // 测试页已随 Chrome 启动加载；等浮窗注入后刷新（内容脚本注册发生在 SW 启动后，首页可能错过）
  let pageTarget;
  for (let i = 0; i < 20 && !pageTarget; i++) {
    await sleep(500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    pageTarget = targets.find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${WEB}/page`));
  }
  if (!pageTarget) throw new Error('测试页未打开');

  // options 页种子写入（供应商 + 沉浸模式），写完把焦点还给测试页（activeTab 依赖）
  const optTarget = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/src/options/options.html`, { method: 'PUT' })).json();
  await sleep(800);
  const optSess = await connect(optTarget.webSocketDebuggerUrl);
  await optSess.send('Runtime.enable');
  const seedRes = await evalInPage(optSess, `(async () => {
    await chrome.storage.local.set({ llmSettings: {
      providers: [{ id: 'p1', name: 'fake', kind: 'openai', baseUrl: 'http://127.0.0.1:${WEB}/v1', apiKey: 'k', models: ['fake-model'] }],
      activeProviderId: 'p1',
      translation: { targetLang: 'zh-CN', mode: 'immersive', maxBlocks: 100, maxChars: 100000, batchBlocks: 6 },
    } });
    const back = await chrome.storage.local.get('llmSettings');
    return JSON.stringify({ n: back.llmSettings?.providers?.length, mode: back.llmSettings?.translation?.mode });
  })()`);
  console.log('种子写读回验:', seedRes);
  if (!String(seedRes).includes('"n":1')) throw new Error('种子未落 storage: ' + seedRes);
  // 直接关掉 options 标签页：只 activate 测试页时，options 页加载完成后会把焦点抢回去，
  // 测试页停在 hidden，IntersectionObserver 回调不派发，整条沉浸管线卡死
  optSess.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${optTarget.id}`);
  await sleep(300);

  const sess = await connect(pageTarget.webSocketDebuggerUrl);
  await sess.send('Runtime.enable');
  sess.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      console.log('[page console]', m.params.type, m.params.args?.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  await sess.send('Page.enable');
  await sess.send('Page.reload');
  await sleep(2500);
  // 标签页不可见时 Chrome 暂停渲染步骤，IntersectionObserver 回调不派发——必须把页面置前
  await sess.send('Page.bringToFront');
  await sleep(300);
  console.log('可见性:', await evalInPage(sess, `document.visibilityState + ' focus=' + document.hasFocus()`));

  const hasWidget = await evalInPage(sess, `Boolean(document.getElementById('om-widget-host')?.shadowRoot?.querySelector('[data-act="translate-page"]'))`);
  if (!hasWidget) throw new Error('浮窗未注入');

  // 点「翻译此页」，等译文落上去
  await evalInPage(sess, `document.getElementById('om-widget-host').shadowRoot.querySelector('[data-act="translate-page"]').click()`);
  // 挂上 runner iframe 的 console 捕获再继续
  let rs = null;
  for (let i = 0; i < 10 && !rs; i++) {
    await sleep(300);
    const rt = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.url.includes('tx-runner'));
    if (rt) {
      rs = await connect(rt.webSocketDebuggerUrl);
      await rs.send('Runtime.enable');
      rs.ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.consoleAPICalled') {
          console.log('[runner console]', m.params.type, m.params.args?.map((a) => a.value ?? a.description ?? '').join(' '));
        }
        if (m.method === 'Runtime.exceptionThrown') {
          console.log('[runner exception]', JSON.stringify(m.params.exceptionDetails).slice(0, 400));
        }
      });
    }
  }
  const dbg = await evalInPage(sess, `JSON.stringify({
    runner: Boolean(document.getElementById('om-tx-runner-host')),
    hint: document.getElementById('om-widget-host')?.shadowRoot?.querySelector('.om-w-hint')?.textContent,
    marked: document.querySelectorAll('[data-om-tx]').length,
    wait: document.querySelectorAll('.om-tx-wait').length,
    failed: document.querySelectorAll('.om-tx-failed').length,
  })`);
  console.log('点击后状态:', dbg);
  let st = {};
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    st = JSON.parse(await evalInPage(sess, `JSON.stringify({
      plain: document.getElementById('plain')?.textContent,
      linked: document.getElementById('linked')?.textContent,
      coded: document.getElementById('coded')?.textContent,
      dst: document.querySelectorAll('.om-tx-dst').length,
    })`));
    if (st.plain?.includes('【中】') && st.linked?.includes('【中】') && st.coded?.includes('【中】')) break;
  }
  // mock 译文是「【中】+原文」，判据用出现次数：沉浸替换后原文只出现一次（译文回显），对照模式会两次
  const foxHits = st.plain?.match(/quick brown fox/g)?.length ?? 0;
  check('纯文本段整块替换', st.plain?.startsWith('【中】') === true && foxHits === 1, JSON.stringify(st.plain));
  check('带链接段整块替换（旧行为降级对照）', st.linked?.includes('【中】') === true, JSON.stringify(st.linked));
  check('带行内代码段整块替换（旧行为降级对照）', st.coded?.includes('【中】') === true, JSON.stringify(st.coded));
  check('沉浸模式无对照插入节点', st.dst === 0, `dst=${st.dst}`);

  // 再点一次 = 还原原文；行内 <a>/<code> 按快照恢复
  await evalInPage(sess, `document.getElementById('om-widget-host').shadowRoot.querySelector('[data-act="translate-page"]').click()`);
  await sleep(1500);
  st = JSON.parse(await evalInPage(sess, `JSON.stringify({
    plain: document.getElementById('plain')?.textContent,
    linkedHtml: document.getElementById('linked')?.innerHTML,
    codedHtml: document.getElementById('coded')?.innerHTML,
  })`));
  check('还原后纯文本段回到原文', st.plain?.includes('quick brown fox') === true, JSON.stringify(st.plain));
  check('还原后链接段恢复 <a> 标记', (st.linkedHtml || '').includes('<a href="https://example.com/docs"') === true, JSON.stringify(st.linkedHtml));
  check('还原后代码段恢复 <code> 标记', (st.codedHtml || '').includes('<code>') === true, JSON.stringify(st.codedHtml));

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
