// 真供应商划词翻译 e2e：读取用户真实 llmSettings（含 key，来自
// %TEMP%/vela-llm-settings.json，由 tmp-extract-llm.mjs 产出），
// 起本地测试页 → 选中英文 → 点翻译 → 就地面板流式渲染真译文。
// 只发一次短文本请求；key 不落日志。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9337;
const WEB = 39307;

const settings = JSON.parse(readFileSync(join(process.env.TEMP, 'vela-llm-settings.json'), 'utf8'));
const prov = settings.providers.find((p) => p.id === settings.activeProviderId) || settings.providers[0];
console.log(`供应商: ${prov.name} (${prov.kind}) @ ${prov.baseUrl} 模型 ${prov.models[0]}，目标语言 ${(settings.translation ?? {}).targetLang ?? 'zh-CN'}`);

const PAGE = `<!doctype html><html><body>
<p id="txt">The quick brown fox jumps over the lazy dog near the river bank. Machine translation should render this sentence into natural Chinese within a few seconds.</p>
</body></html>`;
const server = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'vela-real-'));
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
const evalInPage = async (sess, expr) => {
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r?.result?.value;
};
async function waitTarget(urlPart) {
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const t = targets.find((x) => ['page', 'iframe'].includes(x.type) && x.url.includes(urlPart) && x.webSocketDebuggerUrl);
    if (t) {
      try { const s = await connect(t.webSocketDebuggerUrl); await s.send('Runtime.enable'); return s; } catch { continue; }
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

  let pageTarget;
  for (let i = 0; i < 20 && !pageTarget; i++) {
    await sleep(500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    pageTarget = targets.find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${WEB}/page`));
  }
  if (!pageTarget) throw new Error('测试页未打开');

  // 种子：用户真实 llmSettings（原样写入，含 key）
  const optTarget = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/src/options/options.html`, { method: 'PUT' })).json();
  await sleep(800);
  const optSess = await connect(optTarget.webSocketDebuggerUrl);
  await optSess.send('Runtime.enable');
  const seed = await evalInPage(optSess, `(async () => {
    await chrome.storage.local.set({ llmSettings: ${JSON.stringify(settings).replace(/</g, '\\u003c')} });
    return 'ok';
  })()`);
  if (seed !== 'ok') throw new Error('种子未落 storage');
  await fetch(`http://127.0.0.1:${PORT}/json/activate/${pageTarget.id}`);
  optSess.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${optTarget.id}`);
  await sleep(300);

  const sess = await connect(pageTarget.webSocketDebuggerUrl);
  await sess.send('Runtime.enable');
  await sess.send('Page.enable');
  await sess.send('Page.reload');
  await sleep(2500);
  await sess.send('Page.bringToFront');
  await sleep(300);

  // 选中前半句 → 弹工具条 → 点翻译
  await evalInPage(sess, `(() => {
    const node = document.createTreeWalker(document.getElementById('txt'), NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange();
    r.setStart(node, 4); r.setEnd(node, 44);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  await sleep(200);
  const st = JSON.parse(await evalInPage(sess, `JSON.stringify({
    host: !!document.getElementById('om-sel-host'),
    acts: [...document.getElementById('om-sel-host')?.shadowRoot?.querySelectorAll('button') ?? []].map((b) => b.dataset.act),
  })`));
  check('工具条弹出', st.host && st.acts.includes('translate'), JSON.stringify(st.acts));
  await evalInPage(sess, `document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="translate"]').click()`);

  let panel = false;
  for (let i = 0; i < 15 && !panel; i++) { await sleep(400); panel = !!await evalInPage(sess, `!!document.getElementById('om-sel-panel-host')`); }
  check('就地面板打开', panel);
  check('未弹聊天卡', !await evalInPage(sess, `!!document.getElementById('om-card-host')`));

  const panelSess = await waitTarget('src/page/sel-panel.html');
  if (!panelSess) throw new Error('面板 target 未出现');

  // 轮询正文直到稳定（两次采样一致且非空）或超时 90s
  let text = '', stable = false, err = '';
  for (let i = 0; i < 90 && !stable; i++) {
    await sleep(1000);
    const cur = await evalInPage(panelSess, `document.querySelector('.om-body')?.textContent || ''`);
    err = await evalInPage(panelSess, `document.querySelector('.om-error')?.textContent || ''`);
    if (err) break;
    if (cur && cur === text) stable = true;
    text = cur;
  }
  if (err) {
    check('真译文渲染', false, err.slice(0, 200));
  } else {
    const hasCjk = /[一-鿿]/.test(text);
    check('真译文流式渲染完成', stable && text.length > 10 && hasCjk, `${text.length} 字`);
    const title = await evalInPage(panelSess, `document.querySelector('header .om-title')?.textContent || ''`);
    check('面板标题为翻译', (title || '').includes('翻译'), JSON.stringify(title));
    console.log('译文:', text.replace(/\s+/g, ' ').slice(0, 200));
  }
  const h = await evalInPage(sess, `document.getElementById('om-sel-panel-host')?.style.height || ''`);
  check('面板高度自报落位', /^\d+px$/.test(h), h);

  panelSess.close();
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
