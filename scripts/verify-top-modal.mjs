// e2e：顶部区域与弹层翻译（x.ai/pricing 型）。此前三类内容永远进不了翻译：
// 1) 顶栏导航在 <header> 里，曾被 SKIP_ANCESTORS 整块跳过——但悬停大菜单也挂在
//    header 内部，一跳全跳；导航链接（li>a、裸 a、带 svg chevron 的 a）现在照常收录。
// 2) 淡入弹层（opacity:0 → 1）与悬停注入的菜单：IO 只在几何量变化时回调，可见性
//    校验若把 opacity:0 的块扣下，永远等不到第二次回调——弹出后不自动翻译即此。
// 3) 选项卡标签（button[role=tab]>span）：按钮文本不译是通例，选项卡是内容导航，豁免。
// fixture 模拟：header 导航 + 翻译开始后 900ms 注入淡入菜单（React portal 模式）
// + 展开一个 hidden 区块（display:none，IO 应在获得几何量后补发）。
// 用法：node scripts/verify-top-modal.mjs
import { createServer } from 'node:http';
import { launch, sleep, waitFor, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();

const CHEVRON = '<svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.75" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; }
  nav ul { display: flex; gap: 8px; list-style: none; margin: 0; padding: 0; }
  [role="tablist"] { display: flex; gap: 8px; margin-top: 12px; }
</style></head><body>
<header id="hdr">
  <nav><ul>
    <li id="nav-products"><a id="lnk-products" href="#" onclick="return false">Products${CHEVRON}</a></li>
    <li id="nav-pricing"><a id="lnk-pricing" href="#" onclick="return false">Pricing</a></li>
  </ul></nav>
  <a id="lnk-sales" href="#" onclick="return false">Contact Sales</a>
  <div id="menu-wrap"></div>
</header>
<main>
  <h1 id="hero-title">Pricing</h1>
  <p id="hero-sub">One subscription. Access to everything.</p>
  <div role="tablist">
    <button role="tab" id="tab-ind" type="button" aria-selected="true"><span id="tab-ind-span">Individual</span></button>
    <button role="tab" id="tab-teams" type="button" aria-selected="false"><span id="tab-teams-span">Teams</span></button>
  </div>
  <button id="cta-btn" type="button"><span id="cta-span">Subscribe</span></button>
  <div id="later" hidden><p id="hidden-p">Early access to new features for annual plans.</p></div>
</main>
<script>
  // 模拟悬停打开大菜单（React portal：容器原本为空）+ 展开隐藏区块
  window.__interact = () => {
    const panel = document.createElement('div');
    panel.id = 'menu-panel';
    panel.style.cssText = 'opacity:0;transition:opacity .3s'; // 淡入：几何量一直存在，opacity 变化不触发 IO
    panel.innerHTML = '<a id="menu-chat" href="#" onclick="return false">'
      + '<span id="menu-chat-title">Chat</span>'
      + '<p id="menu-chat-desc">Frontier reasoning with real-time knowledge and web search.</p></a>';
    document.getElementById('menu-wrap').appendChild(panel);
    setTimeout(() => { panel.style.opacity = '1'; }, 250);
    document.getElementById('later').hidden = false;
  };
</script>
</body></html>`;

// 期望收录 10 块：导航 li×2（含带 svg 的 Products）+ 顶栏裸 a×1 + h1 + p + 选项卡 span×2
// + hidden 区块 p×1 + 注入菜单 span×1 + p×1；菜单容器 a（后代已收录）、普通按钮 span 不收
const EXPECT_MARKED = 10;

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

const browser = await launch({ port: 9385, url: 'about:blank' });
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

  let widget = await waitFor(() => E(`Boolean(document.getElementById('om-widget-host')?.shadowRoot?.querySelector('[data-act="translate-page"]'))`), { timeout: 6000 });
  if (!widget) {
    await page.send('Page.reload');
    await sleep(2000);
    await page.send('Page.bringToFront');
    widget = await waitFor(() => E(`Boolean(document.getElementById('om-widget-host')?.shadowRoot?.querySelector('[data-act="translate-page"]'))`), { timeout: 8000 });
  }
  if (!widget) throw new Error('浮窗未注入');

  await E(`document.getElementById('om-widget-host').shadowRoot.querySelector('[data-act="translate-page"]').click()`);
  // 翻译进行中模拟用户悬停：注入淡入菜单 + 展开 hidden 区块（MutationObserver / IO 补发路径）
  await E(`setTimeout(window.__interact, 900)`);
  // IO 回调挂在渲染管线上：真实页面有光标/动画等持续渲染源，headless 静页可能长时间
  // 没有渲染帧，新收录块的初始交叉状态一直不派发——用周期微滚动维持渲染帧
  await sleep(1000);
  await page.send('Page.bringToFront');
  await E(`let n = 0; const poke = setInterval(() => { window.scrollBy(0, (n = !n) ? 1 : -1); }, 350); setTimeout(() => clearInterval(poke), 8000)`);

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
    // 顶栏导航：块是 li 内的 <a>（li 文本全来自唯一子链接时让链接当块，沉浸模式导航可点），
    // 带 svg 的 Products 也收录；译文插在 li 内
    navProductsMarked: document.getElementById('lnk-products')?.hasAttribute('data-om-tx'),
    navProductsDst: document.getElementById('nav-products')?.querySelector(':scope > .om-tx-dst')?.textContent,
    navPricingDst: document.getElementById('nav-pricing')?.querySelector(':scope > .om-tx-dst')?.textContent,
    salesMarked: document.getElementById('lnk-sales')?.hasAttribute('data-om-tx'),
    salesDst: document.getElementById('lnk-sales')?.nextElementSibling?.textContent,
    // hero 主/副标题
    heroTitleDst: document.getElementById('hero-title')?.nextElementSibling?.textContent,
    heroSubDst: document.getElementById('hero-sub')?.nextElementSibling?.textContent,
    // 选项卡标签翻译；普通按钮不译
    tabIndMarked: document.getElementById('tab-ind-span')?.hasAttribute('data-om-tx'),
    tabIndDst: document.getElementById('tab-ind-span')?.nextElementSibling?.textContent,
    tabTeamsDst: document.getElementById('tab-teams-span')?.nextElementSibling?.textContent,
    ctaMarked: document.getElementById('cta-span')?.hasAttribute('data-om-tx'),
    // 注入的淡入菜单：a 不重复收录，内部 span/p 翻译
    menuMarked: document.getElementById('menu-chat')?.hasAttribute('data-om-tx'),
    menuTitleDst: document.getElementById('menu-chat-title')?.nextElementSibling?.textContent,
    menuDescDst: document.getElementById('menu-chat-desc')?.nextElementSibling?.textContent,
    // hidden 区块展开后 IO 补发
    hiddenPDst: document.getElementById('hidden-p')?.nextElementSibling?.textContent,
  })`));

  const zh = (s) => typeof s === 'string' && s.includes('【中】');
  check('带 svg chevron 的导航链接收录（块为 <a>，译文在 li 内）', snap.navProductsMarked && zh(snap.navProductsDst), `marked=${snap.navProductsMarked} dst=${snap.navProductsDst}`);
  check('无图标导航链接翻译', zh(snap.navPricingDst), snap.navPricingDst);
  check('顶栏裸链接（Contact Sales）收录翻译', snap.salesMarked && zh(snap.salesDst), `marked=${snap.salesMarked} dst=${snap.salesDst}`);
  check('hero 主/副标题翻译', zh(snap.heroTitleDst) && zh(snap.heroSubDst), `${snap.heroTitleDst} | ${snap.heroSubDst}`);
  check('选项卡标签（role=tab）翻译', snap.tabIndMarked && zh(snap.tabIndDst) && zh(snap.tabTeamsDst), `${snap.tabIndDst} | ${snap.tabTeamsDst}`);
  check('普通按钮文本仍不译', !snap.ctaMarked, `marked=${snap.ctaMarked}`);
  check('淡入菜单注入后自动翻译（span 标题 + p 描述）', zh(snap.menuTitleDst) && zh(snap.menuDescDst), `${snap.menuTitleDst} | ${snap.menuDescDst}`);
  check('菜单容器 <a> 不重复收录（后代已收录）', !snap.menuMarked, `marked=${snap.menuMarked}`);
  check('hidden 区块展开后翻译（IO 几何量补发）', zh(snap.hiddenPDst), snap.hiddenPDst);
  check('无失败块且无残留「翻译中」', st.failed === 0 && st.wait === 0, `failed=${st.failed} wait=${st.wait}`);
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
