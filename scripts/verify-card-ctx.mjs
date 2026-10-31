// e2e：页内聊天卡的「网页上下文」必须跟着宿主页走（全程 mock LLM，不产生真实调用）。
// 复现用户报障：打开新网页后聊天卡仍绑着上一个网页作为上下文，只有在顶栏重选引擎才换到新网页。
// 覆盖：
//   1. 同一页重开卡：续用原会话，不乱新建
//   2. 同一标签页跳到新网页后重开卡：为新网页新建对话，旧对话（含消息与旧页上下文）原样保留
//   3. SPA 换页（pushState，卡片不重载）：空会话原地换上下文；已有消息的会话新建对话
//   4. 只改 #hash 不算换页
//   5. 新页正文过短：清掉上下文，且「新对话」不会带上上一个网页的正文
//   6. 从网页触发的动作（pendingTask）+ 最近会话绑着旧网页：任务用当前网页的上下文，不污染旧会话
// 用法：node scripts/verify-card-ctx.mjs
import { createServer } from 'node:http';
import { launch, sleep, waitFor, connect, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();
const FILL = '内容填充'.repeat(30);
const page = (title, marker) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><article><h1>${title}</h1><p>${marker} ${FILL}</p></article></body></html>`;
const PAGES = { '/a': ['Page A', 'PAGE-A-MARKER'], '/b': ['Page B', 'PAGE-B-MARKER'], '/e': ['Page E', 'PAGE-E-MARKER'] };
const web = createServer((q, r) => {
  const p = PAGES[q.url.split('?')[0]] || ['Page X', 'PAGE-X-MARKER'];
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(page(...p));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;
const mock = await startMockLlm({ respond: () => ({ text: 'mock 回答' }) });

const browser = await launch({ port: 9376 });
try {
  const sw0 = await browser.sw();
  await seedStorage(sw0, {
    llmSettings: {
      providers: [{ id: 'p', name: 'Mock', kind: 'openai', baseUrl: mock.url('a') + '/v1', apiKey: 'k', models: ['m'] }],
      activeProviderId: 'p',
      agentBridge: { url: 'ws://127.0.0.1:39299' },
      chat: { defaultEngine: 'llm' },
    },
    conversations: [],
  });
  sw0.close();

  // ---- 工具 ----
  const store = async () => JSON.parse(await (await browser.sw().then(async (s) => { const r = await s.evaluate(`chrome.storage.local.get('conversations').then((o) => JSON.stringify(o.conversations || []))`); s.close(); return r; })));
  const swDo = async (expr) => { const s = await browser.sw(); const r = await s.evaluate(expr); s.close(); return r; };
  const tabAction = (urlPrefix, type) => swDo(`chrome.tabs.query({}).then((ts) => { const t = ts.find((x) => (x.url || '').startsWith(${JSON.stringify(urlPrefix)})); return chrome.tabs.sendMessage(t.id, { type: ${JSON.stringify(type)} }); }).then(() => 'ok')`);
  const seenFrames = new Set();
  const openCard = async (urlPrefix) => {
    await tabAction(urlPrefix, 'om:open-card');
    const t = await waitFor(async () => (await browser.targets()).find((x) => x.type === 'iframe' && x.url.includes('/src/sidepanel/sidepanel.html') && !seenFrames.has(x.id)), { timeout: 12000 });
    seenFrames.add(t.id);
    const s = await connect(t.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    await waitFor(() => s.evaluate(`!!document.getElementById('om-engine')`));
    return s;
  };
  const chip = (card) => card.evaluate(`document.querySelector('.om-chip-name')?.textContent || ''`);
  const waitChip = async (card, re) => { await waitFor(async () => re.test(await chip(card)), { timeout: 6000, interval: 200 }); return chip(card); };
  const activeConv = (card) => card.evaluate(`document.querySelector('.om-conv-item.om-active')?.dataset.convId || ''`);
  const sendMsg = async (card, text) => {
    const n = (await store()).flatMap((c) => c.items).length;
    await card.evaluate(`(() => { const i = document.getElementById('om-input'); i.value = ${JSON.stringify(text)}; document.getElementById('om-send').click(); return 1; })()`);
    await waitFor(async () => (await store()).flatMap((c) => c.items).filter((i) => i.type === 'answer' && i.content).length >= (n / 2 | 0) + 1 && card.evaluate(`!document.getElementById('om-send').classList.contains('om-streaming')`), { timeout: 10000 });
  };
  const spa = (tab, path, title, marker, long = true) => tab.evaluate(`(() => { history.pushState({}, '', ${JSON.stringify(path)}); document.title = ${JSON.stringify(title)}; document.querySelector('article').innerHTML = '<h1>' + ${JSON.stringify(title)} + '</h1><p>' + ${JSON.stringify(marker)} + ' ' + ${JSON.stringify(long ? FILL : '')} + '</p>'; return 1; })()`);

  // ---- 1. 页 A 打开卡：空会话挂上 A 的上下文；说一句话后同一页重开卡不新建 ----
  const tab = await browser.openTab(`${BASE}/a`, { wait: 2200 });
  await tab.send('Page.bringToFront');
  let card = await openCard(`${BASE}/a`);
  check('页 A：聊天卡挂上当前网页上下文', /Page A/.test(await waitChip(card, /Page A/)), await chip(card));
  await sendMsg(card, '你好 A');
  let convs = await store();
  const convA = convs[0];
  check('会话绑定页 A 且已有消息', convA.pageCtx?.url.endsWith('/a') && convA.items.length === 2, convA.pageCtx?.url);
  await tabAction(`${BASE}/a`, 'om:close-card');
  card.close();
  await sleep(300);
  card = await openCard(`${BASE}/a`);
  await sleep(1500);
  convs = await store();
  check('同一页重开卡：续用原会话，不新建', convs.length === 1 && (await activeConv(card)) === convA.id, `${convs.length} 个会话`);

  // ---- 2. 同一标签页跳到页 B 后重开卡（sessionStorage 记着页 A 的会话）→ 新建对话 ----
  card.close();
  await tab.send('Page.navigate', { url: `${BASE}/b` });
  await sleep(2500);
  card = await openCard(`${BASE}/b`);
  check('页 B：上下文换成当前网页（不是页 A）', /Page B/.test(await waitChip(card, /Page B/)), await chip(card));
  convs = await store();
  const convB = convs.find((c) => c.id !== convA.id);
  check('为页 B 新建了对话并成为当前会话', convs.length === 2 && !!convB && (await activeConv(card)) === convB.id && convB.items.length === 0, `${convs.length} 个会话`);
  const keptA = convs.find((c) => c.id === convA.id);
  check('页 A 的旧对话原样保留（消息 + 旧页上下文）', keptA.items.length === 2 && keptA.pageCtx.url.endsWith('/a') && /PAGE-A-MARKER/.test(keptA.pageCtx.text));

  // ---- 3. SPA 换页：空会话原地换上下文 ----
  await spa(tab, '/b2', 'Page B2', 'PAGE-B2-MARKER');
  check('SPA 跳转后（卡片没重载）空会话原地换成新页上下文', /Page B2/.test(await waitChip(card, /Page B2/)), await chip(card));
  convs = await store();
  check('原地更新，没有多建对话', convs.length === 2 && (await activeConv(card)) === convB.id);

  // ---- 4. 只改 #hash 不算换页 ----
  await sendMsg(card, '你好 B2');
  await tab.evaluate(`location.hash = '#section-2'`);
  await sleep(2600);
  convs = await store();
  check('只改 #hash：不新建对话、上下文不变', convs.length === 2 && /Page B2/.test(await chip(card)), `${convs.length} 个会话`);

  // ---- 5. SPA 换页：已有消息的会话 → 新建对话，旧对话保留 ----
  await spa(tab, '/b3', 'Page B3', 'PAGE-B3-MARKER');
  check('SPA 跳转后已有消息的会话：切到新对话并挂上新页上下文', /Page B3/.test(await waitChip(card, /Page B3/)), await chip(card));
  convs = await store();
  const convB3 = convs.find((c) => c.pageCtx?.url.endsWith('/b3'));
  check('新建对话绑页 B3，页 B2 的对话保留消息与上下文', convs.length === 3 && (await activeConv(card)) === convB3?.id && convs.find((c) => c.id === convB.id).items.length === 2 && convs.find((c) => c.id === convB.id).pageCtx.url.endsWith('/b2'), `${convs.length} 个会话`);

  // ---- 6. 新页正文过短：清上下文，「新对话」不带上一个网页的正文 ----
  await spa(tab, '/short', 'Short', '短页', false);
  await waitFor(async () => (await chip(card)) === '', { timeout: 6000, interval: 200 });
  check('新页正文过短：空会话的网页上下文被清掉', (await chip(card)) === '', await chip(card));
  await card.evaluate(`document.getElementById('om-new').click()`);
  await sleep(500);
  convs = await store();
  const fresh = convs.find((c) => !c.items.length && !c.pageCtx && c.id !== convB3.id);
  check('此时点「新对话」不会带上页 B3 的正文', !!fresh && (await chip(card)) === '', convs.map((c) => c.pageCtx?.url || null));
  card.close();

  // ---- 7. 从网页触发的动作 + 最近会话绑着旧网页：任务用当前页上下文，不污染旧会话 ----
  const future = Date.now() + 3_600_000; // 让它成为「最近活跃」会话
  await swDo(`chrome.storage.local.get('conversations').then((o) => chrome.storage.local.set({ conversations: [{
    id: 'conv:stale', title: '旧网页对话', engine: 'llm', llmMode: 'chat', createdAt: ${future}, updatedAt: ${future},
    pageCtx: { title: 'Old Page', url: '${BASE}/old', text: 'OLD-PAGE-MARKER ${FILL}' },
    items: [{ id: 'msg:q0', type: 'question', content: '旧问题', createdAt: ${future}, parentItemId: '' }, { id: 'msg:a0', type: 'answer', content: '旧回答', createdAt: ${future}, parentItemId: 'msg:q0', model: 'm', error: '', stopped: false }],
  }, ...o.conversations] })).then(() => 1)`);
  const tabE = await browser.openTab(`${BASE}/e`, { wait: 2200 });
  await tabE.send('Page.bringToFront');
  await swDo(`chrome.storage.session.set({ pendingTask: { kind: 'quick-action', prompt: '解释一下这页', title: '解释' } }).then(() => 1)`);
  const n0 = mock.requests.length;
  card = await openCard(`${BASE}/e`);
  const got = await waitFor(() => mock.requests.length > n0 && mock.requests.at(-1), { timeout: 12000 });
  const sys = (got?.messages || []).filter((m) => m.role === 'system').map((m) => m.text).join('\n');
  check('任务的网页上下文是当前页 E', /PAGE-E-MARKER/.test(sys), sys.slice(0, 120));
  check('任务没有用上旧网页的上下文', !/OLD-PAGE-MARKER/.test(sys));
  convs = await store();
  const stale = convs.find((c) => c.id === 'conv:stale');
  const asked = convs.find((c) => c.items.some((i) => i.content === '解释一下这页'));
  check('任务落在为当前页新建的对话里，旧会话没有被追加', stale.items.length === 2 && asked && asked.id !== 'conv:stale' && asked.pageCtx?.url.endsWith('/e'), convs.map((c) => [c.id.slice(0, 9), c.items.length]));
  card.close();
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await browser.close();
  await mock.close();
  web.close();
}
process.exit(summary());
