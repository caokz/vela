// 一次性 e2e：划词悬浮工具条 + 就地面板 + 代码块胶囊 + 网页上下文全链路。
// 本地起假 OpenAI SSE 服务 + 测试页（普通段落 + 代码块），程序化选中文本后经
// 合成 mouseup 跨 world 触发，断言：
// 普通文本 5 钮（高亮/翻译/总结/思维导图/提问）、高亮加包与取消（克隆 Range 路径）、
// 选区收起自动隐藏、代码块单钮「解释代码」、
// 翻译就地面板直调 LLM（不开聊天卡，prompt 带原文，流式渲染）、
// 面板追问转聊天卡（预填原文+结果+问题）、提问预填引用格式、
// 代码块 hover 胶囊「解释/复制」、聊天卡网页上下文 chip + LLM 请求注入 system 正文。
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
const WEB = 39303;

// ---- 本地测试页 + 假 OpenAI SSE ----
const PAGE = `<!doctype html><html><body>
<p id="txt">The quick brown fox jumps over the lazy dog near the river bank.</p>
<p id="mix">Use the <code>EnrichedRide</code> POJO where the key was a <code>Tuple2</code> of fields.</p>
<pre id="code"><code>SELECT count(*) FROM rides WHERE distance &gt; 10;</code></pre>
</body></html>`;
const seen = []; // 每次 mock 请求的完整 messages（角色 + 内容）
const lastPrompt = () => {
  const m = seen.at(-1) || [];
  return m.at(-1)?.content || '';
};
const server = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { seen.push(JSON.parse(body).messages); } catch { /* 忽略 */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '【答】已收到' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'vela-sel-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  // 窗口被遮挡时标签页判 hidden，视口/IntersectionObserver 相关回调不派发
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
const evalInPage = async (sess, expr) => {
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) {
    throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  }
  return r?.result?.value;
};

// 在指定元素文本上程序化选区，然后弹出工具条。
// 划词脚本在 isolated world，CDP evaluate 跑在主 world：经合成 mouseup 事件触发
//（事件监听是跨 world 的），DOM 断言走共享文档 + open shadowRoot。
const selectJs = (id, start, end, scopeSel = '') => `(async () => {
  const root = document.getElementById('${id}');
  const el = ${scopeSel ? `root.querySelector('${scopeSel}')` : 'null'} || root;
  // 高亮会把文本节点切进 span：取子树第一个文本节点做选区锚点
  const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
  const r = document.createRange();
  r.setStart(node, ${start}); r.setEnd(node, ${end});
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await new Promise((r2) => setTimeout(r2, 80));
  const host = document.getElementById('om-sel-host');
  return JSON.stringify({
    host: !!host,
    acts: [...host?.shadowRoot?.querySelectorAll('button') ?? []]
      .map((b) => b.dataset.act + (b.classList.contains('on') ? ':on' : '')),
  });
})()`;

// 等某个 CDP target 出现并连上（面板/聊天卡都是扩展源 iframe，各有独立 target）
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
      } catch { continue; } // target 刚销毁/未就绪：下一轮重试
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
  console.log('扩展 ID:', extId);

  let pageTarget;
  for (let i = 0; i < 20 && !pageTarget; i++) {
    await sleep(500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    pageTarget = targets.find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${WEB}/page`));
  }
  if (!pageTarget) throw new Error('测试页未打开');

  // options 页种子写入：供应商 + 一条 engine:llm 会话（quick-action 需 LLM 引擎可用）
  const optTarget = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/src/options/options.html`, { method: 'PUT' })).json();
  await sleep(800);
  const optSess = await connect(optTarget.webSocketDebuggerUrl);
  await optSess.send('Runtime.enable');
  const seedRes = await evalInPage(optSess, `(async () => {
    const now = Date.now();
    await chrome.storage.local.set({
      llmSettings: {
        providers: [{ id: 'p1', name: 'fake', kind: 'openai', baseUrl: 'http://127.0.0.1:${WEB}/v1', apiKey: 'k', models: ['fake-model'] }],
        activeProviderId: 'p1',
      },
      conversations: [{ id: 'conv:t', title: '划词', createdAt: now, updatedAt: now, engine: 'llm', items: [] }],
    });
    return 'ok';
  })()`);
  if (seedRes !== 'ok') throw new Error('种子未落 storage: ' + seedRes);
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

  if (!await evalInPage(sess, `Boolean(document.getElementById('om-widget-host'))`)) throw new Error('浮窗未注入');

  // 1) 普通文本：5 钮，位置在选区下方
  let st = JSON.parse(await evalInPage(sess, selectJs('txt', 4, 25)));
  check('普通文本弹 5 钮（高亮/翻译/总结/思维导图/提问）', st.host && st.acts.join(',') === 'highlight,translate,summary,mindmap,ask', JSON.stringify(st.acts));
  const rectBelow = await evalInPage(sess, `(() => {
    const host = document.getElementById('om-sel-host');
    const rect = getSelection().getRangeAt(0).getBoundingClientRect();
    return JSON.stringify({ hostTop: host.getBoundingClientRect().top, selBottom: rect.bottom });
  })()`);
  const pos = JSON.parse(rectBelow);
  check('工具条落在选区下方', pos.hostTop >= pos.selBottom - 2, `hostTop=${pos.hostTop} selBottom=${pos.selBottom}`);

  // 2) 选区收起 → 自动隐藏
  await evalInPage(sess, `getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));`);
  await sleep(200);
  check('选区收起自动隐藏', !await evalInPage(sess, `!!document.getElementById('om-sel-host')`));

  // 3) 高亮：点一次包 span，再选已高亮内容按钮亮 on、再点取消（点击时活选区已清，走克隆 Range）
  await evalInPage(sess, selectJs('txt', 4, 25));
  await evalInPage(sess, `(() => {
    // 模拟真实点击清掉活选区：旧版在此路径 getRangeAt 抛异常静默失败
    getSelection().removeAllRanges();
    document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]').click();
  })()`);
  const hl = await evalInPage(sess, `(() => { const s = document.querySelector('.om-hl'); return s ? s.textContent : ''; })()`);
  check('活选区被清后高亮仍生效（克隆 Range）', hl === 'quick brown fox jumps', JSON.stringify(hl));
  st = JSON.parse(await evalInPage(sess, selectJs('txt', 5, 15, '.om-hl')));
  check('已高亮选区高亮钮亮 on', st.acts.join(',').startsWith('highlight:on'), JSON.stringify(st.acts));
  await evalInPage(sess, `document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="highlight"]').click()`);
  check('再点取消高亮', !await evalInPage(sess, `!!document.querySelector('.om-hl')`));

  // 4) 代码块选中：单钮「解释代码」
  st = JSON.parse(await evalInPage(sess, selectJs('code', 0, 20)));
  check('代码块弹单钮解释代码', st.host && st.acts.join(',') === 'explain-code', JSON.stringify(st.acts));

  // 4b) 行内 <code> 段落（紧邻代码块上方）：行内代码是普通正文，仍 5 钮
  st = JSON.parse(await evalInPage(sess, selectJs('mix', 0, 7)));
  check('含行内代码的段落仍弹 5 钮', st.host && st.acts.join(',') === 'highlight,translate,summary,mindmap,ask', JSON.stringify(st.acts));
  // 4c) 选区整个落在行内 <code> 内：无 <pre> 祖先，仍 5 钮
  st = JSON.parse(await evalInPage(sess, selectJs('mix', 0, 10, 'code')));
  check('行内代码内起选仍 5 钮', st.host && st.acts.join(',') === 'highlight,translate,summary,mindmap,ask', JSON.stringify(st.acts));

  // 5) 翻译：就地面板直调 LLM，不开聊天卡
  seen.length = 0;
  await evalInPage(sess, `document.getElementById('om-sel-panel-host')?.remove(); document.getElementById('om-card-host')?.remove();`);
  st = JSON.parse(await evalInPage(sess, selectJs('txt', 4, 25)));
  await evalInPage(sess, `document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="translate"]').click()`);
  let panelHost = false;
  for (let i = 0; i < 15 && !panelHost; i++) {
    await sleep(400);
    panelHost = !!await evalInPage(sess, `!!document.getElementById('om-sel-panel-host')`);
  }
  check('翻译打开就地面板', panelHost);
  check('翻译不再弹聊天卡', !await evalInPage(sess, `!!document.getElementById('om-card-host')`));
  const panelSess = await waitTarget('src/page/sel-panel.html');
  if (!panelSess) throw new Error('面板 target 未出现');
  let panelText = '';
  for (let i = 0; i < 20 && !panelText; i++) {
    await sleep(400);
    panelText = await evalInPage(panelSess, `document.querySelector('.om-body')?.textContent || ''`);
  }
  check('面板流式渲染译文', panelText.includes('【答】已收到'), JSON.stringify(panelText.slice(0, 40)));
  check('翻译 prompt 带选中原文', lastPrompt().includes('quick brown fox jumps'), lastPrompt().slice(0, 80));
  const panelH = await evalInPage(sess, `document.getElementById('om-sel-panel-host')?.style.height || ''`);
  check('面板高度已按自报值落位', /^\d+px$/.test(panelH), panelH);

  // 6) 面板追问：转聊天卡并自动发送（用户已在面板输完问题，不再要点一次发送）
  seen.length = 0;
  await evalInPage(panelSess, `(() => {
    const ta = document.querySelector('.om-follow textarea');
    ta.value = '这个翻译准确吗？';
    document.querySelector('.om-follow button').click();
  })()`);
  let cardOpen = false;
  for (let i = 0; i < 20 && !cardOpen; i++) {
    await sleep(500);
    cardOpen = !!await evalInPage(sess, `!!document.getElementById('om-card-host')`);
  }
  check('追问转开页内聊天卡', cardOpen);
  let sent = '';
  for (let i = 0; i < 20 && !sent; i++) {
    await sleep(500);
    const m = seen.at(-1) || [];
    sent = m.map((x) => x.content || '').join('\n');
  }
  check('追问自动发送到 LLM', sent.includes('quick brown fox jumps') && sent.includes('【答】已收到') && sent.includes('这个翻译准确吗'), sent.slice(0, 80));
  let asked = await (async () => {
    const card = await waitTarget('src/sidepanel/sidepanel.html');
    if (!card) return '';
    const v = await evalInPage(card, `document.getElementById('om-input')?.value || ''`);
    card.close();
    return v;
  })();
  check('追问后输入框不再留预填', asked === '', JSON.stringify(asked.slice(0, 40)));

  // 7) 工具条提问：预填引用格式，不自动发送（旧路径回归）
  await evalInPage(sess, `document.getElementById('om-card-host')?.remove();`);
  st = JSON.parse(await evalInPage(sess, selectJs('txt', 35, 43)));
  await evalInPage(sess, `document.getElementById('om-sel-host').shadowRoot.querySelector('[data-act="ask"]').click()`);
  cardOpen = false;
  for (let i = 0; i < 20 && !cardOpen; i++) {
    await sleep(500);
    cardOpen = !!await evalInPage(sess, `!!document.getElementById('om-card-host')`);
  }
  check('提问动作回开页内聊天卡', cardOpen);
  asked = '';
  for (let i = 0; i < 20 && !asked; i++) {
    await sleep(500);
    const card = await waitTarget('src/sidepanel/sidepanel.html');
    if (!card) continue;
    asked = await evalInPage(card, `document.getElementById('om-input')?.value || ''`);
    card.close();
  }
  check('提问预填引用格式（> 原文）', asked.startsWith('> ') && asked.includes('lazy dog'), JSON.stringify(asked.slice(0, 60)));

  // 8) 网页上下文：卡片挂 chip；发送后 LLM 请求首条是 system 且带页面正文
  const cardSess = await waitTarget('src/sidepanel/sidepanel.html');
  if (!cardSess) throw new Error('聊天卡 target 未出现');
  let chip = '';
  for (let i = 0; i < 15 && !chip; i++) {
    await sleep(400);
    chip = await evalInPage(cardSess, `document.querySelector('.om-attach-row .om-attach-chip .om-chip-name')?.textContent || ''`);
  }
  check('聊天卡显示网页上下文 chip', chip.includes('网页上下文'), chip);
  seen.length = 0;
  await evalInPage(cardSess, `(() => {
    const input = document.getElementById('om-input');
    input.value = '页面里的狐狸在干什么？';
    document.getElementById('om-send').click();
  })()`);
  let ctxReq = null;
  for (let i = 0; i < 20 && !ctxReq; i++) {
    await sleep(500);
    ctxReq = seen.find((msgs) => msgs[0]?.role === 'system' && msgs[0].content.includes('quick brown fox')) || null;
  }
  check('LLM 请求注入网页正文 system 消息', !!ctxReq, ctxReq ? 'system ' + ctxReq[0].content.length + ' 字' : '未捕获');
  check('system 后跟用户问题', ctxReq?.at(-1)?.content?.includes('页面里的狐狸在干什么'), ctxReq?.at(-1)?.content || '');

  // 9) 代码块 hover 胶囊：无需选中，「解释」开面板
  await evalInPage(sess, `document.getElementById('om-sel-panel-host')?.remove();`);
  seen.length = 0;
  await evalInPage(sess, `document.getElementById('code').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await sleep(200);
  let cbtn = await evalInPage(sess, `!!document.getElementById('om-sel-cbtn-host')`);
  check('悬停代码块出现胶囊按钮', cbtn);
  await evalInPage(sess, `document.getElementById('om-sel-cbtn-host').shadowRoot.querySelector('.explain').click()`);
  panelHost = false;
  for (let i = 0; i < 15 && !panelHost; i++) {
    await sleep(400);
    panelHost = !!await evalInPage(sess, `!!document.getElementById('om-sel-panel-host')`);
  }
  check('胶囊「解释」打开解释面板', panelHost);
  check('解释 prompt 带代码原文', lastPrompt().includes('SELECT count(*)'), lastPrompt().slice(0, 80));

  panelSess.close?.();
  cardSess.close();
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
