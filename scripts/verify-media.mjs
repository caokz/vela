// e2e：网页媒体悬停交互全链路（本地 mock LLM，不产生真实调用）。
// 媒体唯一入口是 Monica 式悬停钮（浮窗大面板入口已按需求移除）：真鼠标移到图片 /
// 视频上 → 右上角浮出操作钮 → 点开就地弹层（媒体面板页单媒体模式）。图片：分析 /
// 提取（视觉附件随 user 消息下发）/ 进导图（一句话描述入素材库）/ 下载；视频：宿主
// 截关键帧（含 MediaRecorder webm duration=Infinity 修复）→ 整包视觉分析、直连视频
// 下载；弹层外点击与 ✕ 两条收起路径；换目标弹层就地重载；小图标不弹钮；全程无未捕获异常。
// 用法：node scripts/verify-media.mjs
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, waitFor, createChecker, seedStorage, connect, sleep } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();

// ---- 最小 PNG 编码器（RGB 纯色，给下载路径喂真实图片字节） ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG_A = makePng(160, 120, [80, 120, 220]);
const PNG_TINY = makePng(4, 4, [0, 0, 0]);
const FAKE_MP4 = Buffer.from('FAKE-MP4-BYTES-FOR-DOWNLOAD-ONLY');

const web = createServer((req, res) => {
  const send = (buf, type) => { res.writeHead(200, { 'content-type': type }); res.end(buf); };
  if (req.url === '/img/a.png') return send(PNG_A, 'image/png');
  if (req.url === '/img/tiny.png') return send(PNG_TINY, 'image/png');
  if (req.url === '/v.mp4') return send(FAKE_MP4, 'video/mp4');
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><title>媒体测试页</title></head><body>
<article><h1>媒体测试页</h1><p id="p1">正文段落 OM-PAGE-CTX。</p></article>
<!-- img-a 与 v1 左右拉开：悬停弹层（400px 宽）开着时不互相遮挡，能覆盖「换目标弹层重载」路径 -->
<div style="display:flex;align-items:flex-start">
<img id="img-a" src="/img/a.png" alt="架构示意图">
<video id="v1" muted playsinline style="margin-left:520px"></video>
</div>
<img id="img-tiny" src="/img/tiny.png" width="20" height="20" alt="小图标应被过滤">
<video id="v2" src="/v.mp4" muted></video>
<video id="v3" muted playsinline style="width:320px;height:180px"></video>
<script>
// mouseover 事件环形日志（诊断悬停钮用）：记录最近 40 条目标 + 坐标 + img-a 矩形
window.__omHovers = [];
document.addEventListener('mouseover', (ev) => {
  const t = ev.target;
  const ia = document.getElementById('img-a');
  const r = ia && ia.getBoundingClientRect();
  window.__omHovers.push({
    t: Math.round(performance.now()), tag: t.tagName, id: t.id || '',
    xy: [Math.round(ev.clientX), Math.round(ev.clientY)],
    ia: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
    sy: Math.round(scrollY),
  });
  if (window.__omHovers.length > 40) window.__omHovers.shift();
});
// 录一段三阶段文字的 webm（MediaRecorder），blob URL 挂到 v1——流式视频的真实形态
(function () {
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const x = c.getContext('2d');
  const phases = ['FRAME-A', 'FRAME-B', 'FRAME-C'];
  let i = 0;
  const draw = () => {
    x.fillStyle = '#24457a'; x.fillRect(0, 0, 320, 180);
    x.fillStyle = '#fff'; x.font = 'bold 36px sans-serif'; x.textAlign = 'center';
    x.fillText(phases[Math.min(i, 2)], 160, 100);
    i++;
  };
  draw();
  const rec = new MediaRecorder(c.captureStream(10), { mimeType: 'video/webm' });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  rec.onstop = () => {
    const v = document.getElementById('v1');
    v.src = URL.createObjectURL(new Blob(parts, { type: 'video/webm' }));
    v.play().then(() => setTimeout(() => v.pause(), 400));
    window.__omVidReady = true;
  };
  const tick = setInterval(draw, 700);
  rec.start();
  setTimeout(() => { clearInterval(tick); rec.stop(); }, 2100);
})();
// 真 MSE 流（bilibili 同形态）：录好的 webm 经 MediaSource + SourceBuffer 喂给 v3。
// v1 的 blob: 指向完整文件，v3 的 blob: 指向 MediaSource——seek 依赖缓冲数据、
// 定位后新帧要等解码完成 requestVideoFrameCallback 才上屏，截帧路径与真实流式站一致
(function () {
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const x = c.getContext('2d');
  const phases = ['MSE-A', 'MSE-B', 'MSE-C'];
  let i = 0;
  const draw = () => {
    x.fillStyle = '#1d5c33'; x.fillRect(0, 0, 320, 180);
    x.fillStyle = '#fff'; x.font = 'bold 36px sans-serif'; x.textAlign = 'center';
    x.fillText(phases[Math.min(i, 2)], 160, 100);
    i++;
  };
  draw();
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
  const rec = new MediaRecorder(c.captureStream(10), { mimeType: mime });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  rec.onstop = () => {
    const v = document.getElementById('v3');
    const ms = new MediaSource();
    v.src = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', () => {
      const sb = ms.addSourceBuffer(mime);
      sb.addEventListener('updateend', () => {
        if (ms.readyState === 'open') ms.endOfStream();
        v.play().then(() => setTimeout(() => v.pause(), 400));
        window.__omMseReady = true;
      }, { once: true });
      new Blob(parts).arrayBuffer().then((ab) => sb.appendBuffer(ab));
    }, { once: true });
  };
  const tick = setInterval(draw, 700);
  rec.start();
  setTimeout(() => { clearInterval(tick); rec.stop(); }, 2100);
})();
// data URL 图片（canvas 生成，带文字）：走提取 / 进导图冷路径
(function () {
  const c = document.createElement('canvas'); c.width = 240; c.height = 140;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 240, 140);
  x.fillStyle = '#111'; x.font = 'bold 26px sans-serif';
  x.fillText('OM-IMG-TXT', 30, 78);
  const img = new Image();
  img.id = 'img-data';
  img.alt = '画出来的图';
  img.src = c.toDataURL('image/png');
  document.body.appendChild(img);
})();
</script></body></html>`);
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${web.address().port}/page`;

const mock = await startMockLlm({
  respond: (req) => {
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.text || '';
    if (/分析这张网页图片/.test(user)) return { text: 'IMG-ANALYSIS-OK：这是蓝色矩形示意图。', chunkDelayMs: 6 };
    if (/完整提取成文本/.test(user)) return { text: 'IMG-EXTRACT-OK：OM-IMG-TXT', chunkDelayMs: 6 };
    if (/一两句话概括/.test(user)) return { text: 'DESC-COLD：画出来的图一张。', chunkDelayMs: 6 };
    if (/关键帧/.test(user)) return { text: 'VID-FRAMES-OK：依次出现 FRAME-A/B/C。', chunkDelayMs: 6 };
    return { text: 'mock 默认回答' };
  },
});

const downloadDir = mkdtempSync(join(tmpdir(), 'vela-media-'));
const browser = await launch({ port: 9367, url: PAGE_URL });
const exceptions = [];
const trackEx = (s) => s.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
const lastReq = () => mock.requests.at(-1);
const waitOnDisk = async (name) => {
  // 下载器登记与文件真正落盘之间有窗口：轮询磁盘最多 3s
  for (let i = 0; i < 15 && !readdirSync(downloadDir).includes(name); i++) await sleep(200);
  return readdirSync(downloadDir).includes(name);
};

try {
  // ---- 供应商预置：激活供应商指向 mock（openai 协议） ----
  const sw = await browser.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [
        { id: 'p-md', name: '媒体供应商', kind: 'openai', baseUrl: mock.url('md') + '/v1', apiKey: 'kmd', models: ['md-model'] },
      ],
      activeProviderId: 'p-md',
      agentBridge: { url: 'ws://127.0.0.1:39299', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' },
    },
    conversations: [],
  });
  sw.close();

  const pageT = (await browser.targets()).find((t) => t.type === 'page' && t.url === PAGE_URL);
  const page = await connect(pageT.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  trackEx(page);
  // 下载行为浏览器级设定一次（弹层 iframe 会话来来去去，落盘断言统一走本会话查）
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: false });
  // ✕ 收起弹层：遮罩移除后 Blink 会重发 mouseover，指针仍压在媒体上时钮按设计重新长出，
  // 所以收完必须把指针挪到空白处再断言「弹层与钮都收起」
  const closeHoverPop = async (sess) => {
    sess.evaluate(`document.querySelector('.om-media-close').click()`);
    await waitFor(() => page.evaluate(`!document.getElementById('om-media-pop')`), { timeout: 4000 });
    await page.mouse('mouseMoved', 640, 60); // 正文标题附近的空白（非媒体）
    return !!(await waitFor(() => page.evaluate(`!document.getElementById('om-media-pop') && !document.getElementById('om-media-hover')`), { timeout: 4000 }));
  };
  await waitFor(() => page.evaluate(`!!document.getElementById('om-widget-host')`));
  await waitFor(() => page.evaluate(`window.__omVidReady === true && document.getElementById('v1').videoWidth > 0`), { timeout: 15000 });

  // ---- 大面板入口已移除：浮窗动作列没有媒体钮，悬停是唯一入口 ----
  const acts = await page.evaluate(`[...document.getElementById('om-widget-host').shadowRoot.querySelectorAll('button[data-act]')].map((b) => b.dataset.act)`);
  check('浮窗动作列无媒体大面板钮（悬停为唯一入口）', !acts.includes('media'), acts);

  // ---- 悬停钮（Monica 式）：真鼠标移到图片上 → 右上角浮出操作钮 ----
  const rectOf = (expr) => page.evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  await page.evaluate(`document.getElementById('img-a').scrollIntoView({ block: 'center' })`);
  const rectA = await rectOf(`document.getElementById('img-a')`);
  await page.mouse('mouseMoved', rectA.x + rectA.width / 2, rectA.y + rectA.height / 2);
  check('悬停：图片上浮出操作钮（200ms 停留后）',
    !!(await waitFor(() => page.evaluate(`!!document.getElementById('om-media-hover')`), { timeout: 4000 })));
  // 稳定性：停留不动超过离开宽限（350ms）后钮仍在——消失就把 mouseover 时间线抖出来
  await sleep(700);
  const stillAlive = await page.evaluate(`!!document.getElementById('om-media-hover')`);
  check('悬停：停留期间钮稳定不闪', stillAlive, stillAlive ? '' : JSON.stringify(await page.evaluate(`window.__omHovers.slice(-12)`), null, 1));
  const btnA = await rectOf(`document.getElementById('om-media-hover')`);
  check('悬停：钮锚在图片右上角内',
    btnA.x >= rectA.x && btnA.x + btnA.width <= rectA.x + rectA.width + 2 && btnA.y >= rectA.y && btnA.y <= rectA.y + 40,
    JSON.stringify({ btnA, rectA }));

  // ---- 点钮 → 就地弹层（单媒体模式，复用媒体面板页） ----
  await page.click(btnA.x + 16, btnA.y + 16);
  const popT = await waitFor(
    () => (async () => {
      const t = (await browser.targets()).find((x) => x.url.includes('src/media/panel.html') && x.url.includes('mode=hover'));
      return t && (t.type === 'page' || t.type === 'iframe') ? t : null;
    })(),
    { timeout: 8000, interval: 300 },
  );
  if (!popT) throw new Error('悬停弹层 iframe 未出现');
  const pop = await connect(popT.webSocketDebuggerUrl);
  await pop.send('Runtime.enable');
  trackEx(pop);
  check('悬停弹层：单媒体 iframe 已打开', !!(await waitFor(() => pop.evaluate(`document.querySelectorAll('.om-media-card').length === 1`), { timeout: 8000 })));
  const hov = await pop.evaluate(`(() => ({
    src: document.querySelector('.om-media-card img')?.src,
    tabsHidden: getComputedStyle(document.getElementById('om-media-tab-img')).display === 'none' && getComputedStyle(document.getElementById('om-media-rescan')).display === 'none',
    otherPanesHidden: ['om-media-videos', 'om-media-embeds'].every((id) => getComputedStyle(document.getElementById(id)).display === 'none'),
    close: !!document.querySelector('.om-media-close'),
    title: document.getElementById('om-media-page').textContent,
  }))()`);
  check('悬停弹层：单图卡片 + 面板专属控件隐藏 + ✕ 收起钮',
    hov.src?.endsWith('/img/a.png') && hov.tabsHidden && hov.close, hov);
  check('悬停弹层：非本媒体类型的面板不显示（[hidden] 不被 grid/flex 压掉）', hov.otherPanesHidden, hov);
  check('悬停弹层：宿主带过页标题（进导图素材用）', hov.title.includes('媒体测试页'), hov.title);

  // ---- 弹层内就地分析（悬停路径的视觉附件管线） ----
  pop.evaluate(`document.querySelector('.om-media-card button[data-act="analyze"]').click()`);
  check('悬停弹层：就地分析出结果',
    !!(await waitFor(() => pop.evaluate(`document.querySelector('.om-media-card .om-media-res').textContent.includes('IMG-ANALYSIS-OK')`), { timeout: 10000 })));
  {
    const req = lastReq();
    const parts = req.raw.messages.at(-1).content;
    const b64 = (parts.find((p) => p.type === 'image_url')?.image_url?.url || '').split(',')[1] || '';
    const magic = Buffer.from(b64, 'base64').subarray(0, 8).toString('hex');
    check('图片分析：user 消息 = 文本 + image_url 附件（PNG 魔数）',
      Array.isArray(parts) && parts[0].type === 'text' && parts[0].text.includes('分析这张网页图片')
      && parts[1]?.type === 'image_url' && magic === '89504e470d0a1a0a', `${parts?.length} parts, magic=${magic}`);
    check('图片分析：prompt 带图注与来源', parts[0].text.includes('架构示意图') && parts[0].text.includes('/img/a.png'));
  }

  // ---- 进导图（热路径：已分析过的图直接复用分析结果，零额外调用） ----
  // 素材库 / 下载登记都在扩展上下文里查（弹层 iframe 是扩展页，宿主页没有 chrome.*）
  const inboxOf = (sess) => sess.evaluate(`chrome.storage.local.get('omMindmapInbox').then((o) => JSON.stringify(o.omMindmapInbox?.[${JSON.stringify(PAGE_URL)}] || null))`);
  pop.evaluate(`document.querySelector('.om-media-card button[data-act="mindmap"]').click()`);
  check('进导图（热）：复用分析结果入库提示',
    !!(await waitFor(() => pop.evaluate(`document.querySelector('.om-media-card .om-media-res').textContent.includes('已记入本页导图素材')`), { timeout: 12000 })));
  const inbox1 = JSON.parse(await inboxOf(pop));
  check('进导图（热）：【图片】素材带分析结论入库', inbox1?.items?.length === 1 && inbox1.items[0].text.startsWith('【图片】IMG-ANALYSIS-OK'),
    (inbox1?.items || []).map((i) => i.text.slice(0, 30)));
  check('进导图（热）：零 describe 调用', mock.requests.filter((r) => /一两句话概括/.test(r.messages.at(-1)?.text || '')).length === 0);

  // ---- 图片下载 ----
  pop.evaluate(`document.querySelector('.om-media-card button[data-act="download"]').click()`);
  check('图片下载：提示已开始',
    !!(await waitFor(() => pop.evaluate(`document.querySelector('.om-media-card .om-media-res').textContent.includes('已开始下载')`), { timeout: 8000 })));
  await waitFor(() => pop.evaluate(`chrome.downloads.search({}).then((ds) => ds.some((d) => d.filename.replace(/\\\\/g, '/').endsWith('/a.png')))`), { timeout: 8000 });
  check('图片下载：chrome.downloads 落盘 a.png', await waitOnDisk('a.png'), readdirSync(downloadDir));

  // ---- 视频悬停（弹层开着直接换目标：钮跟过去、弹层就地重载为单视频模式） ----
  const rectV = await rectOf(`document.getElementById('v1')`);
  await page.mouse('mouseMoved', rectV.x + rectV.width / 2, rectV.y + rectV.height / 2);
  const btnV = await rectOf(`document.getElementById('om-media-hover')`);
  const vRight = rectV.x + rectV.width; // rectOf 只回 {x,y,width,height}，没有 right/bottom
  check('悬停：视频元素同样浮出操作钮（钮已挪到视频右上角）',
    btnV.x >= vRight - 80 && btnV.x + btnV.width <= vRight + 2 && btnV.y >= rectV.y && btnV.y <= rectV.y + 40,
    JSON.stringify({ btnV, rectV }));
  await page.click(btnV.x + 16, btnV.y + 16);
  const pop2T = await waitFor(
    () => (async () => {
      const t = (await browser.targets()).find((x) => x.url.includes('src/media/panel.html') && x.url.includes('kind=vid'));
      return t && (t.type === 'page' || t.type === 'iframe') ? t : null;
    })(),
    { timeout: 8000, interval: 300 },
  );
  if (!pop2T) throw new Error('视频悬停弹层 iframe 未出现（换目标重载失败）');
  const pop2 = await connect(pop2T.webSocketDebuggerUrl);
  await pop2.send('Runtime.enable');
  trackEx(pop2);
  check('悬停弹层：换目标就地重载为单视频卡',
    !!(await waitFor(() => pop2.evaluate(`document.querySelectorAll('.om-media-vcard').length === 1`), { timeout: 8000 })));
  const vcard = await pop2.evaluate(`(() => ({
    tag: document.querySelector('.om-media-vcard .om-media-tag')?.textContent,
    dlDisabled: document.querySelector('.om-media-vcard button[data-act="download"]')?.disabled,
    imgPaneHidden: getComputedStyle(document.getElementById('om-media-images')).display === 'none',
    embedPaneHidden: getComputedStyle(document.getElementById('om-media-embeds')).display === 'none',
  }))()`);
  check('悬停弹层：单视频卡（流式禁下载）', vcard.tag === '流式' && vcard.dlDisabled === true, vcard);
  check('悬停弹层：视频卡上方不漏「没有识别到足够大的图片」空态（[hidden] 生效）',
    vcard.imgPaneHidden && vcard.embedPaneHidden, vcard);
  pop2.evaluate(`document.querySelector('.om-media-vcard button[data-act="analyze"]').click()`);
  const vidOk = await waitFor(() => pop2.evaluate(`document.querySelector('.om-media-vcard .om-media-res').textContent.includes('VID-FRAMES-OK')`), { timeout: 25000 });
  check('悬停弹层：视频按 src 定位截帧分析（不依赖面板列表下标）', !!vidOk,
    vidOk ? '' : String(await pop2.evaluate(`document.querySelector('.om-media-vcard .om-media-res').textContent`)));
  check('悬停弹层：关键帧仍走多图视觉附件（≥3 帧）',
    lastReq().raw.messages.at(-1).content.filter((p) => p.type === 'image_url').length >= 3);

  // ---- ✕ 收起：面板页通知宿主撤弹层，指针挪开后钮同收 ----
  check('悬停弹层：✕ 通知宿主收起弹层与钮', await closeHoverPop(pop2));

  // ---- 弹层外点击收起（重开一次图弹层，点弹层之外的空白处） ----
  await page.mouse('mouseMoved', rectA.x + rectA.width / 2, rectA.y + rectA.height / 2);
  await waitFor(() => page.evaluate(`!!document.getElementById('om-media-hover')`), { timeout: 4000 });
  const btnA2 = await rectOf(`document.getElementById('om-media-hover')`);
  await page.click(btnA2.x + 16, btnA2.y + 16);
  check('悬停弹层：重开图弹层',
    !!(await waitFor(() => page.evaluate(`!!document.getElementById('om-media-pop')`), { timeout: 8000 })));
  await page.click(640, 690);
  check('悬停弹层：弹层外点击收起（连钮一起收）',
    !!(await waitFor(() => page.evaluate(`!document.getElementById('om-media-pop') && !document.getElementById('om-media-hover')`), { timeout: 4000 })));

  // ---- data URL 图（canvas 生成）：进导图冷路径 + 提取 ----
  const rectD = await page.evaluate(`(() => { const i = document.getElementById('img-data'); i.scrollIntoView({ block: 'center' }); const r = i.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  await page.mouse('mouseMoved', rectD.x + rectD.width / 2, rectD.y + rectD.height / 2);
  await waitFor(() => page.evaluate(`!!document.getElementById('om-media-hover')`), { timeout: 4000 });
  const btnD = await rectOf(`document.getElementById('om-media-hover')`);
  await page.click(btnD.x + 16, btnD.y + 16);
  const pop3T = await waitFor(
    () => (async () => {
      // data URL 图的 src 参数就是 data%3Aimage 编码后的数据地址，不含元素 id
      const t = (await browser.targets()).find((x) => x.url.includes('src/media/panel.html') && x.url.includes('mode=hover') && x.url.includes('data%3Aimage'));
      return t && (t.type === 'page' || t.type === 'iframe') ? t : null;
    })(),
    { timeout: 8000, interval: 300 },
  );
  if (!pop3T) throw new Error('data URL 图悬停弹层 iframe 未出现');
  const pop3 = await connect(pop3T.webSocketDebuggerUrl);
  await pop3.send('Runtime.enable');
  trackEx(pop3);
  check('悬停弹层：data URL 图单卡打开', !!(await waitFor(() => pop3.evaluate(`document.querySelectorAll('.om-media-card').length === 1`), { timeout: 8000 })));
  pop3.evaluate(`document.querySelector('.om-media-card button[data-act="mindmap"]').click()`);
  check('进导图（冷）：先跑一句话概括再入库提示',
    !!(await waitFor(() => pop3.evaluate(`document.querySelector('.om-media-card .om-media-res').textContent.includes('已记入本页导图素材')`), { timeout: 12000 })));
  const inbox2 = JSON.parse(await inboxOf(pop3));
  check('进导图（冷）：【图片】素材带 describe 结论入库（共 2 段）',
    inbox2?.items?.length === 2 && inbox2.items[1].text.startsWith('【图片】DESC-COLD'),
    (inbox2?.items || []).map((i) => i.text.slice(0, 30)));
  check('进导图（冷）：恰一次 describe 调用', mock.requests.filter((r) => /一两句话概括/.test(r.messages.at(-1)?.text || '')).length === 1);
  pop3.evaluate(`document.querySelector('.om-media-card button[data-act="extract"]').click()`);
  check('图片提取：data URL 图走视觉提取',
    !!(await waitFor(() => pop3.evaluate(`document.querySelector('.om-media-card .om-media-res').textContent.includes('IMG-EXTRACT-OK')`), { timeout: 10000 })));
  check('图片提取：请求带 image_url 视觉附件',
    lastReq().raw.messages.at(-1).content.some((p) => p.type === 'image_url'));

  // ---- 直连视频（v2 /v.mp4）：单视频卡 + 下载可用 ----
  // img-data 的弹层会向上翻、整层盖住 v2：先 ✕ 收起再悬停（「弹层开着换目标就地重载」v1 段已覆盖）
  check('悬停弹层：✕ 收起 img-data 弹层', await closeHoverPop(pop3));
  const rectV2 = await page.evaluate(`(() => { const v = document.getElementById('v2'); v.scrollIntoView({ block: 'center' }); const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  await page.mouse('mouseMoved', rectV2.x + rectV2.width / 2, rectV2.y + rectV2.height / 2);
  await waitFor(() => page.evaluate(`!!document.getElementById('om-media-hover')`), { timeout: 4000 });
  const rectBtn2 = await rectOf(`document.getElementById('om-media-hover')`);
  const v2Right = rectV2.x + rectV2.width;
  check('悬停：直连视频也浮出操作钮（锚在视频右上角）',
    rectBtn2.x >= v2Right - 80 && rectBtn2.x + rectBtn2.width <= v2Right + 2 && rectBtn2.y >= rectV2.y && rectBtn2.y <= rectV2.y + 40,
    JSON.stringify({ rectBtn2, rectV2 }));
  await page.click(rectBtn2.x + 16, rectBtn2.y + 16);
  const pop4T = await waitFor(
    () => (async () => {
      const t = (await browser.targets()).find((x) => x.url.includes('src/media/panel.html') && x.url.includes('kind=vid') && x.url.includes('v.mp4'));
      return t && (t.type === 'page' || t.type === 'iframe') ? t : null;
    })(),
    { timeout: 8000, interval: 300 },
  );
  if (!pop4T) throw new Error('直连视频悬停弹层 iframe 未出现');
  const pop4 = await connect(pop4T.webSocketDebuggerUrl);
  await pop4.send('Runtime.enable');
  trackEx(pop4);
  check('悬停弹层：打开直连视频单卡', !!(await waitFor(() => pop4.evaluate(`document.querySelectorAll('.om-media-vcard').length === 1`), { timeout: 8000 })));
  const vcard2 = await pop4.evaluate(`(() => ({
    tag: document.querySelector('.om-media-vcard .om-media-tag')?.textContent,
    dlDisabled: document.querySelector('.om-media-vcard button[data-act="download"]')?.disabled,
  }))()`);
  check('悬停弹层：直连视频可下载', vcard2.tag === '直连文件' && vcard2.dlDisabled === false, vcard2);
  pop4.evaluate(`document.querySelector('.om-media-vcard button[data-act="download"]').click()`);
  await waitFor(() => pop4.evaluate(`chrome.downloads.search({}).then((ds) => ds.some((d) => d.filename.replace(/\\\\/g, '/').endsWith('/v.mp4')))`), { timeout: 8000 });
  check('视频下载：直连文件落盘 v.mp4', await waitOnDisk('v.mp4'), readdirSync(downloadDir));
  check('悬停弹层：✕ 收起直连视频弹层', await closeHoverPop(pop4));

  // ---- 真 MSE 流（v3）：bilibili 同形态 —— src 精确定位 + 等新帧上屏后截帧 ----
  await waitFor(() => page.evaluate(`window.__omMseReady === true && document.getElementById('v3').videoWidth > 0`), { timeout: 15000 });
  // 先撤走 v1：页面只剩解不出画面的 v2（假 mp4）与 v3——分析若成功，只可能精确命中 v3
  page.evaluate(`document.getElementById('v1').remove()`);
  const rectV3 = await page.evaluate(`(() => { const v = document.getElementById('v3'); v.scrollIntoView({ block: 'center' }); const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  await page.mouse('mouseMoved', rectV3.x + rectV3.width / 2, rectV3.y + rectV3.height / 2);
  await waitFor(() => page.evaluate(`!!document.getElementById('om-media-hover')`), { timeout: 4000 });
  const btnV3 = await rectOf(`document.getElementById('om-media-hover')`);
  await page.click(btnV3.x + 16, btnV3.y + 16);
  const pop5T = await waitFor(
    () => (async () => {
      // v3 的 src 是页内动态 blob:（MediaSource 专属），target 按排除法认：kind=vid 且不是 v.mp4
      const t = (await browser.targets()).find((x) => x.url.includes('src/media/panel.html') && x.url.includes('kind=vid') && !x.url.includes('v.mp4'));
      return t && (t.type === 'page' || t.type === 'iframe') ? t : null;
    })(),
    { timeout: 8000, interval: 300 },
  );
  if (!pop5T) throw new Error('MSE 视频悬停弹层 iframe 未出现');
  const pop5 = await connect(pop5T.webSocketDebuggerUrl);
  await pop5.send('Runtime.enable');
  trackEx(pop5);
  check('悬停弹层：MSE 视频单卡打开（流式禁下载、不漏空态）',
    !!(await waitFor(() => pop5.evaluate(`document.querySelectorAll('.om-media-vcard').length === 1`), { timeout: 8000 })));
  const vcard3 = await pop5.evaluate(`(() => ({
    tag: document.querySelector('.om-media-vcard .om-media-tag')?.textContent,
    dlDisabled: document.querySelector('.om-media-vcard button[data-act="download"]')?.disabled,
    imgPaneHidden: getComputedStyle(document.getElementById('om-media-images')).display === 'none',
  }))()`);
  check('悬停弹层：MSE 视频卡（流式禁下载）', vcard3.tag === '流式' && vcard3.dlDisabled === true && vcard3.imgPaneHidden, vcard3);
  pop5.evaluate(`document.querySelector('.om-media-vcard button[data-act="analyze"]').click()`);
  const mseOk = await waitFor(() => pop5.evaluate(`document.querySelector('.om-media-vcard .om-media-res').textContent.includes('VID-FRAMES-OK')`), { timeout: 25000 });
  check('悬停弹层：MSE 流按 src 精确命中截帧分析（等新帧上屏）', !!mseOk,
    mseOk ? '' : String(await pop5.evaluate(`document.querySelector('.om-media-vcard .om-media-res').textContent`)));
  check('悬停弹层：MSE 帧走多图视觉附件（≥3 帧）',
    lastReq().raw.messages.at(-1).content.filter((p) => p.type === 'image_url').length >= 3);
  // 目标被站点移除后的诚实报错：src 匹配不到就明说，不退回首支视频截无关画面。
  // 上一条的 waitFor 可能匹配到流式中途的部分文本：panel 忙态（panel.js state.busy）
  // 会静默吞掉新点击，必须先等本轮收尾（完成后 res 区才追加「复制」按钮）
  await waitFor(() => pop5.evaluate(`(document.querySelector('.om-media-vcard .om-media-res')?.textContent || '').includes('复制')`), { timeout: 10000 });
  await page.evaluate(`document.getElementById('v3').remove()`); // await：确保 DOM 落地后再发提取点击
  await pop5.evaluate(`document.querySelector('.om-media-vcard button[data-act="extract"]').click()`);
  check('悬停弹层：目标视频被移除后明确报错（不悄悄截别的视频）',
    !!(await waitFor(() => pop5.evaluate(`document.querySelector('.om-media-vcard .om-media-res').textContent.includes('目标视频已不在页面上')`), { timeout: 10000 })),
    String(await pop5.evaluate(`document.querySelector('.om-media-vcard .om-media-res')?.textContent || '(空)'`)).slice(0, 120));
  check('悬停弹层：✕ 收起 MSE 弹层', await closeHoverPop(pop5));

  // ---- 小图标（20×20）不弹钮 ----
  await page.evaluate(`document.getElementById('img-tiny').scrollIntoView({ block: 'center' })`);
  const rectT = await rectOf(`document.getElementById('img-tiny')`);
  await page.mouse('mouseMoved', rectT.x + 10, rectT.y + 10);
  await sleep(700);
  check('悬停：小图标（20×20）不弹钮', await page.evaluate(`!document.getElementById('om-media-hover')`));

  check('全程无未捕获异常', exceptions.length === 0, exceptions);
} catch (e) {
  check('执行异常', false, e?.stack || e?.message || String(e));
} finally {
  await browser.close();
  await mock.close();
  web.close();
  rmSync(downloadDir, { recursive: true, force: true });
}
summary();
