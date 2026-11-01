// 网页媒体面板（Monica 式）：浮窗「媒体」钮打开的扩展页 iframe。
// DOM 扫描 / 视频截帧在宿主页内容脚本（widget.js）里做，本页只负责呈现与 LLM 编排：
// host_permissions 让本页可直接 fetch 跨域图片字节；流式视觉调用在扩展页上下文（MV3：不进 SW）。
// 协议（postMessage，与宿主 widget 对接，来源必须 window.parent）：
//   om:media-scan-req → om:media-scan{url,title,images,videos,embeds}
//   om:media-img-req{src,idx} → om:media-img{ok,dataUrl|error}（blob: 图片经宿主 canvas 转码）
//   om:media-frames-req{src,idx,count} → om:media-frames{ok,frames|error}（宿主 seek 截帧）
//   om:media-close ←（悬停弹层 ✕）请宿主收起弹层
// 悬停弹层（单媒体模式）：widget.js 悬停钮带 ?mode=hover&kind=img|vid&src=… 打开本页，
// 只呈现这一个元素（无扫描 / 页签），页面 url 与标题随 query 带入（进导图素材入库要用）。
import { streamChat } from '../llm/store.js';
import { buildImagePrompt, buildVideoFramesPrompt } from '../llm/tasks.js';

const $ = (id) => document.getElementById(id);
const panes = { img: $('om-media-images'), vid: $('om-media-videos'), embed: $('om-media-embeds') };
const state = {
  page: { url: '', title: '', images: [], videos: [], embeds: [] },
  tab: 'img',
  busy: new Set(),          // `${kind}:${idx}:${mode}` 进行中
  visCache: new Map(),      // `${kind}:${idx}:${mode}` → 文本（分析/提取结果复用给进导图）
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setStatus = (text, isErr = false) => {
  let st = document.getElementById('om-media-status');
  if (!st) {
    st = document.createElement('span');
    st.id = 'om-media-status';
    st.className = 'om-media-status';
    $('om-media-page').after(st);
  }
  st.textContent = text ? ` · ${text}` : '';
  st.classList.toggle('om-media-err', isErr);
};

// ---------- 与宿主 widget 的 postMessage 往返 ----------
const hostCall = (out, inType, { timeout = 8000 } = {}) => new Promise((resolve) => {
  const onMsg = (ev) => {
    if (ev.source !== window.parent || ev.data?.type !== inType) return;
    window.removeEventListener('message', onMsg);
    clearTimeout(timer);
    resolve(ev.data);
  };
  const timer = setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, timeout);
  window.addEventListener('message', onMsg);
  window.parent.postMessage(out, '*');
});

function requestScan() {
  setStatus('扫描中…');
  hostCall({ type: 'om:media-scan-req' }, 'om:media-scan', { timeout: 4000 }).then((d) => {
    if (!d || !Array.isArray(d.images)) {
      setStatus('未能读取本页媒体（刷新页面后重试）', true);
      return;
    }
    state.page = { url: String(d.url || ''), title: String(d.title || ''), images: d.images, videos: d.videos || [], embeds: d.embeds || [] };
    $('om-media-page').textContent = state.page.title;
    setStatus(`图片 ${state.page.images.length} · 视频 ${state.page.videos.length} · 嵌入 ${state.page.embeds.length}`);
    render();
  });
}

// ---------- 图片 → 视觉附件（取字节 → 必要时降采样） ----------
const IMG_MAX_EDGE = 1568;   // 视觉模型的常规安全边长，超出先降采样省 token
const IMG_RAW_MAX = 3.5 * 1024 * 1024;

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('读取图片数据失败'));
    fr.readAsDataURL(blob);
  });
}

async function rasterizeSvg(blob) {
  // ImageBitmap 解不了 SVG：Image + objectURL 走 canvas（同源 data 不污染画布）
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('SVG 无法解码'));
      el.src = url;
    });
    const c = new OffscreenCanvas(img.naturalWidth || 300, img.naturalHeight || 150);
    c.getContext('2d').drawImage(img, 0, 0);
    return await c.convertToBlob({ type: 'image/png' });
  } finally { URL.revokeObjectURL(url); }
}

async function downscale(blob) {
  let src = blob;
  if ((blob.type || '').includes('svg')) src = await rasterizeSvg(blob);
  const type = src.type || 'image/png';
  if (/^image\/(png|jpeg|webp)$/.test(type) && src.size <= IMG_RAW_MAX) {
    return { mime: type, data: await blobToB64(src) };
  }
  const bmp = await createImageBitmap(src); // gif 只取首帧
  const scale = Math.min(1, IMG_MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(2, Math.round(bmp.width * scale));
  const h = Math.max(2, Math.round(bmp.height * scale));
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const out = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return { mime: 'image/jpeg', data: await blobToB64(out) };
}

// 取一张页面图片作附件：blob: 的字节在页面源里，宿主 canvas 转成 dataUrl 再取
async function imageAttachment(item, idx) {
  let url = item.src;
  if (url.startsWith('blob:')) {
    const d = await hostCall({ type: 'om:media-img-req', src: url, idx }, 'om:media-img');
    if (!d?.ok || !String(d.dataUrl || '').startsWith('data:')) {
      throw new Error(d?.error || '该图片受跨域保护，无法读取内容');
    }
    url = d.dataUrl;
  }
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('图片读取失败（网络或跨域限制）');
  }
  if (!res.ok) throw new Error(`图片读取失败：HTTP ${res.status}`);
  return downscale(await res.blob());
}

// ---------- LLM 编排（流式渲染到卡片结果区） ----------
async function runVision(cardEl, { key, prompt, attachments, mode }) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  const res = cardEl.querySelector('.om-media-res');
  res.hidden = false;
  res.classList.remove('om-media-err');
  res.textContent = '分析中…';
  let text = '';
  let failed = null;
  await streamChat({
    messages: [{ role: 'user', content: prompt, attachments }],
    onDelta: (d) => {
      if (d.error) { failed = d.error; return; }
      if (d.text) { text += d.text; res.textContent = text; res.scrollTop = res.scrollHeight; }
    },
  });
  state.busy.delete(key);
  if (failed) {
    res.classList.add('om-media-err');
    res.textContent = failed.message || '调用失败';
    return null;
  }
  if (text.trim()) state.visCache.set(key, text.trim());
  addCopyBtn(res, text);
  return text;
}

function addCopyBtn(res, text) {
  if (!text.trim() || res.querySelector('.om-media-copy')) return;
  const btn = document.createElement('button');
  btn.className = 'om-media-copy';
  btn.textContent = '复制';
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1200); } catch { btn.textContent = '复制失败'; }
  });
  res.appendChild(document.createElement('br'));
  res.appendChild(btn);
}

// 图片：分析 / 提取 / 进导图 / 下载
async function onImageAct(card, item, idx, mode) {
  const key = `img:${idx}:${mode}`;
  if (mode === 'mindmap') return addToMindmap(card, item, idx, key);
  const cached = state.visCache.get(key);
  if (cached) {
    const res = card.querySelector('.om-media-res');
    res.hidden = false; res.classList.remove('om-media-err'); res.textContent = cached;
    addCopyBtn(res, cached);
    return;
  }
  let att;
  try {
    att = await imageAttachment(item, idx);
  } catch (e) {
    const res = card.querySelector('.om-media-res');
    res.hidden = false; res.classList.add('om-media-err'); res.textContent = e.message;
    return;
  }
  await runVision(card, {
    key,
    prompt: buildImagePrompt({ mode, alt: item.alt, src: item.src }),
    attachments: [att],
    mode,
  });
}

// 进思维导图：有缓存描述直接用，否则先跑一次「一句话概括」再入素材库
//（素材是纯文本：描述入库名为【图片】前缀，生成导图时按普通片段参与归纳）
async function addToMindmap(card, item, idx, imgKey) {
  const res = card.querySelector('.om-media-res');
  const hint = (t, err) => { res.hidden = false; res.classList.toggle('om-media-err', !!err); res.textContent = t; };
  if (state.busy.has(imgKey)) { hint('正在分析这张图片，稍候…'); return; }
  let desc = state.visCache.get(`img:${idx}:describe`) || state.visCache.get(`img:${idx}:analyze`);
  if (!desc) {
    try {
      const att = await imageAttachment(item, idx);
      desc = await runVision(card, {
        key: `img:${idx}:describe`,
        prompt: buildImagePrompt({ mode: 'describe', alt: item.alt, src: item.src }),
        attachments: [att],
        mode: 'describe',
      });
    } catch (e) { hint(e.message || '读取图片失败', true); return; }
  }
  if (!desc) return; // runVision 已把错误写进结果区
  const text = `【图片】${desc}`.slice(0, 2000);
  chrome.runtime.sendMessage(
    { type: 'om:mindmap-collect', op: 'add', texts: [text], title: state.page.title, url: state.page.url },
    (r) => {
      void chrome.runtime.lastError;
      if (r?.ok) hint(`已记入本页导图素材 · 共 ${r.count} 段（工具条「思维导图」查看）`);
      else hint('记入素材库失败，请重试', true);
    },
  );
}

// 视频：宿主截关键帧 → 整包视觉分析
async function onVideoAct(card, item, idx, mode) {
  const key = `vid:${idx}:${mode}`;
  if (state.busy.has(key)) return;
  const cached = state.visCache.get(key);
  if (cached) {
    const res = card.querySelector('.om-media-res');
    res.hidden = false; res.classList.remove('om-media-err'); res.textContent = cached;
    addCopyBtn(res, cached);
    return;
  }
  const res = card.querySelector('.om-media-res');
  res.hidden = false; res.classList.remove('om-media-err');
  res.textContent = '正在抽取视频关键帧…';
  const d = await hostCall({ type: 'om:media-frames-req', src: item.src, idx, count: 4 }, 'om:media-frames', { timeout: 20000 });
  if (!d?.ok || !Array.isArray(d.frames) || !d.frames.length) {
    res.classList.add('om-media-err');
    res.textContent = d?.error || '视频截帧失败';
    return;
  }
  const attachments = d.frames.map((f) => {
    const m = String(f.dataUrl).match(/^data:(image\/[a-z+]+);base64,(.*)$/);
    return { kind: 'image', mime: m?.[1] || 'image/jpeg', data: m?.[2] || '', t: f.t };
  });
  const note = item.duration ? `时长约 ${Math.round(item.duration)} 秒` : '时长未知';
  await runVision(card, {
    key,
    prompt: buildVideoFramesPrompt({ mode, count: attachments.length, note }),
    attachments,
    mode,
  });
}

// ---------- 下载（chrome.downloads；不 fetch 原件，URL 直接交给下载器流式落盘） ----------
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm' };

function fileNameOf(src, mime) {
  let base = '';
  try { base = decodeURIComponent(new URL(src, 'https://x.invalid/').pathname.split('/').pop() || ''); } catch { /* data: / blob: 无路径 */ }
  base = base.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  const ext = (base.match(/\.([a-z0-9]{2,5})$/i)?.[1] || EXT_BY_MIME[mime] || 'bin').toLowerCase();
  return `${(base.replace(/\.[a-z0-9]{2,5}$/i, '') || 'vela-media')}.${ext}`;
}

async function downloadMedia(card, item, idx, kind) {
  const res = card.querySelector('.om-media-res');
  const hint = (t, err) => { res.hidden = false; res.classList.toggle('om-media-err', !!err); res.textContent = t; };
  let url = item.src;
  if (kind === 'img' && url.startsWith('blob:')) {
    // blob: 的字节在页面源里，宿主 canvas 转成 data: 再交（objectURL 交给下载器会丢指定文件名）
    const d = await hostCall({ type: 'om:media-img-req', src: url, idx }, 'om:media-img');
    if (!d?.ok) { hint(d?.error || '该图片受跨域保护，无法下载', true); return; }
    url = d.dataUrl;
  } else if (kind !== 'img' && item.kind !== 'direct') {
    hint('流式 / 嵌入视频没有独立文件地址，无法直接下载', true);
    return;
  }
  const name = fileNameOf(item.src, kind === 'img' ? '' : (item.mime || ''));
  chrome.downloads.download({ url, filename: name, saveAs: false }, (id) => {
    const err = chrome.runtime.lastError;
    if (err || id == null) { hint(`下载失败：${err?.message || '未知错误'}`, true); return; }
    hint(`已开始下载：${name}`);
  });
}

// ---------- 渲染 ----------
function imgOriginTag(src) {
  if (src.startsWith('data:')) return 'data';
  if (src.startsWith('blob:')) return 'blob';
  try { return new URL(src).host; } catch { return ''; }
}

function render() {
  // 图片网格
  panes.img.innerHTML = '';
  if (!state.page.images.length) {
    panes.img.innerHTML = '<div class="om-media-empty">本页没有识别到足够大的图片（小图标已过滤）</div>';
  }
  state.page.images.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'om-media-card';
    card.dataset.idx = String(idx);
    card.innerHTML = `
      <div class="om-media-thumb" title="点击放大"><img src="${esc(item.src)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>
      <div class="om-media-meta"><span>${item.w}×${item.h}</span><span class="om-media-tag">${esc(imgOriginTag(item.src))}</span></div>
      <div class="om-media-acts">
        <button class="om-media-run" data-act="analyze">分析</button>
        <button data-act="extract">提取</button>
        <button data-act="mindmap" title="图片要点作为素材记入本页思维导图">进导图</button>
        <button data-act="download">下载</button>
      </div>
      <div class="om-media-res" hidden></div>`;
    card.querySelector('.om-media-thumb').addEventListener('click', () => window.open(item.src, '_blank'));
    card.querySelector('.om-media-acts').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'download') downloadMedia(card, item, idx, 'img');
      else onImageAct(card, item, idx, act);
    });
    panes.img.appendChild(card);
  });

  // 视频列表
  panes.vid.innerHTML = '';
  if (!state.page.videos.length) {
    panes.vid.innerHTML = '<div class="om-media-empty">本页没有识别到视频元素</div>';
  }
  state.page.videos.forEach((item, idx) => {
    const kindText = item.kind === 'direct' ? '直连文件' : item.kind === 'stream' ? '流式' : '其他';
    const card = document.createElement('div');
    card.className = 'om-media-vcard';
    card.dataset.idx = String(idx);
    card.innerHTML = `
      <div class="om-media-vhead">
        <span class="om-media-vicon">▶</span>
        <span>${item.duration ? `${Math.floor(item.duration / 60)}分${Math.round(item.duration % 60)}秒` : '时长未知'}${item.w ? ` · ${item.w}×${item.h}` : ''} · <span class="om-media-tag">${kindText}</span></span>
        <span class="om-media-vsrc" title="${esc(item.src)}">${esc(item.src || '(无地址)')}</span>
      </div>
      <div class="om-media-acts">
        <button class="om-media-run" data-act="analyze" title="按时间轴抽取关键帧交给视觉模型分析">分析</button>
        <button data-act="extract" title="逐帧提取画面中出现的文字">提取</button>
        <button data-act="download" ${item.kind === 'direct' ? '' : 'disabled title="流式 / 嵌入视频没有独立文件地址"'}>下载</button>
      </div>
      <div class="om-media-res" hidden></div>`;
    card.querySelector('.om-media-acts').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      if (act === 'download') downloadMedia(card, item, idx, 'vid');
      else onVideoAct(card, item, idx, act);
    });
    panes.vid.appendChild(card);
  });

  // 嵌入播放器（跨域 iframe 进不去，只能列出与跳转）
  panes.embed.innerHTML = '';
  if (!state.page.embeds.length) {
    panes.embed.innerHTML = '<div class="om-media-empty">本页没有识别到嵌入式视频播放器</div>';
  }
  state.page.embeds.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'om-media-erow';
    row.innerHTML = `
      <span>▶ 嵌入播放器</span>
      <span class="om-media-enote" title="${esc(e.src)}">${esc(e.src)}</span>
      <a href="${esc(e.src)}" target="_blank" rel="noreferrer">打开</a>`;
    panes.embed.appendChild(row);
  });
}

// ---------- 顶部 tab / 重扫 ----------
const TABS = [['img', 'om-media-tab-img'], ['vid', 'om-media-tab-vid'], ['embed', 'om-media-tab-embed']];
for (const [tab, id] of TABS) {
  $(id).addEventListener('click', () => {
    state.tab = tab;
    for (const [, btnId] of TABS) $(btnId).classList.toggle('on', btnId === id);
    for (const [k, pane] of Object.entries(panes)) pane.hidden = k !== tab;
  });
}
$('om-media-rescan').addEventListener('click', requestScan);

// ---------- 单媒体模式（图片 / 视频悬停弹层）：?mode=hover&kind=img|vid&src=… ----------
// 宿主 widget.js 悬停钮点开的小弹层复用本页：不扫描整页，只呈现这一个元素；
// 页面 url / 标题由 widget 随 query 带上（进导图素材入库要用）。
const qs = new URLSearchParams(location.search);
if (qs.get('mode') === 'hover') {
  const kind = qs.get('kind') === 'vid' ? 'vid' : 'img';
  const src = String(qs.get('src') || '');
  const item = { src, w: Number(qs.get('w')) || 0, h: Number(qs.get('h')) || 0, alt: String(qs.get('alt') || '') };
  const vk = qs.get('vk');
  state.page = {
    url: String(qs.get('url') || ''),
    title: String(qs.get('title') || ''),
    images: kind === 'img' ? [item] : [],
    videos: kind === 'vid' ? [{ src, kind: vk === 'direct' ? 'direct' : vk === 'other' ? 'other' : 'stream', duration: Number(qs.get('dur')) || 0, w: item.w, h: item.h }] : [],
    embeds: [],
  };
  document.body.classList.add('om-media-hover');
  $('om-media-page').textContent = state.page.title || '本页媒体';
  // 收起钮：通知宿主关掉弹层（宿主来源白名单只认弹层窗口）
  const closeBtn = document.createElement('button');
  closeBtn.className = 'om-media-close';
  closeBtn.title = '收起';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => window.parent.postMessage({ type: 'om:media-close' }, '*'));
  $('om-media-page').after(closeBtn);
  render();
  $(kind === 'vid' ? 'om-media-tab-vid' : 'om-media-tab-img').click();
} else {
  requestScan();
}
