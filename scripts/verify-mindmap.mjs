// e2e：划词高亮 → 思维导图全链路（本地 mock LLM，不产生真实调用）。
// 新交互：高亮只入素材库（toast 反馈，不调 LLM）；工具条「思维导图」只开查看页——
// 有旧图直接渲染（素材有更新仅状态提示，不自动生成），没图显示素材卡；点「生成 /
// 重新生成」才调 LLM（prompt = 网页正文上下文 + 全部高亮片段）；同页导图原位更新。
// 双生成模式：高亮素材（buildMindmapPrompt）与整页正文（buildMindmapFullPrompt，
// 不需要高亮）同页各存一条（rec.mode），重新生成沿用当前模式；叶子带〔片段n〕/
// 〔§小节名〕出处标注，渲染成小字角标（tspan.om-mm-ref），导出与编辑往返保留。
// 画布可见性是真回归断言（0.9.1 前空白根因：SVGElement 无 hidden IDL，display:none 常驻）：
// 计算样式 / clientWidth / 节点屏幕矩形与视口相交都要查。另覆盖：双击改名、编辑大纲、
// 素材卡删除、取消高亮同步移出素材库、折叠 / 平移缩放、导出 .md 与 .mm、#id= 重开
// 不调 LLM、手动粘贴生成（无网页上下文）、无未捕获异常。
// 另覆盖：浮窗「导图」钮（无需选中文字的常驻入口）、顶栏「高亮导图 / 整页导图」双模式
// 互切（有旧图直开零调用、无旧图点击即生成）、「新导图」清空后「‹ 返回导图」一键回退。
// 用法：node scripts/verify-mindmap.mjs
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, waitFor, createChecker, seedStorage, connect } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();

// mock 返回的大纲（结构已知，断言节点数：根 1 + 3 分支 + 4 叶 = 8）
const OUTLINE_MD = [
  '- 分支甲',
  '  - 甲一',
  '    - MM-LEAF-X',
  '  - 甲二',
  '- 分支乙',
  '  - 乙一',
  '- 分支丙',
].join('\n');
const NODE_TOTAL = 8;
// 整页模式的大纲（根 1 + 2 分支 + 2 叶 = 5）：带 § 小节出处标注，断言角标渲染
const FULL_OUTLINE_MD = [
  '- 架构总览',
  '  - JobManager〔§运行时架构〕',
  '  - MM-FULL-LEAF',
  '- 部署模式',
].join('\n');
const FULL_NODE_TOTAL = 5;

const web = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>测试文章</title></head><body><article>
<h1>测试文章</h1>
<p id="p1">Flink 运行时架构 OM-HL-A：JobManager 负责作业调度与检查点协调。</p>
<p id="p2">TaskManager 执行数据流算子 OM-HL-B，并通过网络交换数据。</p>
<p id="p3">Dispatcher 提供 REST 入口 OM-HL-C，负责接收作业提交。</p>
<p id="p4">本页背景段落 OM-PAGE-CTX，不会被高亮，但应进入页面正文快照供理解上下文。</p>
</article></body></html>`);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${web.address().port}/page`;

const mock = await startMockLlm({
  respond: (req) => {
    const userText = [...req.messages].reverse().find((m) => m.role === 'user')?.text || '';
    if (/整页快照/.test(userText)) return { text: FULL_OUTLINE_MD, chunkDelayMs: 8 };
    if (/思维导图大纲/.test(userText)) return { text: OUTLINE_MD, chunkDelayMs: 8 };
    return { text: 'mock 默认回答' };
  },
});

const downloadDir = mkdtempSync(join(tmpdir(), 'vela-mm-'));
const browser = await launch({ port: 9363, url: PAGE_URL });
const exceptions = [];
const trackEx = (s) => s.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
const statusOf = (s) => s.evaluate(`document.getElementById('om-mm-status').textContent`);
const nodeCount = (s) => s.evaluate(`document.querySelectorAll('g.om-mm-node').length`);
const inboxOf = (s, key) => s.evaluate(`chrome.storage.local.get('omMindmapInbox').then((o) => JSON.stringify(o.omMindmapInbox?.[${JSON.stringify(key)}] || null))`);
const mapsOf = (s) => s.evaluate(`chrome.storage.local.get('omMindmaps').then((o) => JSON.stringify(o.omMindmaps || []))`);
// 画布可见性体检：hidden 属性 / 计算样式 / 尺寸 / 节点屏幕矩形与 svg 视口相交数
const visualOf = (s) => s.evaluate(`(() => {
  const svg = document.getElementById('om-mm-svg');
  const sr = svg.getBoundingClientRect();
  const gs = [...document.querySelectorAll('g.om-mm-node')];
  const inside = gs.filter((g) => {
    const r = g.getBoundingClientRect();
    return r.width > 5 && r.height > 5 && r.left < sr.right && r.right > sr.left && r.top < sr.bottom && r.bottom > sr.top;
  }).length;
  return { hiddenAttr: svg.hasAttribute('hidden'), display: getComputedStyle(svg).display,
    cw: svg.clientWidth, ch: svg.clientHeight, bboxW: document.getElementById('om-mm-g')?.getBBox()?.width ?? 0,
    nodes: gs.length, inside };
})()`);

try {
  // ---- 供应商预置：激活供应商指向 mock ----
  const sw = await browser.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [
        { id: 'p-mm', name: '导图供应商', kind: 'openai', baseUrl: mock.url('mm') + '/v1', apiKey: 'kmm', models: ['mm-model'] },
      ],
      activeProviderId: 'p-mm',
      agentBridge: { url: 'ws://127.0.0.1:39299', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' },
    },
    conversations: [],
  });
  sw.close();

  const pageT = (await browser.targets()).find((t) => t.type === 'page' && t.url === PAGE_URL);
  const page = await connect(pageT.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await waitFor(() => page.evaluate(`!!document.getElementById('p1')`));

  // 页内助手：选中段落文本 → 冒泡 mouseup 拉起划词工具条 → 点指定动作。
  // 标签页必须在前台：无焦点文档里 Chrome 会丢脚本式选区（工具条弹不出），
  // 查看页一开就会抢焦点，所以每次交互前先 activate 再试，最多三轮
  const selOnce = (id, act) => page.evaluate(`(async () => {
    const p = document.getElementById(${JSON.stringify(id)});
    // 高亮包装后段内会残留一个空文本节点（extractContents 的原节点壳），必须跳过
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent.trim()) node = walker.nextNode();
    const r = document.createRange();
    r.setStart(node, 0); r.setEnd(node, node.textContent.length);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((r2) => setTimeout(r2, 150));
    const btn = document.getElementById('om-sel-host')?.shadowRoot?.querySelector('button[data-act="${act}"]');
    if (!btn) return { ok: false, sel: String(s).slice(0, 16), acts: [...document.getElementById('om-sel-host')?.shadowRoot?.querySelectorAll('button') ?? []].map((b) => b.dataset.act) };
    btn.click();
    return { ok: true };
  })()`);
  const selAct = async (id, act) => {
    let last = null;
    for (let i = 0; i < 3; i++) {
      await browser.activate(pageT.id);
      await sleep(200);
      last = await selOnce(id, act);
      if (last.ok) return last;
    }
    return last;
  };

  // ---- 1. 高亮只入素材库（不调 LLM） ----
  await selAct('p1', 'highlight');
  const toast1 = await waitFor(() => page.evaluate(`document.getElementById('om-mm-collect-toast')?.textContent`), { timeout: 5000 });
  check('高亮 p1：toast 提示已记入素材（1 段）', toast1 === '已记入本页导图素材 · 共 1 段', toast1);
  check('高亮 p1：页面出现 .om-hl', (await page.evaluate(`document.querySelectorAll('.om-hl').length`)) === 1);
  await selAct('p2', 'highlight');
  const toast2 = await waitFor(() => page.evaluate(`document.getElementById('om-mm-collect-toast')?.textContent === '已记入本页导图素材 · 共 2 段' ? 'ok' : null`), { timeout: 5000 });
  check('高亮 p2：素材累计 2 段', !!toast2);
  check('高亮阶段零 LLM 调用', mock.requests.length === 0, mock.requests.length);

  // ---- 2. 工具条「思维导图」只开查看页：素材卡可见，仍零调用 ----
  await selAct('p1', 'mindmap');
  const mmAT = await waitFor(async () => (await browser.targets())
    .find((t) => t.type === 'page' && t.url.includes('/src/mindmap/mindmap.html')), { timeout: 10000 });
  check('点击后新开思维导图查看页', !!mmAT, mmAT?.url);
  const mmA = await connect(mmAT.webSocketDebuggerUrl);
  await mmA.send('Runtime.enable');
  trackEx(mmA);
  await mmA.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: false });
  await waitFor(() => mmA.evaluate(`!document.getElementById('om-mm-input').hidden`), { timeout: 8000 });
  const matCard = await mmA.evaluate(`(() => ({
    cardVisible: !document.getElementById('om-mm-page-card').hidden,
    items: [...document.getElementById('om-mm-mat-list').querySelectorAll('.om-mm-m-text')].map((s) => s.textContent),
    runDisabled: document.getElementById('om-mm-mat-run').disabled,
    runLabel: document.getElementById('om-mm-mat-run').textContent,
    svgHidden: document.getElementById('om-mm-svg').hasAttribute('hidden'),
    matBtnText: document.getElementById('om-mm-mat').textContent,
  }))()`);
  check('查看页落素材卡（不自动生成）', matCard.cardVisible && matCard.items.length === 2
    && matCard.items[0].includes('OM-HL-A') && matCard.items[1].includes('OM-HL-B'), matCard);
  check('素材卡生成钮可用 / 画布未挂 / 顶栏素材角标', !matCard.runDisabled && matCard.runLabel === '生成思维导图' && matCard.svgHidden && matCard.matBtnText === '素材（2）', matCard);
  check('打开查看页零 LLM 调用', mock.requests.length === 0, mock.requests.length);

  // ---- 3. 显式点「生成思维导图」：完成 + prompt（正文上下文 + 片段）+ 画布可见 ----
  await mmA.evaluate(`document.getElementById('om-mm-mat-run').click()`);
  const done = await waitFor(() => statusOf(mmA).then((t) => (t.includes('完成') ? t : null)), { timeout: 15000 });
  check('生成完成并显示节点数', /完成 · 8 节点/.test(done || ''), done);
  check('渲染全部节点', (await nodeCount(mmA)) === NODE_TOTAL);
  check('根节点为页面标题', (await mmA.evaluate(`document.querySelector('g.om-mm-root text').textContent`)) === '测试文章');
  const req1 = mock.requests[0];
  const pt = req1?.messages.at(-1)?.text || '';
  check('prompt：网页正文上下文 + 两个高亮片段', pt.includes('网页正文（供理解上下文') && pt.includes('OM-PAGE-CTX')
    && pt.includes('【高亮片段】') && pt.includes('OM-HL-A') && pt.includes('OM-HL-B'), pt.slice(0, 160));
  check('prompt：未高亮段落不进片段、带页面标题', !pt.slice(pt.lastIndexOf('【高亮片段】')).includes('OM-HL-C')
    && pt.includes('网页标题：测试文章') && !pt.includes('已记入本页导图素材'), pt.slice(-200));
  const vis = await visualOf(mmA);
  check('画布可见性体检（hidden 属性 / display / 尺寸 / bbox）', !vis.hiddenAttr && vis.display !== 'none' && vis.cw > 200 && vis.ch > 200 && vis.bboxW > 50, vis);
  check('节点屏幕矩形与画布视口相交（非 display:none 假渲染）', vis.nodes === NODE_TOTAL && vis.inside === NODE_TOTAL, vis);
  const saved1 = JSON.parse(await mapsOf(mmA));
  check('生成结果存历史（按页 key 原位一条，含素材指纹）', saved1.length === 1 && saved1[0].key === PAGE_URL
    && saved1[0].title === '测试文章' && saved1[0].nodes === NODE_TOTAL && /^[0-9a-z]+$/.test(saved1[0].sig || '') && saved1[0].md.includes('分支甲'), saved1);
  const SIG1 = saved1[0].sig;

  // 从工具条再开一次查看页：等一个「没见过的」思维导图标签出现（targets() 每次返回新对象，按 id 排除）
  const seenMmIds = new Set([mmAT.id]);
  const openViewer = async () => {
    const t = await waitFor(async () => (await browser.targets())
      .find((x) => x.type === 'page' && x.url.includes('/src/mindmap/mindmap.html') && !seenMmIds.has(x.id)), { timeout: 10000 });
    if (!t) return null;
    seenMmIds.add(t.id);
    const s = await connect(t.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    trackEx(s);
    s.targetId = t.id;
    return s;
  };

  // ---- 4. 素材没变时重开：直接渲染旧图，零调用 ----
  await selAct('p1', 'mindmap');
  const mmB = await openViewer();
  const reopen1 = await waitFor(() => nodeCount(mmB).then((n) => (n === NODE_TOTAL ? n : null)), { timeout: 8000 });
  const st4 = await statusOf(mmB);
  check('重开（素材没变）直接渲染旧图，零调用', reopen1 === NODE_TOTAL && !st4.includes('素材有更新') && mock.requests.length === 1, `nodes=${reopen1} status=${st4} req=${mock.requests.length}`);
  const vis4 = await visualOf(mmB);
  check('重开画布可见', vis4.display !== 'none' && vis4.inside === NODE_TOTAL, vis4);
  mmB.close();
  await fetch(`${browser.base}/json/close/${mmB.targetId}`);

  // ---- 5. 再高亮一段：只记素材，重开提示「素材有更新」，仍不自动生成 ----
  await selAct('p3', 'highlight');
  const toast3 = await waitFor(() => page.evaluate(`document.getElementById('om-mm-collect-toast')?.textContent === '已记入本页导图素材 · 共 3 段' ? 'ok' : null`), { timeout: 5000 });
  check('高亮 p3：素材累计 3 段', !!toast3);
  await selAct('p1', 'mindmap');
  const mmC = await openViewer();
  check('第二次重开新标签', !!mmC);
  await waitFor(() => nodeCount(mmC).then((n) => (n === NODE_TOTAL ? n : null)), { timeout: 8000 });
  const st5 = await statusOf(mmC);
  check('素材有更新仅状态提示，不自动生成', st5.includes('素材有更新（3 段）') && mock.requests.length === 1, `status=${st5} req=${mock.requests.length}`);
  check('重开仍是旧图（未重算指纹）', (await mmC.evaluate(`document.querySelector('g.om-mm-root text').textContent`)) === '测试文章');

  // ---- 6. 显式「重新生成」：+1 调用，prompt 带新片段，历史原位更新 ----
  await mmC.evaluate(`document.getElementById('om-mm-regen').click()`);
  const done2 = await waitFor(() => statusOf(mmC).then((t) => (t.includes('完成') ? t : null)), { timeout: 15000 });
  const req2 = mock.requests.at(-1);
  const pt2 = req2?.messages.at(-1)?.text || '';
  check('重新生成完成且 prompt 带第 3 段高亮', /完成 · 8 节点/.test(done2 || '') && mock.requests.length === 2
    && pt2.slice(pt2.indexOf('【高亮片段】')).includes('OM-HL-C'), `req=${mock.requests.length} ${done2}`);
  const saved2 = JSON.parse(await mapsOf(mmC));
  const pageRecs = saved2.filter((r) => r.key === PAGE_URL);
  check('重新生成后历史仍一条（原位更新）且指纹更新', saved2.length === 1 && pageRecs.length === 1 && pageRecs[0].sig !== SIG1, saved2.map((r) => ({ id: r.id, sig: r.sig })));

  // ---- 7. 取消高亮：素材库同步移除 ----
  await selAct('p2', 'highlight'); // 选区两端都在 .om-hl 内 → 再点高亮 = 取消
  const afterCancel = await waitFor(async () => {
    const p = JSON.parse(await inboxOf(mmC, PAGE_URL));
    return p && p.items.length === 2 && !p.items.some((it) => it.text.includes('OM-HL-B')) ? p.items.length : null;
  }, { timeout: 5000 });
  check('取消高亮同步移出素材库（3 → 2）', afterCancel === 2, afterCancel);
  check('取消后页面无残留 span', (await page.evaluate(`document.querySelectorAll('.om-hl').length`)) === 2);

  // ---- 8. 双击节点就地改名 ----
  await mmC.evaluate(`(() => {
    const g = [...document.querySelectorAll('g.om-mm-node')].find((x) => x.textContent.includes('分支甲'));
    g.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  const renameShown = await waitFor(() => mmC.evaluate(`!!document.getElementById('om-mm-rename')?.querySelector('input')`), { timeout: 5000 });
  check('双击节点弹就地改名框', !!renameShown);
  await mmC.evaluate(`(() => {
    const inp = document.getElementById('om-mm-rename').querySelector('input');
    inp.value = '分支甲改';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitFor(() => mmC.evaluate(`[...document.querySelectorAll('g.om-mm-node')].some((g) => g.textContent.includes('分支甲改'))`), { timeout: 5000 });
  const st8 = await statusOf(mmC);
  check('改名生效（界面 + 状态）', st8.includes('已改名'), st8);
  const saved3 = JSON.parse(await mapsOf(mmC));
  check('改名即时回存历史', saved3[0]?.md.includes('分支甲改'), saved3[0]?.md?.slice(0, 80));

  // ---- 9. 编辑大纲：markdown 往返改结构 ----
  await mmC.evaluate(`document.getElementById('om-mm-edit').click()`);
  const edShown = await mmC.evaluate(`(() => ({
    visible: !document.getElementById('om-mm-editor').hidden,
    md: document.getElementById('om-mm-ed-text').value,
  }))()`);
  check('编辑大纲视图打开且内容与树同步', edShown.visible && edShown.md.startsWith('# 测试文章') && edShown.md.includes('分支甲改'), edShown.md?.slice(0, 60));
  await mmC.evaluate(`(() => {
    document.getElementById('om-mm-ed-text').value = '# 新中心\\n- 分支甲改\\n  - ED-LEAF-Q\\n- 分支乙\\n  - 乙一\\n- 分支丙';
    document.getElementById('om-mm-ed-apply').click();
  })()`);
  const st9 = await waitFor(() => statusOf(mmC).then((t) => (t.includes('已编辑') ? t : null)), { timeout: 5000 });
  check('应用大纲后重渲染（6 节点 + 新中心标题）', /已编辑 · 共 6 节点/.test(st9 || '')
    && (await nodeCount(mmC)) === 6
    && (await mmC.evaluate(`document.querySelector('g.om-mm-root text').textContent`)) === '新中心'
    && (await mmC.evaluate(`document.getElementById('om-mm-title').textContent`)) === '新中心', st9);
  check('编辑后历史仍原位一条且存新大纲', (JSON.parse(await mapsOf(mmC))).length === 1
    && JSON.parse(await mapsOf(mmC))[0].md.includes('ED-LEAF-Q'));

  // ---- 10. 折叠 / 展开 / 平移缩放 ----
  await mmC.evaluate(`[...document.querySelectorAll('g.om-mm-branch')].find((g) => g.textContent.includes('分支甲改')).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(150);
  check('折叠分支甲改：6 → 5 节点（徽标不算节点）', (await nodeCount(mmC)) === 5);
  await mmC.evaluate(`document.getElementById('om-mm-unfold').click()`);
  await sleep(150);
  check('全部展开恢复', (await nodeCount(mmC)) === 6);
  const moved = await mmC.evaluate(`(async () => {
    const svg = document.getElementById('om-mm-svg');
    const t0 = document.getElementById('om-mm-g').getAttribute('transform');
    svg.dispatchEvent(new PointerEvent('pointerdown', { clientX: 400, clientY: 300, pointerId: 7, button: 0, isPrimary: true, bubbles: true }));
    svg.dispatchEvent(new PointerEvent('pointermove', { clientX: 460, clientY: 330, pointerId: 7, bubbles: true }));
    svg.dispatchEvent(new PointerEvent('pointerup', { clientX: 460, clientY: 330, pointerId: 7, bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const t1 = document.getElementById('om-mm-g').getAttribute('transform');
    svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, clientX: 500, clientY: 300, cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    return { t0, t1, t2: document.getElementById('om-mm-g').getAttribute('transform') };
  })()`);
  check('拖拽平移生效', moved.t0 !== moved.t1, `${moved.t0} → ${moved.t1}`);
  check('滚轮放大生效（scale 变大）', parseFloat((moved.t2.match(/scale\(([\d.]+)\)/) || [])[1]) > parseFloat((moved.t1.match(/scale\(([\d.]+)\)/) || [])[1]), moved.t2);

  // ---- 11. 导出 .md / .mm（真实下载落盘） ----
  await mmC.evaluate(`document.getElementById('om-mm-fit').click()`);
  await mmC.evaluate(`document.getElementById('om-mm-exp-md').click()`);
  await waitFor(async () => {
    const r = JSON.parse(await mmC.evaluate(`chrome.downloads.search({}).then((l) => JSON.stringify(l.map((d) => d.state)))`));
    return r.includes('complete') ? r : null;
  }, { timeout: 8000 });
  let files = readdirSync(downloadDir).map((f) => readFileSync(join(downloadDir, f), 'utf8'));
  check('导出 .md 落盘且为编辑后的规范大纲', files.some((c) => c.startsWith('# 新中心') && c.includes('分支甲改') && c.includes('ED-LEAF-Q')), readdirSync(downloadDir));
  await mmC.evaluate(`document.getElementById('om-mm-exp-mm').click()`);
  await waitFor(async () => {
    const r = JSON.parse(await mmC.evaluate(`chrome.downloads.search({}).then((l) => JSON.stringify(l.filter((d) => d.state === 'complete').length))`));
    return Number(r) >= 2 ? r : null;
  }, { timeout: 8000 });
  files = readdirSync(downloadDir).map((f) => readFileSync(join(downloadDir, f), 'utf8'));
  check('导出 .mm 落盘且为 FreeMind XML', files.some((c) => c.startsWith('<?xml') && c.includes('<map version="1.0.1">') && c.includes('TEXT="ED-LEAF-Q"')));

  // ---- 12. 素材卡管理：删除单段 ----
  await mmC.evaluate(`document.getElementById('om-mm-mat').click()`);
  await waitFor(() => mmC.evaluate(`!document.getElementById('om-mm-input').hidden && !document.getElementById('om-mm-page-card').hidden`), { timeout: 5000 });
  const matBefore = await mmC.evaluate(`(() => ({
    items: [...document.getElementById('om-mm-mat-list').querySelectorAll('.om-mm-m-text')].map((s) => s.textContent),
    runLabel: document.getElementById('om-mm-mat-run').textContent,
    btn: document.getElementById('om-mm-mat').textContent,
  }))()`);
  check('素材按钮回到素材卡（2 段 + 重新生成文案）', matBefore.items.length === 2 && matBefore.runLabel === '重新生成（用当前素材）'
    && matBefore.btn === '素材（2）', matBefore);
  await mmC.evaluate(`[...document.getElementById('om-mm-mat-list').querySelectorAll('button')][0].click()`);
  await waitFor(() => mmC.evaluate(`[...document.getElementById('om-mm-mat-list').querySelectorAll('.om-mm-m-text')].length === 1 ? 1 : null`), { timeout: 5000 });
  const inboxAfterDel = JSON.parse(await inboxOf(mmC, PAGE_URL));
  check('素材卡 × 删除单段并回写库', inboxAfterDel.items.length === 1 && !inboxAfterDel.items[0].text.includes('OM-HL-A'), inboxAfterDel.items.map((i) => i.text.slice(0, 20)));

  // ---- 13. #id= 重开：渲染同一导图，零调用 ----
  const rec = JSON.parse(await mapsOf(mmC))[0];
  const beforeReopen = mock.requests.length;
  const mmD = await browser.openTab(encodeURIComponent(`chrome-extension://${browser.extId}/src/mindmap/mindmap.html#id=${encodeURIComponent(rec.id)}`), { wait: 1200 });
  trackEx(mmD);
  const reopened = await waitFor(() => nodeCount(mmD).then((n) => (n === 6 ? n : null)), { timeout: 8000 });
  check('#id= 重开渲染编辑后的导图（不调 LLM）', reopened === 6 && mock.requests.length === beforeReopen,
    `nodes=${reopened} requests+${mock.requests.length - beforeReopen}`);
  mmD.close();
  mmA.close();
  mmC.close();

  // ---- 14. 手动粘贴生成：无页面模式（素材卡隐藏），prompt 无网页上下文 ----
  const mmE = await browser.openTab(`chrome-extension://${browser.extId}/src/mindmap/mindmap.html`, { wait: 1000 });
  trackEx(mmE);
  const inputShown = await mmE.evaluate(`(() => ({
    input: !document.getElementById('om-mm-input').hidden,
    matCardHidden: document.getElementById('om-mm-page-card').hidden,
    matBtnHidden: document.getElementById('om-mm-mat').hidden,
    regenHidden: document.getElementById('om-mm-regen').hidden,
    modeMatHidden: document.getElementById('om-mm-mode-mat').hidden,
    modeFullHidden: document.getElementById('om-mm-mode-full').hidden,
    backHidden: document.getElementById('om-mm-back').hidden,
  }))()`);
  check('无任务打开显示输入视图，素材卡/素材钮/重新生成/模式切换/返回均隐藏', inputShown.input && inputShown.matCardHidden && inputShown.matBtnHidden && inputShown.regenHidden
    && inputShown.modeMatHidden && inputShown.modeFullHidden && inputShown.backHidden, inputShown);
  check('历史列表可见', (await mmE.evaluate(`document.getElementById('om-mm-history').children.length >= 1`)));
  await mmE.evaluate(`(() => {
    document.getElementById('om-mm-in-title').value = '手动主题';
    document.getElementById('om-mm-in-text').value = 'MM-MANUAL-SRC 要整理的内容';
    document.getElementById('om-mm-in-run').click();
  })()`);
  const manualDone = await waitFor(() => statusOf(mmE).then((t) => (t.includes('完成') ? t : null)), { timeout: 15000 });
  check('手动输入生成成功', /完成 · 8 节点/.test(manualDone || ''), manualDone);
  check('手动根标题来自输入框', (await mmE.evaluate(`document.querySelector('g.om-mm-root text').textContent`)) === '手动主题');
  const manualReq = mock.requests.at(-1);
  const mpt = manualReq?.messages.at(-1)?.text || '';
  check('手动生成 prompt 带粘贴内容且无网页上下文', mpt.includes('MM-MANUAL-SRC') && mpt.includes('没有网页正文上下文') && !mpt.includes('OM-PAGE-CTX'), mpt.slice(0, 120));
  const savedAll = JSON.parse(await mapsOf(mmE));
  check('手动导图独立成条（无页 key）', savedAll.length === 2 && savedAll.some((r) => !r.key && r.title === '手动主题'), savedAll.map((r) => ({ t: r.title, key: r.key })));
  mmE.close();

  // ---- 15. 整页模式：不需要高亮素材，整篇正文生成；与高亮导图分开保存 ----
  const reqBeforeFull = mock.requests.length;
  // 第 13/14 段 openTab 开的 mmD/mmE 只断了 CDP 会话，标签还开着且不在 seenMmIds——
  // 先把现存思维导图标签全部登记，openViewer 才只会认本次新开的查看页
  for (const t of await browser.targets()) {
    if (t.type === 'page' && t.url.includes('/src/mindmap/mindmap.html')) seenMmIds.add(t.id);
  }
  await selAct('p1', 'mindmap');
  const mmF = await openViewer();
  check('整页段：查看页新开', !!mmF);
  // 素材 1 段 + 高亮旧图存在 → 默认展示高亮导图（已编辑 6 节点）并提示素材有更新
  const n15 = await waitFor(() => nodeCount(mmF).then((n) => (n === 6 ? n : null)), { timeout: 8000 });
  const st15 = await statusOf(mmF);
  check('整页段：默认仍展示高亮导图（6 节点 + 素材有更新提示）', n15 === 6 && st15.includes('素材有更新（1 段）'), `nodes=${n15} status=${st15}`);
  // 顶栏双模式切换：正在看的高亮导图高亮且禁用，整页导图可见可点（点击即生成）
  const modeState = await mmF.evaluate(`(() => {
    const m = document.getElementById('om-mm-mode-mat');
    const f = document.getElementById('om-mm-mode-full');
    return { matHidden: m.hidden, matDisabled: m.disabled, matPrimary: m.classList.contains('om-mm-primary'),
      fullHidden: f.hidden, fullDisabled: f.disabled, fullPrimary: f.classList.contains('om-mm-primary'),
      fullLabel: f.textContent };
  })()`);
  check('顶栏模式钮：高亮态禁用高亮、整页可点（画布视图也能见，不再藏在素材卡里）',
    !modeState.matHidden && modeState.matDisabled && modeState.matPrimary && !modeState.fullHidden
    && !modeState.fullDisabled && !modeState.fullPrimary && modeState.fullLabel === '整页导图', modeState);
  await mmF.evaluate(`document.getElementById('om-mm-mat').click()`);
  await waitFor(() => mmF.evaluate(`!document.getElementById('om-mm-input').hidden && !document.getElementById('om-mm-page-card').hidden`), { timeout: 5000 });
  const fullBtn = await mmF.evaluate(`(() => {
    const f = document.getElementById('om-mm-full-run');
    const m = document.getElementById('om-mm-mat-run');
    return { hidden: f.hidden, disabled: f.disabled, label: f.textContent, matLabel: m.textContent, matDisabled: m.disabled };
  })()`);
  check('整页生成钮可用且两颗按钮文案正确', !fullBtn.hidden && !fullBtn.disabled && fullBtn.label === '用整页正文生成'
    && fullBtn.matLabel === '重新生成（用当前素材）' && !fullBtn.matDisabled, fullBtn);
  // 整页生成走顶栏「整页导图」钮（无整页记录时点击即生成，画布视图直达）
  await mmF.evaluate(`document.getElementById('om-mm-mode-full').click()`);
  const fullDone = await waitFor(() => statusOf(mmF).then((t) => (t.includes('完成') ? t : null)), { timeout: 15000 });
  check('整页生成完成（5 节点）', /完成 · 5 节点/.test(fullDone || ''), fullDone);
  const reqFull = mock.requests.at(-1);
  const fpt = reqFull?.messages.at(-1)?.text || '';
  check('整页 prompt：整页快照正文、无高亮片段节', fpt.includes('整页快照') && fpt.includes('OM-PAGE-CTX') && !fpt.includes('【高亮片段】')
    && fpt.includes('宁整勿碎') && fpt.includes('〔§小节名〕'), fpt.slice(0, 140));
  check('整页调用恰一次', mock.requests.length === reqBeforeFull + 1, mock.requests.length - reqBeforeFull);
  // 出处角标：小字灰色 tspan，与主体文字分离但同属一个 text
  const refInfo = await mmF.evaluate(`(() => {
    const refs = [...document.querySelectorAll('#om-mm-svg tspan.om-mm-ref')];
    const main = [...document.querySelectorAll('#om-mm-svg tspan:not(.om-mm-ref)')].map((t) => t.textContent);
    return { count: refs.length, texts: refs.map((t) => t.textContent),
      fontSize: refs.length ? getComputedStyle(refs[0]).fontSize : '', hasMain: main.includes('JobManager'),
      sameLine: refs.length ? refs[0].previousElementSibling?.textContent : null };
  })()`);
  check('出处角标渲染：1 个 tspan.om-mm-ref，小字 11px', refInfo.count === 1 && refInfo.texts[0] === '〔§运行时架构〕'
    && refInfo.fontSize === '11px', refInfo);
  check('角标与主体分离渲染（JobManager 主文字在前）', refInfo.hasMain && refInfo.sameLine === 'JobManager', refInfo);
  const savedF = JSON.parse(await mapsOf(mmF));
  const pageRecsF = savedF.filter((r) => r.key === PAGE_URL);
  const fullRecF = pageRecsF.find((r) => r.mode === 'full');
  const matRecF = pageRecsF.find((r) => (r.mode || 'material') === 'material');
  check('同页双记录：高亮 + 整页各一条，整页指纹带 p 前缀', savedF.length === 3 && pageRecsF.length === 2 && !!fullRecF && !!matRecF
    && fullRecF.sig.startsWith('p') && fullRecF.nodes === FULL_NODE_TOTAL, savedF.map((r) => ({ t: r.title, m: r.mode, k: !!r.key })));
  check('整页记录标签保留出处（导出往返不丢）', fullRecF?.md.includes('JobManager〔§运行时架构〕'), fullRecF?.md?.slice(0, 80));
  check('高亮旧图未被整页生成覆盖', matRecF?.md.includes('ED-LEAF-Q'), matRecF?.md?.slice(0, 60));
  // 重新生成沿用整页模式（state.genMode=full），历史仍原位。
  // 等待必须两段式：点击后 loadSettings 异步间隙里状态栏还是上一轮的「完成」，
  // 直接等「完成」会立刻匹配旧值、后续点击落进生成窗口被 running 守卫吃掉——
  // 先等本次请求真正发出，再等完成。
  const reqBeforeRegen2 = mock.requests.length;
  await mmF.evaluate(`document.getElementById('om-mm-regen').click()`);
  await waitFor(() => (mock.requests.length > reqBeforeRegen2 ? 1 : null), { timeout: 8000 });
  const fullDone2 = await waitFor(() => statusOf(mmF).then((t) => (t.includes('完成') ? t : null)), { timeout: 15000 });
  const reqFull2 = mock.requests.at(-1);
  const fpt2 = reqFull2?.messages.at(-1)?.text || '';
  check('重新生成沿用整页模式', /完成 · 5 节点/.test(fullDone2 || '') && fpt2.includes('整页快照') && !fpt2.includes('【高亮片段】')
    && (JSON.parse(await mapsOf(mmF))).length === 3, fullDone2);

  // ---- 15b. 顶栏双模式互切：两方向都打开旧图，零 LLM 调用 ----
  const reqBeforeSwitch = mock.requests.length;
  // 按钮就绪再点（重新生成收尾时按钮短暂隐藏）
  await waitFor(() => mmF.evaluate(`(!document.getElementById('om-mm-mode-mat').hidden && !document.getElementById('om-mm-mode-mat').disabled) ? 1 : null`), { timeout: 8000 });
  await mmF.evaluate(`document.getElementById('om-mm-mode-mat').click()`);
  const backToMat = await waitFor(() => nodeCount(mmF).then((n) => (n === 6 ? n : null)), { timeout: 8000 });
  const matTitle = await mmF.evaluate(`document.querySelector('g.om-mm-root text').textContent`);
  const matState = await mmF.evaluate(`(() => { const m = document.getElementById('om-mm-mode-mat'); const f = document.getElementById('om-mm-mode-full');
    return { mDis: m.disabled, mPri: m.classList.contains('om-mm-primary'), fDis: f.disabled, fPri: f.classList.contains('om-mm-primary') }; })()`);
  check('切回高亮导图：旧图直开（6 节点）零调用，高亮态翻转到高亮钮',
    backToMat === 6 && matTitle === '新中心' && mock.requests.length === reqBeforeSwitch
    && matState.mDis && matState.mPri && !matState.fDis && !matState.fPri, { backToMat, matTitle, matState });
  await waitFor(() => mmF.evaluate(`(!document.getElementById('om-mm-mode-full').hidden && !document.getElementById('om-mm-mode-full').disabled) ? 1 : null`), { timeout: 8000 });
  await mmF.evaluate(`document.getElementById('om-mm-mode-full').click()`);
  const backToFull = await waitFor(() => nodeCount(mmF).then((n) => (n === 5 ? n : null)), { timeout: 8000 });
  check('再切整页导图：旧图直开（5 节点）零调用', backToFull === 5 && mock.requests.length === reqBeforeSwitch,
    `nodes=${backToFull} req+${mock.requests.length - reqBeforeSwitch}`);

  // ---- 15c. 「新导图」清空另起 + 「‹ 返回导图」一键回退 ----
  await mmF.evaluate(`document.getElementById('om-mm-new').click()`);
  const afterNew = await mmF.evaluate(`(() => ({
    input: !document.getElementById('om-mm-input').hidden,
    canvasHidden: document.getElementById('om-mm-svg').hasAttribute('hidden'),
    matCardHidden: document.getElementById('om-mm-page-card').hidden,
    backHidden: document.getElementById('om-mm-back').hidden,
  }))()`);
  check('新导图：清空进输入视图（粘贴卡），「返回导图」亮出', afterNew.input && afterNew.canvasHidden
    && afterNew.matCardHidden && !afterNew.backHidden, afterNew);
  await mmF.evaluate(`document.getElementById('om-mm-back').click()`);
  const restored = await waitFor(() => nodeCount(mmF).then((n) => (n === 5 ? n : null)), { timeout: 8000 });
  const backGone = await mmF.evaluate(`document.getElementById('om-mm-back').hidden`);
  check('返回导图：回到清空前的整页导图（5 节点），退路收起', restored === 5 && backGone, `nodes=${restored} backHidden=${backGone}`);

  // 历史列表带模式标签
  await mmF.evaluate(`document.getElementById('om-mm-mat').click()`);
  await waitFor(() => mmF.evaluate(`!document.getElementById('om-mm-input').hidden`), { timeout: 5000 });
  const histText = await mmF.evaluate(`document.getElementById('om-mm-history').textContent`);
  check('历史列表带「整页 / 高亮」模式标签', histText.includes('整页 · ') && histText.includes('高亮 · '), histText.slice(0, 120));
  mmF.close();

  // ---- 16. 浮窗「导图」钮：无需选中文字，与工具条同管线开本页查看页 ----
  for (const t of await browser.targets()) {
    if (t.type === 'page' && t.url.includes('/src/mindmap/mindmap.html')) seenMmIds.add(t.id);
  }
  await page.evaluate(`getSelection()?.removeAllRanges()`);
  const stackInfo = await page.evaluate(`(() => {
    const acts = [...document.getElementById('om-widget-host').shadowRoot.querySelectorAll('button[data-act]')].map((b) => b.dataset.act);
    return { acts, hasMedia: acts.includes('media') };
  })()`);
  check('浮窗动作列含导图钮（媒体大面板钮已移除）', stackInfo.acts.includes('mindmap') && !stackInfo.hasMedia, stackInfo);
  const reqBeforeWidget = mock.requests.length;
  await page.evaluate(`document.getElementById('om-widget-host').shadowRoot.querySelector('button[data-act="mindmap"]').click()`);
  const mmW = await openViewer();
  check('浮窗导图钮：新开查看页（无选区也能进）', !!mmW);
  const nW = await waitFor(() => nodeCount(mmW).then((n) => (n === 6 ? n : null)), { timeout: 8000 });
  const stW = await statusOf(mmW);
  check('浮窗入口默认展示高亮导图（零调用）', nW === 6 && stW.includes('素材有更新（1 段）') && mock.requests.length === reqBeforeWidget,
    `nodes=${nW} status=${stW} req+${mock.requests.length - reqBeforeWidget}`);
  mmW.close();

  check('全程无未捕获异常', exceptions.length === 0, exceptions);
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await browser.close();
  await mock.close();
  web.close();
  rmSync(downloadDir, { recursive: true, force: true });
}
process.exit(summary());
