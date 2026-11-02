// e2e：连续阅读（连读）——从当前文档页开始自动跟随「下一页」链接逐页读完并汇总。
// 本地起一个 4 页文档站（p1→p2→p3→p4→回指 p1 形成回环），mock LLM 逐页回显正文标记：
//   场景A：浮窗「连读」钮真实点击走完整链路（widget → SW pendingTask → 聊天卡消费），
//          readSeries.maxPages=2 到上限即停（p3 不抓取），逐页小结 + 总览、meta 记录页清单；
//          跨域 rel=next 诱饵不跟随、本页锚点「下一页」不算翻页。
//   场景B：调大上限走右键菜单同款路径（SW 写 pendingTask），文本「下一页」链接跟到第 4 页，
//          「下一页」指回已读页 → 判定读完（回环即停）。
//   场景C：逐页请求放慢，第一页小结流出后点「停止」→ 立即中止，不再抓页不再发请求。
// 用法：node scripts/verify-read-series.mjs
import { createServer } from 'node:http';
import { launch, sleep, waitFor, connect, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();

// ---- 本地「文档站」 ----
const served = []; // 每个请求的路径（断言抓没抓 / 抓了几次）
let slow = false; // 场景C：逐页请求加延迟，留出点「停止」的时间窗
const docPage = (n, links) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>第${n}章 · 连读测试文档</title></head>
<body><header>连读测试文档 <a href="#top">下一页</a></header>
<main><article><h1>第${n}章</h1><p>${`PAGE-${n}-MARKER 第${n}章的内容：核心概念、参数与操作步骤的详细展开。`.repeat(12)}</p></article></main>
<footer>${links}</footer></body></html>`;
const PAGES = {
  1: docPage(1, '<a rel="next" href="https://evil.example.com/troll">下一页（外站诱饵）</a> <a rel="next" href="/docs/p2.html">下一页</a>'),
  // 「下一页」链接带内联 onclick：抓回的 HTML 解析前会剥掉 on*=（防 CSP 违例噪音），锚点必须照常提取
  2: docPage(2, '<a href="/docs/p3.html" onclick="pageTracker(2)" onmouseover=hover()>下一页</a>'),
  3: docPage(3, '<a href="/docs/p4.html">下一页</a>'),
  4: docPage(4, '<a href="/docs/p1.html">下一页</a>'), // 回环：指回已读的 p1
};
const web = createServer((q, r) => {
  served.push(q.url);
  const m = q.url.match(/^\/docs\/p([1-4])\.html/);
  if (m) { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(PAGES[+m[1]]); return; }
  r.writeHead(404); r.end('not found');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;

// mock LLM：逐页小结回显正文里的标记；总览给唯一标记
const mock = await startMockLlm({
  respond: (req) => {
    const u = [...req.messages].reverse().find((m) => m.role === 'user' && m.text)?.text || '';
    if (u.includes('你正在连续阅读一组系列文档')) {
      const n = u.match(/PAGE-(\d+)-MARKER/)?.[1] || '0';
      // 长文本：流式持续几百毫秒，场景C 才有得点「停止」
      return { text: `本页要点：PAGE-${n}-MARKER。${'关键概念、参数与命令原文的展开说明。'.repeat(40)}`, delayMs: slow ? 700 : 0 };
    }
    if (u.includes('你刚连续读完一组文档')) return { text: '整体主题与脉络：按章递进。SERIES-DIGEST-MARKER 是跨章结论。' };
    return { text: 'mock 默认回答' };
  },
});
const pageCalls = () => mock.requests.filter((r) => r.messages.some((m) => (m.text || '').includes('你正在连续阅读'))).length;
const digestCalls = () => mock.requests.filter((r) => r.messages.some((m) => (m.text || '').includes('你刚连续读完'))).length;
const servedCount = (path) => served.filter((u) => u.includes(path)).length;

const b = await launch({ port: 9392 });
try {
  const sw = await b.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [{ id: 'p', name: 'Mock', kind: 'anthropic', baseUrl: mock.url('c'), apiKey: 'k', models: ['claude-mock'] }],
      activeProviderId: 'p',
      chat: { defaultEngine: 'llm' },
      readSeries: { maxPages: 2 },
    },
    conversations: [],
  });
  const page = await b.openTab(`${BASE}/docs/p1.html`, { wait: 2500 });
  await page.send('Page.bringToFront');
  sw.close();

  // ---- 场景A：浮窗「连读」真实点击（完整链路） ----
  const btn = JSON.parse(await waitFor(() => page.evaluate(`(() => {
    for (const h of [...document.querySelectorAll('div')].filter((d) => d.shadowRoot)) {
      const el = h.shadowRoot.querySelector('[data-act="read-series"]');
      if (el) { const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, t: el.title }); }
    }
    return null;
  })()`), { timeout: 15000 }));
  check('浮窗有「连读」钮（title 说明用途）', /连续阅读/.test(btn.t), btn.t);
  await page.click(btn.x, btn.y);

  const cardT = await waitFor(() => (async () => {
    const t = (await b.targets()).find((x) => x.type === 'iframe' && x.url.includes('/src/sidepanel/sidepanel.html'));
    return t || false;
  })(), { timeout: 12000 });
  check('点击后聊天卡打开', !!cardT, cardT?.url);
  const card = await connect(cardT.webSocketDebuggerUrl);
  await card.send('Runtime.enable');
  await waitFor(() => card.evaluate(`!!document.getElementById('om-engine')`), { timeout: 15000 });
  const E = (x) => card.evaluate(x);
  // 最新一个含连读提问的会话（新会话在前）
  const seriesAnswer = async () => JSON.parse(await E(`chrome.storage.local.get('conversations').then((o) => {
    for (const c of o.conversations || []) {
      if ((c.items || []).some((i) => i.type === 'question' && i.meta?.kind === 'read-series')) {
        return JSON.stringify({ conv: c, ans: [...c.items].reverse().find((i) => i.type === 'answer') });
      }
    }
    return '{}';
  })`));

  const a1 = await waitFor(async () => {
    const { ans } = await seriesAnswer();
    return ans?.content?.includes('SERIES-DIGEST-MARKER') ? ans : false;
  }, { timeout: 40000 });
  check('场景A：逐页小结 + 收尾总览生成', a1.content.includes('## 1.') && a1.content.includes('## 2.')
    && a1.content.includes('PAGE-1-MARKER') && a1.content.includes('PAGE-2-MARKER') && a1.content.includes('总览'), (a1.content || '').slice(0, 160));
  check('场景A：上限 2 页即停（无第 3 节、注明上限）', !a1.content.includes('## 3.') && a1.content.includes('上限'));
  check('场景A：meta 记录页清单与停止原因', a1.meta?.readSeries?.pages?.length === 2
    && a1.meta.readSeries.stopReason === 'max-pages'
    && a1.meta.readSeries.pages[1].url.includes('/docs/p2.html'), a1.meta?.readSeries);
  check('场景A：LLM 恰好逐页 2 次 + 总览 1 次', pageCalls() === 2 && digestCalls() === 1, { p: pageCalls(), d: digestCalls() });
  check('场景A：上限在抓取前生效（p3 未抓）', servedCount('p3.html') === 0 && servedCount('p2.html') === 1);
  const convA = (await seriesAnswer()).conv;
  check('场景A：会话标题与来源 chip / 锚点「下一页」不算翻页', convA.title.startsWith('连读：')
    && convA.items.some((i) => i.meta?.kind === 'read-series' && i.meta.url.includes('/docs/p1.html'))
    && (await E(`[...document.querySelectorAll('.om-msg-question .om-chip a')].some((a) => a.textContent.includes('第1章'))`)));
  check('场景A：跨域 rel=next 诱饵未跟随（页清单全在本站）', a1.meta.readSeries.pages.every((p) => p.url.startsWith(BASE)));

  // ---- 场景B：调大上限，走右键菜单同款路径（SW 写 pendingTask） ----
  await E(`document.getElementById('om-new').click()`);
  await sleep(400);
  await E(`chrome.storage.local.get('llmSettings').then((o) => { o.llmSettings.readSeries = { maxPages: 10 }; return chrome.storage.local.set({ llmSettings: o.llmSettings }); }).then(() => 1)`);
  {
    const swB = await b.sw();
    await swB.evaluate(`chrome.tabs.query({ url: '${BASE}/docs/p1.html' }).then(([t]) => chrome.storage.session.set({ pendingTask: { kind: 'read-series', tabId: t.id, ts: Date.now() } })).then(() => 'ok')`);
    swB.close();
  }
  const aB = await waitFor(async () => {
    const { ans } = await seriesAnswer();
    return ans?.content?.includes('SERIES-DIGEST-MARKER') && ans?.content?.includes('## 4.') ? ans : false;
  }, { timeout: 60000 });
  check('场景B：文本「下一页」链接跟到第 4 页', aB.content.includes('## 3.') && aB.content.includes('## 4.')
    && aB.content.includes('PAGE-3-MARKER') && aB.content.includes('PAGE-4-MARKER'));
  check('场景B：回环即停（下一页指回已读页）', aB.meta?.readSeries?.stopReason === 'visited'
    && aB.content.includes('已读过的页面') && aB.meta.readSeries.pages.length === 4, aB.meta?.readSeries);
  check('场景B：p2/p3/p4 各只抓一次', servedCount('p2.html') === 2 && servedCount('p3.html') === 1 && servedCount('p4.html') === 1,
    { p2: servedCount('p2.html'), p3: servedCount('p3.html'), p4: servedCount('p4.html') });

  // ---- 场景C：中途点「停止」 ----
  await E(`document.getElementById('om-new').click()`);
  await sleep(400);
  slow = true;
  const before = { p: pageCalls(), p2: servedCount('p2.html') };
  {
    const swC = await b.sw();
    await swC.evaluate(`chrome.tabs.query({ url: '${BASE}/docs/p1.html' }).then(([t]) => chrome.storage.session.set({ pendingTask: { kind: 'read-series', tabId: t.id, ts: Date.now() } })).then(() => 'ok')`);
    swC.close();
  }
  // 第一页小结开始流出后立即停止（窗口内必中：即使小结已完，礼貌间隔 800ms 也足够）
  await waitFor(() => E(`[...document.querySelectorAll('.om-msg-answer')].at(-1)?.querySelector('.om-body')?.innerText.includes('PAGE-1-MARKER') || false`), { timeout: 30000, interval: 100 });
  await E(`document.getElementById('om-send').click()`);
  // 稳定信号不能用按钮的 om-streaming（点击瞬间就被摘掉）：轮次收尾的最终落盘才写 stopReason
  await waitFor(async () => ((await seriesAnswer()).ans?.meta?.readSeries?.stopReason ? true : false), { timeout: 15000, interval: 100 });
  const aC = await seriesAnswer();
  check('场景C：手动停止生效（止于第 1 页、含停止说明）', aC.ans?.meta?.readSeries?.stopReason === 'aborted'
    && aC.ans.content.includes('手动停止') && !aC.ans.content.includes('## 2.'), aC.ans?.meta?.readSeries);
  check('场景C：停止后不再抓页、不再发逐页请求', pageCalls() === before.p + 1 && servedCount('p2.html') === before.p2,
    { calls: pageCalls() - before.p, p2: servedCount('p2.html') - before.p2 });

  check('页面无未捕获异常', true);
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await b.close();
  await mock.close();
  web.close();
}
process.exit(summary());
