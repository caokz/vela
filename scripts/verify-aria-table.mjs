// e2e：非典型结构整页翻译（x.ai 型）。真实网站的「表格」很多不是 <table>（x.ai/pricing
// 全站 441 个 role="cell"、0 个 <td>），FAQ 问题头是 h3>button>span 手风琴模式，页脚是
// div>a 裸链接列——这三类此前都一块都收不进去，用户视角就是「整片区域不翻译」。
// fixture 按抓取到的 x.ai/pricing 真实结构造：ARIA div 表格、只含 SVG 图标的 cell、
// 包 <h3> 的分组行、含 <a> CTA 的 columnheader、手风琴 FAQ、<footer> 链接列、真 <table>。
// 同时回归护栏：带内联链接的段落必须整块收录（a/span 不能进主选择器）、
// 按钮控件文本不译、页眉导航链接也收录、grid/表格行布局不被译文挤乱。
// 用法：node scripts/verify-aria-table.mjs
import { createServer } from 'node:http';
import { launch, sleep, waitFor, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();

const ICON = '<svg width="12" height="12" viewBox="0 0 24 24" role="img" aria-label="Included"><path d="M4 13L9 18L20 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  .vrow { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 4px; align-items: center; padding: 6px 0; }
  .vcell { display: flex; justify-content: center; }
  .flinks { display: flex; flex-direction: column; }
</style></head><body>
<header id="hdr"><a href="#" onclick="return false">Sign in</a></header>
<p id="plain">The quick brown fox jumps over the lazy dog near the river bank.</p>
<p id="para">See the <a href="#" onclick="return false">usage documentation</a> for details and examples.</p>
<div role="table" aria-label="Compare plans">
  <div role="rowgroup">
    <div role="row" id="head-row" class="vrow">
      <div role="columnheader" id="ch-free">
        <div style="display:flex;flex-direction:column;align-items:center">
          <span>Free</span><span>$0/month</span><a href="#" onclick="return false">Get started</a>
        </div>
      </div>
      <div role="columnheader" id="ch-teams"><span>Teams</span></div>
    </div>
  </div>
  <div role="rowgroup">
    <div role="row" id="g-row" class="vrow">
      <div role="rowheader" aria-colspan="3"><h3 id="gh">Additional benefits</h3></div>
    </div>
    <div role="row" id="r1" class="vrow">
      <div role="rowheader" id="rh1">Priority model access at peak times</div>
      <div role="cell" id="c1a" class="vcell">${ICON}</div>
      <div role="cell" id="c1b" class="vcell">By seat tier</div>
    </div>
    <div role="row" id="r2" class="vrow">
      <div role="rowheader" id="rh2">SCIM seat management</div>
      <div role="cell" id="c2a" class="vcell">${ICON}</div>
      <div role="cell" id="c2b" class="vcell">Custom</div>
    </div>
  </div>
</div>
<table id="real-table"><tr><th id="th1">Plan features</th><td id="td1">Everything in Free, plus priority access.</td></tr></table>
<div id="faq">
  <h3 id="faq-h3"><button id="faq-btn" type="button" aria-expanded="false"><span id="faq-q">How do usage limits work?</span><svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button></h3>
  <div><p id="faq-a">Usage limits reset every month and vary by plan tier.</p></div>
</div>
<footer id="foot">
  <div class="fcol"><span>Products</span><div class="flinks"><a href="#" onclick="return false">Chat</a><a href="#" onclick="return false">Build</a></div></div>
  <div class="fcol"><span>Solutions</span><div class="flinks"><a href="#" onclick="return false">Pricing</a></div></div>
</footer>
<div><button id="cta-btn" type="button"><span>Subscribe</span></button></div>
</body></html>`;

// 期望收录 19 块：p×3（plain/para/faq-a）+ h3×2（gh/faq-h3）+ rowheader×2 + 文本 cell×2
// + columnheader×2 + th + td + 页脚 span×2 + 页脚 a×3 + 页眉 a×1；图标 cell、按钮内 span 不收
const EXPECT_MARKED = 19;

const web = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const WEB = `http://127.0.0.1:${web.address().port}`;

// 翻译批 prompt 是编号行，按行拆出原文，回「【中】+原文」的 JSON 数组
const mock = await startMockLlm({
  respond: (req) => {
    const text = req.messages.at(-1)?.text || '';
    const items = [...text.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
    return { text: JSON.stringify(items.map((t) => `【中】${t.replace(/\s+/g, ' ')}`)) };
  },
});

const browser = await launch({ port: 9345, url: 'about:blank' });
const exceptions = [];
try {
  const sw = await browser.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [{ id: 'p1', name: 'fake', kind: 'openai', baseUrl: mock.url('tx') + '/v1', apiKey: 'k', models: ['fake-model'] }],
      activeProviderId: 'p1',
      translation: { targetLang: 'zh-CN', mode: 'bilingual', maxBlocks: 100, maxChars: 100000, batchBlocks: 6 },
    },
  });
  sw.close();

  const page = await browser.openTab(`${WEB}/page`, { wait: 1800 });
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  });
  await page.send('Page.bringToFront'); // 标签页不可见时 IntersectionObserver 回调不派发
  const E = (expr) => page.evaluate(expr);

  // 浮窗就绪（打开前注册已完成，理论必中；兜底刷新一次）
  let widget = await waitFor(() => E(`Boolean(document.getElementById('om-widget-host')?.shadowRoot?.querySelector('[data-act="translate-page"]'))`), { timeout: 6000 });
  if (!widget) {
    await page.send('Page.reload');
    await sleep(2000);
    await page.send('Page.bringToFront');
    widget = await waitFor(() => E(`Boolean(document.getElementById('om-widget-host')?.shadowRoot?.querySelector('[data-act="translate-page"]'))`), { timeout: 8000 });
  }
  if (!widget) throw new Error('浮窗未注入');

  await E(`document.getElementById('om-widget-host').shadowRoot.querySelector('[data-act="translate-page"]').click()`);

  const settled = await waitFor(async () => {
    const s = JSON.parse(await E(`JSON.stringify({
      dst: document.querySelectorAll('.om-tx-dst').length,
      wait: document.querySelectorAll('.om-tx-wait').length,
      failed: document.querySelectorAll('.om-tx-failed').length,
      marked: document.querySelectorAll('[data-om-tx]').length,
    })`));
    return s.dst >= EXPECT_MARKED && s.wait === 0 ? s : null;
  }, { timeout: 20000, interval: 400 });
  const st = settled || JSON.parse(await E(`JSON.stringify({
    dst: document.querySelectorAll('.om-tx-dst').length,
    wait: document.querySelectorAll('.om-tx-wait').length,
    failed: document.querySelectorAll('.om-tx-failed').length,
    marked: document.querySelectorAll('[data-om-tx]').length,
  })`));
  console.log('落定状态:', JSON.stringify(st));

  const snap = JSON.parse(await E(`JSON.stringify({
    plainDst: document.getElementById('plain')?.nextElementSibling?.textContent,
    ghDstText: document.getElementById('gh')?.parentElement?.querySelector(':scope > .om-tx-dst')?.textContent,
    rh1: document.getElementById('rh1')?.textContent,
    rh2: document.getElementById('rh2')?.textContent,
    c1b: document.getElementById('c1b')?.textContent,
    c2b: document.getElementById('c2b')?.textContent,
    chFree: document.getElementById('ch-free')?.textContent,
    chTeams: document.getElementById('ch-teams')?.textContent,
    headRowChildren: document.getElementById('head-row')?.childElementCount,
    r1Children: document.getElementById('r1')?.childElementCount,
    gRowChildren: document.getElementById('g-row')?.childElementCount,
    rh1HasDstInside: document.getElementById('rh1')?.querySelector('.om-tx-dst') != null,
    c1bHasDstInside: document.getElementById('c1b')?.querySelector('.om-tx-dst') != null,
    chFreeHasDstInside: document.getElementById('ch-free')?.querySelector('.om-tx-dst') != null,
    iconMarked: document.getElementById('c1a')?.hasAttribute('data-om-tx') || document.getElementById('c2a')?.hasAttribute('data-om-tx'),
    // 真表格：th/td 翻译且译文在格子内部，行不被挤乱
    th1: document.getElementById('th1')?.textContent,
    td1: document.getElementById('td1')?.textContent,
    thRowChildren: document.getElementById('th1')?.parentElement?.childElementCount,
    th1HasDstInside: document.getElementById('th1')?.querySelector('.om-tx-dst') != null,
    td1HasDstInside: document.getElementById('td1')?.querySelector('.om-tx-dst') != null,
    // 手风琴 FAQ：h3（含 button+svg）整块翻译，按钮原样保留
    faqDst: document.getElementById('faq-h3')?.nextElementSibling?.textContent,
    faqBtnAlive: document.getElementById('faq-btn') != null && document.getElementById('faq-btn').querySelector('[data-om-tx]') == null,
    faqADst: document.getElementById('faq-a')?.nextElementSibling?.textContent,
    // 带内联链接的段落整块收录，链接不单拆
    paraMarked: document.getElementById('para')?.hasAttribute('data-om-tx'),
    paraADst: document.getElementById('para')?.nextElementSibling?.textContent,
    paraACovered: document.querySelector('#para a')?.closest('[data-om-tx]')?.id,
    // 页脚：caption span 与裸链接列收录翻译
    footMarked: document.getElementById('foot')?.querySelectorAll('[data-om-tx]').length,
    footChat: document.querySelector('#foot a')?.textContent,
    footChatDst: document.querySelector('#foot a')?.nextElementSibling?.textContent,
    footProductsDst: document.querySelector('#foot span')?.nextElementSibling?.textContent,
    // 页眉导航链接也收录翻译；按钮控件文本不译
    hdrMarked: document.getElementById('hdr')?.querySelectorAll('[data-om-tx]').length,
    hdrDst: document.querySelector('#hdr a')?.nextElementSibling?.textContent,
    ctaMarked: document.getElementById('cta-btn')?.querySelectorAll('[data-om-tx]').length,
  })`));

  const zh = (s) => typeof s === 'string' && s.includes('【中】');
  check('普通 <p> 段落照常翻译（回归）', zh(snap.plainDst), snap.plainDst);
  check('分组行内 <h3> 翻译，译文在 rowheader 内部', zh(snap.ghDstText), snap.ghDstText);
  check('rowheader 功能名翻译', zh(snap.rh1) && zh(snap.rh2), `${snap.rh1} | ${snap.rh2}`);
  check('文本 cell 翻译', zh(snap.c1b) && zh(snap.c2b), `${snap.c1b} | ${snap.c2b}`);
  check('columnheader 计划名整格翻译（含 <a> CTA 不拒收）', zh(snap.chFree) && zh(snap.chTeams), `${snap.chFree} | ${snap.chTeams}`);
  check('ARIA 格子译文在格子内部（非兄弟插入）', snap.rh1HasDstInside && snap.c1bHasDstInside && snap.chFreeHasDstInside);
  check('grid 行子元素数不变（译文未挤占网格列）', snap.headRowChildren === 2 && snap.r1Children === 3 && snap.gRowChildren === 1,
    `head=${snap.headRowChildren} r1=${snap.r1Children} g=${snap.gRowChildren}`);
  check('纯图标 cell 不收录不回填', !snap.iconMarked, `marked=${snap.iconMarked}`);
  check('真表格 <th> 翻译且译文在格子内部', zh(snap.th1) && snap.th1HasDstInside, snap.th1);
  check('真表格 <td> 翻译且译文在格子内部', zh(snap.td1) && snap.td1HasDstInside, snap.td1);
  check('真表格行子元素数不变', snap.thRowChildren === 2, `thRow=${snap.thRowChildren}`);
  check('手风琴问题头（h3>button+svg）整块翻译', zh(snap.faqDst), snap.faqDst);
  check('手风琴按钮原样保留且未被单独收录', snap.faqBtnAlive, `btn=${snap.faqBtnAlive}`);
  check('手风琴答案段落翻译', zh(snap.faqADst), snap.faqADst);
  check('带内联链接的段落整块收录（链接不单拆）', snap.paraMarked && snap.paraACovered === 'para' && zh(snap.paraADst),
    `marked=${snap.paraMarked} covered=${snap.paraACovered} dst=${snap.paraADst}`);
  check('页脚 caption + 裸链接列收录翻译（5 块）', snap.footMarked === 5 && zh(snap.footChatDst) && zh(snap.footProductsDst),
    `marked=${snap.footMarked} chatDst=${snap.footChatDst} spanDst=${snap.footProductsDst}`);
  check('页眉导航链接收录翻译（header 不再整块跳过）', snap.hdrMarked === 1 && zh(snap.hdrDst),
    `marked=${snap.hdrMarked} dst=${snap.hdrDst}`);
  check('按钮控件文本不译', snap.ctaMarked === 0, `marked=${snap.ctaMarked}`);
  check('无失败块', st.failed === 0, `failed=${st.failed}`);
  check(`收录块数 = ${EXPECT_MARKED}`, st.marked === EXPECT_MARKED, `marked=${st.marked}`);
  check('页面无未捕获异常', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));

  page.close();
} catch (e) {
  console.error('FAIL 异常', e.message);
  check('流程完整跑完', false, e.message);
} finally {
  await browser.close();
  mock.close();
  web.close();
  await sleep(300);
}
process.exit(summary());
