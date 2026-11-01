// 页面常驻浮窗（Monica 式）：深色圆形动作钮列 + 品牌紫胶囊。
// 经 chrome.scripting.registerContentScripts 注册进 http(s) 页面（ISOLATED world，经典 IIFE，禁 import）。
// 动作不直接跑 LLM：总结 / 解释 sendMessage 交 SW 写 pendingTask，聊天卡由本浮窗打开并消费任务
//（右键菜单动作、工具栏图标 / Ctrl+M 也走此管线：SW 发 om:open-card / om:toggle-card 通知本浮窗）；
// 翻译就地启动隐藏 runner；导图与媒体各有专属入口（SW 开查看页 / 悬停钮就地弹层）。
(() => {
  'use strict';
  if (window.__omWidget) {
    // 扩展重载后旧脚本上下文失效：浮窗残留在页面上但收不到任何消息
    //（后台 om:open-card 无人应答、sendMessage 抛错）。检测失效后摘掉旧宿主与
    // 本页残留的聊天卡/翻译 runner 重铺新版，后台补注（executeScript）才能生效。
    // 判活：失效上下文里 chrome.runtime.id 是 undefined 而不是抛错（旧版 try/catch 永远判活，
    // 补注直接 return，旧浮窗一直残留）；隔离世界复用时 chrome.runtime 也可能换成新对象，
    // 旧实例记下的 runtime 引用对不上同样视为失效
    let alive = false;
    try { alive = !!chrome.runtime?.id && window.__omWidget.rt === chrome.runtime; } catch { /* 上下文已失效 */ }
    if (alive) return;
    window.__omWidget.host?.remove();
    document.getElementById('om-card-host')?.remove();
    document.getElementById('om-media-host')?.remove();
    document.getElementById('om-media-hover')?.remove();
    document.getElementById('om-media-pop')?.remove();
    document.getElementById('om-tx-runner-host')?.remove();
    window.__omWidget = null;
  }

  const HOST_ID = 'om-widget-host';

  // 与 shell.js ICONS 同风格的原创线性图标
  const ICONS = {
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    translate: '<path d="M3 5h9M7.5 5c0 4.5-2 8.5-4.5 10.5M4.5 9.5c1.6 3 4 5.2 7 6"/><path d="M12.5 19.5l4-10 4 10M14 16.5h5"/>',
    explain: '<path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z"/><path d="M18.5 3.5v3M17 5h3"/>',
    // 船帆 logo：与 src/ui/brand.js 同一组路径（内容脚本禁 import，手抄；改那里要同步改这里）
    logo: '<path d="M11.2 3.2 C15.6 6.6 18.3 11 18.8 15.8 L11.2 15.8 Z" fill="currentColor" stroke="none"/><path d="M9.6 6.4 L9.6 15.8 L4.4 15.8 C5.6 12.2 7.3 9 9.6 6.4 Z" fill="currentColor" stroke="none"/><path d="M3.4 17.4 L20.6 17.4 C19.7 19.7 17.7 21 15.3 21 L8.7 21 C6.3 21 4.3 19.7 3.4 17.4 Z" fill="currentColor" stroke="none"/><path d="M19.6 1.6 L20.15 3.35 L21.9 3.9 L20.15 4.45 L19.6 6.2 L19.05 4.45 L17.3 3.9 L19.05 3.35 Z" fill="currentColor" stroke="none"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    media: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 15.5l-4.5-4.5-6 6L7 13.5l-4 4"/>',
    // 思维导图：中心节点分三支
    mind: '<circle cx="5" cy="12" r="2.1"/><circle cx="17" cy="6" r="2.1"/><circle cx="17" cy="12" r="2.1"/><circle cx="17" cy="18" r="2.1"/><path d="M7.1 12h2.4M9.5 6v12M9.5 6h5.4M9.5 12h5.4M9.5 18h5.4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  };

  function svg(name, size) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('width', size);
    el.setAttribute('height', size);
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', 'currentColor');
    el.setAttribute('stroke-width', '1.8');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.innerHTML = ICONS[name];
    return el;
  }

  // 扩展重载后旧页面的运行时已失效：sendMessage 会同步抛错或永不回调，
  // 统一按「无响应」在 2.5s 内落定，让上层给出可见提示而不是无声失败。
  function send(msg, onRes) {
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; onRes?.(res); } };
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError; // SW 不可达时按无响应处理
        done(res);
      });
    } catch { done(undefined); }
    setTimeout(() => done(undefined), 2500);
  }

  // ---------- 本地提示（Shadow 内小 toast） ----------
  let hintTimer = 0;
  function hint(root, text) {
    const el = root.querySelector('.om-w-hint');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------- 跨 world 翻译残留（扩展重载后旧 bridge 不可达） ----------
  // CustomEvent 和 window 属性都不过 isolated world：旧 world 铺的译文新代码看不见、
  // 管不着。原文快照由 bridge 收录时写进 data-om-tx-orig，可纯 DOM 还原。
  function txStale() {
    return !window.__omTxBridge?.isActive?.() && !!document.querySelector('[data-om-tx]');
  }
  function domRestoreTx() {
    document.getElementById('om-tx-ball-host')?.remove(); // 旧 world 卡死的浮球一并清掉
    document.querySelectorAll('.om-tx-dst').forEach((n) => n.remove());
    document.querySelectorAll('[data-om-tx]').forEach((n) => {
      const orig = n.getAttribute('data-om-tx-orig');
      if (orig != null && n.innerHTML !== orig) n.innerHTML = orig;
      n.removeAttribute('data-om-tx');
      n.removeAttribute('data-om-tx-orig');
      n.classList.remove('om-tx-wait', 'om-tx-failed');
    });
  }

  // ---------- 页内聊天卡（Monica 式可开关浮窗） ----------
  // Chrome 原生侧边栏没有关闭 API，胶囊无法做成开关；页内 iframe 卡片不受此限。
  // iframe 指向扩展的 sidepanel 页：web_accessible_resources 放行文档本身，
  // 页内其自有 css/js 属扩展源内加载，无需逐个放行。
  const CARD_ID = 'om-card-host';
  // 聊天卡宽度表达式与浮窗列让位偏移共用：窄视口时压缩，给浮窗列留位
  const CARD_WIDTH = 'min(420px, calc(100vw - 104px))';
  let pillEl = null;

  function chatCardOpen() {
    return document.getElementById(CARD_ID) !== null;
  }

  // 卡片贴右满高打开时浮窗列左移让位，收卡后回到右缘
  function syncWidgetOffset() {
    const host = window.__omWidget?.host;
    if (!host) return;
    host.style.right = document.getElementById(CARD_ID) ? `calc(${CARD_WIDTH} + 12px)` : '10px';
  }

  function closeChatCard() {
    document.getElementById(CARD_ID)?.remove();
    pillEl?.classList.remove('on');
    syncWidgetOffset();
  }

  function openChatCard() {
    if (chatCardOpen()) return;
    let url;
    try {
      url = chrome.runtime.getURL('src/sidepanel/sidepanel.html');
    } catch {
      throw new Error('extension context unavailable');
    }
    // 本标签页上次打开的会话（聊天卡上报存 sessionStorage）：带 ?conv= 恢复，标签页各自独立
    let remembered = '';
    try { remembered = sessionStorage.getItem('om-card-conv') || ''; } catch { /* 页面禁用存储时忽略 */ }
    const cardUrl = remembered ? `${url}?conv=${encodeURIComponent(remembered)}` : url;
    const host = document.createElement('div');
    host.id = CARD_ID;
    // 贴右满高（对齐原生侧边栏形态）：浮窗列同步左移让位
    host.style.cssText = `all:initial;position:fixed;right:0;top:0;bottom:0;width:${CARD_WIDTH};z-index:2147483644;`;
    const croot = host.attachShadow({ mode: 'open' });
    croot.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          width: 100%; height: 100%; border-radius: 16px 0 0 16px; overflow: hidden;
          background: #fff; border: 1px solid rgba(0,0,0,.08); border-right: 0;
          box-shadow: -12px 0 40px rgba(0,0,0,.28);
          animation: om-card-in .18s ease;
        }
        iframe { display: block; width: 100%; height: 100%; border: 0; }
        @keyframes om-card-in { from { transform: translateX(14px); opacity: 0; } }
        @media (prefers-color-scheme: dark) {
          .wrap { background: #1b1c1f; border-color: rgba(255,255,255,.08); }
        }
      </style>
      <div class="wrap"><iframe src="${cardUrl}" title="Vela" allow="clipboard-write"></iframe></div>`;
    document.documentElement.appendChild(host);
    pillEl?.classList.add('on');
    syncWidgetOffset();
  }

  function toggleChatCard() {
    if (chatCardOpen()) closeChatCard();
    else openChatCard();
  }

  // ---------- 网页媒体：图片 / 视频悬停钮（Monica 式），唯一入口 ----------
  // （原浮窗「媒体」大面板入口已按需求移除：整页扫描清单与嵌入播放器列举不再提供，
  //  所有媒体交互都从悬停钮进。）鼠标移到媒体元素上，其右上角浮出操作钮，
  // 点钮就地展开小弹层（媒体面板页的单媒体模式，?mode=hover），不离开图片即可
  // 分析 / 提取 / 进导图 / 下载；本脚本做 blob 图片转码与视频截帧（必须在本页
  // 上下文里碰页面元素），经 postMessage 对接。
  const HOVER_BTN_ID = 'om-media-hover';
  const HOVER_POP_ID = 'om-media-pop';
  const HOVER_MIN = 80;      // 与面板扫描一致的最小边：小图标不悬停
  const HOVER_SHOW_MS = 200; // 停留阈值：快速扫过不闪钮
  const HOVER_HIDE_MS = 350; // 离开宽限：移向钮 / 弹层的路途不收起

  let hoverEl = null;    // 当前悬停的 img / video
  let hoverKind = '';    // 'img' | 'vid'
  let hoverSrc = '';
  let showTimer = 0;
  let hideTimer = 0;
  let popPinned = false; // 弹层打开期间钮是锚，不随离开收起
  let popSrc = '';       // 弹层当前呈现的媒体 src：换目标重载而非关闭

  const hoverBtnHost = () => document.getElementById(HOVER_BTN_ID) || null;
  const hoverPopHost = () => document.getElementById(HOVER_POP_ID) || null;
  const hoverPopFrame = () => document.getElementById(HOVER_POP_ID)?.shadowRoot?.querySelector('iframe')?.contentWindow || null;
  // 媒体相关 postMessage 的来源白名单：仅悬停弹层 iframe
  const isMediaWin = (w) => !!w && w === hoverPopFrame();

  function mediaTargetOf(node) {
    const el = node?.closest?.('img, video');
    if (!el || !el.isConnected || el.closest('[id^="om-"]')) return null; // 扩展自身浮层不算
    const src = String(el.currentSrc || el.src || '');
    if (!src || /^(chrome-extension|moz-extension):/.test(src)) return null;
    const r = el.getBoundingClientRect();
    if (r.width < HOVER_MIN && r.height < HOVER_MIN) return null;
    return { el, kind: el.tagName === 'VIDEO' ? 'vid' : 'img', src };
  }

  function placeHoverBtn() {
    if (!hoverEl) return;
    const host = hoverBtnHost();
    if (!host) return;
    if (!hoverEl.isConnected) { host.remove(); return; }
    const r = hoverEl.getBoundingClientRect();
    host.style.left = `${Math.max(6, Math.round(r.right) - 40)}px`;
    host.style.top = `${Math.max(6, Math.round(r.top) + 8)}px`;
  }

  function showHoverBtn() {
    if (!hoverEl || !hoverEl.isConnected) return;
    let host = hoverBtnHost();
    if (!host) {
      host = document.createElement('div');
      host.id = HOVER_BTN_ID;
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:32px;height:32px;z-index:2147483645;';
      const croot = host.attachShadow({ mode: 'open' });
      croot.innerHTML = `
        <style>
          :host { all: initial; }
          button {
            all: initial; display: block; width: 32px; height: 32px; border-radius: 50%;
            background: #6841EA; color: #fff; cursor: pointer;
            box-shadow: 0 2px 10px rgba(20,10,60,.45), 0 0 0 2px rgba(255,255,255,.85);
            animation: om-hover-in .15s ease;
          }
          button:hover { background: #5b35d1; }
          button svg { margin: 7.5px; display: block; }
          @keyframes om-hover-in { from { transform: scale(.6); opacity: 0; } }
          @media (prefers-color-scheme: dark) { button { box-shadow: 0 2px 10px rgba(0,0,0,.5), 0 0 0 2px rgba(0,0,0,.6); } }
        </style>
        <button title="图片 / 视频操作（Vela）"></button>`;
      const btn = croot.querySelector('button');
      btn.appendChild(svg('media', 17));
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleHoverPop(); });
      btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      btn.addEventListener('mouseleave', scheduleHoverHide);
      document.documentElement.appendChild(host);
    }
    placeHoverBtn();
  }

  function hideHoverBtn() {
    clearTimeout(showTimer);
    hoverEl = null;
    hoverKind = '';
    hoverSrc = '';
    document.getElementById(HOVER_BTN_ID)?.remove();
  }

  function scheduleHoverHide() {
    if (popPinned) return; // 弹层开着：钮是弹层的锚，保持
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideHoverBtn, HOVER_HIDE_MS);
  }

  function placeHoverPop() {
    const host = hoverPopHost();
    if (!host) return;
    const b = document.getElementById(HOVER_BTN_ID)?.getBoundingClientRect();
    const w = Math.min(400, innerWidth - 24);
    const h = Math.min(486, innerHeight - 24); // wrap 实际高度（iframe 480 + 边框）
    let left = b ? b.right - w : innerWidth - w - 12;
    left = Math.max(12, Math.min(left, innerWidth - w - 12));
    let top = b ? b.bottom + 8 : 12;
    if (top + h > innerHeight - 8) top = Math.max(12, (b ? b.top : innerHeight) - h - 8);
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  function openHoverPop() {
    if (!hoverEl || !hoverEl.isConnected) return;
    let url;
    try {
      const q = new URLSearchParams({ mode: 'hover', kind: hoverKind, src: hoverSrc, url: location.href, title: document.title || '' });
      if (hoverKind === 'img') {
        q.set('w', String(hoverEl.naturalWidth || hoverEl.width || 0));
        q.set('h', String(hoverEl.naturalHeight || hoverEl.height || 0));
        q.set('alt', hoverEl.alt || '');
      } else {
        const kind = hoverEl.srcObject ? 'stream' : /^https?:/i.test(hoverSrc) ? 'direct' : hoverSrc.startsWith('blob:') ? 'stream' : 'other';
        q.set('vk', kind);
        q.set('dur', String(Number.isFinite(hoverEl.duration) && hoverEl.duration > 0 ? Math.round(hoverEl.duration * 10) / 10 : 0));
        q.set('w', String(hoverEl.videoWidth || 0));
        q.set('h', String(hoverEl.videoHeight || 0));
      }
      url = `${chrome.runtime.getURL('src/media/panel.html')}?${q}`;
    } catch { return; }
    popPinned = true;
    popSrc = hoverSrc;
    let host = hoverPopHost();
    if (host) { // 悬停目标已换：弹层就地重载，不关再开
      host.shadowRoot.querySelector('iframe').src = url;
    } else {
      host = document.createElement('div');
      host.id = HOVER_POP_ID;
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483645;';
      const croot = host.attachShadow({ mode: 'open' });
      croot.innerHTML = `
        <style>
          :host { all: initial; }
          .wrap {
            border-radius: 14px; overflow: hidden; background: #fff;
            border: 1px solid rgba(0,0,0,.1); box-shadow: 0 12px 40px rgba(0,0,0,.3);
            animation: om-pop-in .16s ease;
          }
          iframe { display: block; width: min(400px, calc(100vw - 24px)); height: min(480px, calc(100vh - 48px)); border: 0; }
          @keyframes om-pop-in { from { transform: translateY(6px); opacity: 0; } }
          @media (prefers-color-scheme: dark) { .wrap { background: #1b1c1f; } }
        </style>
        <div class="wrap"><iframe src="${url}" title="Vela 图片 / 视频操作" allow="clipboard-write; downloads"></iframe></div>`;
      document.documentElement.appendChild(host);
    }
    placeHoverPop();
  }

  function closeHoverPop() {
    document.getElementById(HOVER_POP_ID)?.remove();
    popPinned = false;
    popSrc = '';
    hideHoverBtn(); // 收弹层时指针多半已不在图上，钮一并收
  }

  function toggleHoverPop() {
    if (hoverPopHost() && popSrc === hoverSrc) closeHoverPop();
    else openHoverPop();
  }

  // mouseover 在 document 上连续触发即连续跟踪：命中媒体元素→亮钮；命中钮/弹层→按未离开；其余→宽限后收起
  document.addEventListener('mouseover', (ev) => {
    const onUi = ev.target === hoverBtnHost() || ev.target === hoverPopHost();
    const t = onUi ? null : mediaTargetOf(ev.target);
    if (t) {
      const moved = t.el !== hoverEl;
      hoverEl = t.el;
      hoverKind = t.kind;
      hoverSrc = t.src;
      clearTimeout(hideTimer);
      if (document.getElementById(HOVER_BTN_ID)) {
        placeHoverBtn(); // 换了张图：钮跟着挪；弹层开着就一并跟过去，别盖住新目标
        if (popPinned) placeHoverPop();
      } else { clearTimeout(showTimer); showTimer = setTimeout(showHoverBtn, HOVER_SHOW_MS); }
      return;
    }
    if (onUi) { clearTimeout(hideTimer); return; }
    scheduleHoverHide();
  });

  // 页面滚动 / 缩放：钮与弹层跟随目标
  let hoverRaf = 0;
  const onHoverReflow = () => {
    if (!hoverEl && !hoverPopHost()) return;
    cancelAnimationFrame(hoverRaf);
    hoverRaf = requestAnimationFrame(() => { placeHoverBtn(); placeHoverPop(); });
  };
  window.addEventListener('scroll', onHoverReflow, { passive: true, capture: true });
  window.addEventListener('resize', onHoverReflow, { passive: true });

  // 弹层外点击收起（capture 阶段判定；钮自身的点击在上面的守卫里放行）
  document.addEventListener('click', (ev) => {
    if (!hoverPopHost()) return;
    if (ev.target === hoverPopHost() || ev.target === hoverBtnHost()) return;
    closeHoverPop();
  }, true);

  // blob: 图片 → dataUrl：字节活在页面源里，扩展页 fetch 不到，只能本页 canvas 转码。
  // 带 src 时精确匹配；匹配不到就明说——退回首张图片会把无关图片悄悄转码分析
  function imgToDataUrl(src, idxHint = 0) {
    return new Promise((resolve) => {
      const list = [...document.images];
      const img = src ? list.find((i) => (i.currentSrc || i.src) === src) : list[idxHint];
      if (!img || !img.naturalWidth) { resolve({ ok: false, error: src ? '目标图片已不在页面上（站点可能已将其移除），请重新悬停后再试' : '页面里找不到该图片' }); return; }
      try {
        const scale = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(2, Math.round(img.naturalWidth * scale));
        c.height = Math.max(2, Math.round(img.naturalHeight * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve({ ok: true, dataUrl: c.toDataURL('image/png') });
      } catch (e) {
        resolve({ ok: false, error: '该图片受跨域保护，无法读取内容' });
      }
    });
  }

  // 视频截帧：seek 到时间点画 canvas（跨域无 CORS 头的视频会 taint，报错说明）。
  // 'seeked' 只代表定位完成，MSE 流（bilibili 等）上新帧可能还没解码呈现，立刻画会
  // 拿到旧帧或半解码的模糊帧：再等一拍 requestVideoFrameCallback 确认新帧已上屏，
  // 慢解码 / 不支持该 API 的环境由超时与 rAF 兜底。
  const frameShown = (v) => new Promise((resolve) => {
    if (typeof v.requestVideoFrameCallback !== 'function') { requestAnimationFrame(() => requestAnimationFrame(resolve)); return; }
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    v.requestVideoFrameCallback(() => fin());
    setTimeout(fin, 400);
  });
  const seekOnce = (v, t) => new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      v.removeEventListener('seeked', fin);
      frameShown(v).then(resolve);
    };
    v.addEventListener('seeked', fin);
    try { v.currentTime = Math.max(0, Math.min(t, (v.duration || 1) - 0.05)); } catch { fin(); }
    setTimeout(fin, 1600);
  });

  async function captureFrames(idx, want = 4, srcHint = '') {
    // 悬停弹层只带 src：精确匹配；匹配不到就明说，不退回 vids[0]（那会截到无关视频）
    const vids = [...document.querySelectorAll('video')];
    const v = srcHint ? vids.find((x) => x.currentSrc === srcHint || x.src === srcHint) : vids[idx];
    if (!v) return { ok: false, error: srcHint ? '目标视频已不在页面上（站点可能已将其移除），请重新悬停后再试' : '页面里找不到该视频' };
    if (!v.videoWidth) return { ok: false, error: '视频还没有画面数据（稍等播放开始后再试）' };
    // MediaRecorder 产出的 webm 元数据 duration=Infinity：seek 到超界时间逼出真实时长再复位。
    // durationchange 在慢机器上可能迟迟不来：重试一次，两轮都失败就按单帧兜底
    if (v.duration === Infinity) {
      for (let i = 0; i < 2 && v.duration === Infinity; i++) {
        await new Promise((resolve) => {
          const fin = () => { v.removeEventListener('durationchange', fin); resolve(); };
          v.addEventListener('durationchange', fin);
          try { v.currentTime = 1e7; } catch { fin(); }
          setTimeout(fin, 1800);
        });
      }
      await seekOnce(v, 0);
    }
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const times = dur > 0 ? [0.04, dur * 0.25, dur * 0.5, dur * 0.75, dur * 0.96] : [v.currentTime || 0];
    const orig = v.currentTime;
    const frames = [];
    try {
      for (const t of times.slice(0, Math.max(2, Math.min(want, 5)))) {
        await seekOnce(v, t);
        const scale = Math.min(1, 768 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(2, Math.round(v.videoWidth * scale));
        c.height = Math.max(2, Math.round(v.videoHeight * scale));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        frames.push({ t: Math.round((v.currentTime || 0) * 10) / 10, dataUrl: c.toDataURL('image/jpeg', 0.82) });
      }
      if (dur > 0) await seekOnce(v, orig); // 还原播放位置，不打扰用户
      return { ok: true, frames };
    } catch {
      return { ok: false, error: '视频受跨域保护，无法截帧分析' };
    }
  }

  // ---------- 宿主页正文提炼（供聊天卡作会话上下文） ----------
  // 与 injected.extractArticle 同思路（经典脚本禁 import，就地内联）：临时隐藏非正文节点
  // 后挑文本密度最高的容器读 innerText，截 6000 字符回传
  function extractPageContext() {
    const SKIP = 'script,style,noscript,template,iframe,svg,canvas,nav,footer,aside,form,button';
    const hidden = [];
    for (const n of document.querySelectorAll(SKIP)) { hidden.push([n, n.style.display]); n.style.display = 'none'; }
    let best = null;
    let bestScore = 0;
    for (const c of document.querySelectorAll('article, main, [role="main"], #content, .content, .post, .article, .markdown-body')) {
      const text = c.innerText || '';
      const score = text.length * (c.matches('article, main, [role="main"]') ? 1.2 : 1);
      if (text.length > 200 && score > bestScore) { best = c; bestScore = score; }
    }
    const text = ((best || document.body).innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
    for (const [n, d] of hidden) n.style.display = d;
    return { title: document.title || '', url: location.href, text };
  }

  // 浮窗「导图」钮带回的页面正文快照：与划词工具条同款（innerText 已排除脚本/样式，
  // 压掉连续空行再截断）。快照前先隐藏扩展自身浮层（本浮窗 / 聊天卡 / 悬停钮 / 划词
  // 工具条等），否则提示文案会混进正文。
  function snapshotPageText() {
    const own = [...document.querySelectorAll(
      '#om-widget-host, #om-card-host, #om-tx-runner-host, #om-media-hover, #om-media-pop, '
      + '#om-sel-host, #om-sel-panel-host, #om-sel-cbtn-host, #om-sel-hlbtn-host, #om-mm-collect-toast',
    )];
    const prev = own.map((n) => n.style.display);
    own.forEach((n) => { n.style.display = 'none'; });
    try {
      return (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000);
    } finally {
      own.forEach((n, i) => { n.style.display = prev[i]; });
    }
  }

  // 原生侧边栏 / 独立聊天页打开时（后台广播）：收起页内聊天卡，避免两个聊天窗并存
  // 右键菜单动作（后台转发）：在本标签页就地展开聊天卡，任务经 pendingTask 由卡片消费
  // 工具栏图标 / Ctrl+M（后台转发）：开关本标签页聊天卡
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'om:close-card') closeChatCard();
    if (msg?.type === 'om:open-card') { try { openChatCard(); } catch { /* 上下文失效时忽略 */ } }
    if (msg?.type === 'om:toggle-card') { try { toggleChatCard(); } catch { /* 上下文失效时忽略 */ } }
  });

  // ---------- 隐藏翻译编排 iframe（Monica 式：点翻译不弹聊天卡） ----------
  // 0×0 隐藏 iframe 指向扩展的 tx-runner 页：视口驱动翻译管线驻留其中，
  // 滚动续译持续服务；进度由浮球呈现，收场经 postMessage 通知本浮窗清理。
  const RUNNER_ID = 'om-tx-runner-host';

  function txRunnerFrame() {
    return document.getElementById(RUNNER_ID)?.querySelector('iframe') || null;
  }

  function closeTxRunner() {
    document.getElementById(RUNNER_ID)?.remove();
  }

  function openTxRunner() {
    if (document.getElementById(RUNNER_ID)) return;
    let url;
    try {
      url = chrome.runtime.getURL('src/page/tx-runner.html');
    } catch {
      throw new Error('extension context unavailable');
    }
    const host = document.createElement('div');
    host.id = RUNNER_ID;
    host.style.cssText = 'all:initial;position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none;';
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.title = 'Vela 翻译';
    host.appendChild(frame);
    document.documentElement.appendChild(host);
  }

  // ---------- 快捷设置弹出层（Monica 式）：点「翻译此页」旁的小齿轮展开 ----------
  // 模型 / 翻译模式 / 目标语言就地切换。内容脚本能直接读写 chrome.storage.local，改动即存。
  const SETTINGS_KEY = 'llmSettings';
  const TX_LANGS = [
    ['zh-CN', '简体中文'], ['zh-TW', '繁体中文'], ['en', '英文'], ['ja', '日文'],
    ['ko', '韩文'], ['fr', '法文'], ['de', '德文'], ['es', '西班牙文'],
    ['ru', '俄文'], ['pt', '葡萄牙文'], ['it', '意大利文'],
  ];

  async function readSettings() {
    let s = {};
    try { s = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {}; } catch { return null; }
    return {
      providers: Array.isArray(s.providers) ? s.providers : [],
      activeProviderId: s.activeProviderId || '',
      translation: { targetLang: 'zh-CN', mode: 'bilingual', ...(s.translation || {}) },
    };
  }

  async function writeSettings(mutate) {
    const s = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
    mutate(s);
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  }

  let popEl = null;
  let popOutside = null;
  let gearEl = null; // 翻译按钮旁的小设置齿轮（悬停亮出，点击开面板）
  let gearHost = null; // 齿轮所属的翻译按钮
  let gearHideTimer = 0; // 隐藏缓冲：指针在按钮/齿轮之间移动不闪收
  let txTranslated = false; // 本页已翻译（设置齿轮切模式时据此即时重铺）

  function closePop() {
    popEl?.remove();
    popEl = null;
    if (popOutside) { document.removeEventListener('pointerdown', popOutside, true); popOutside = null; }
    // 面板关了齿轮跟着收，指针还停在按钮上则保持亮出
    if (gearEl && !gearHost?.matches(':hover')) gearEl.classList.remove('show');
  }

  async function openPop(root, anchor) {
    if (popEl) return;
    const s = await readSettings();
    if (!s) { hint(root, '扩展上下文失效，请刷新页面'); return; }
    const active = s.providers.find((p) => p.id === s.activeProviderId) || null;

    popEl = document.createElement('div');
    popEl.className = 'om-w-pop';
    popEl.style.top = `${anchor.offsetTop}px`;
    let modelOpts = '<option value="" disabled>未配置供应商</option>';
    if (s.providers.length) {
      modelOpts = s.providers.map((p) => `<optgroup label="${p.name || p.baseUrl || p.id}">${
        (p.models || []).map((m) => `<option value='${JSON.stringify([p.id, m])}'>${m}</option>`).join('')
      }</optgroup>`).join('');
    }
    const currentModel = active?.models?.[0] ? JSON.stringify([active.id, active.models[0]]) : '';
    popEl.innerHTML = `
      <div class="om-w-pop-title">网页翻译设置<span class="om-w-pop-x" role="button">×</span></div>
      <label>模型（网页功能使用）<select class="om-w-model">${modelOpts}</select></label>
      <label>目标语言<select class="om-w-lang">${
        TX_LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')
      }</select></label>
      <label>翻译模式<select class="om-w-mode">
        <option value="bilingual">对照（译文在原文下方）</option>
        <option value="immersive">沉浸（译文替换原文）</option>
      </select></label>
      <button class="om-w-more">打开完整设置</button>
      <div class="om-w-pop-note">改动即存，下一次总结 / 翻译生效</div>`;
    if (currentModel) popEl.querySelector('.om-w-model').value = currentModel;
    popEl.querySelector('.om-w-lang').value = s.translation.targetLang;
    popEl.querySelector('.om-w-mode').value = s.translation.mode;

    popEl.querySelector('.om-w-pop-x').addEventListener('click', closePop);
    popEl.querySelector('.om-w-model').addEventListener('change', async (ev) => {
      if (!ev.target.value) return;
      const [pid, model] = JSON.parse(ev.target.value);
      try {
        await writeSettings((s2) => {
          s2.activeProviderId = pid;
          const p = (s2.providers || []).find((x) => x.id === pid);
          // 所选模型挪到首位 = 该供应商默认模型（streamChat 取 models[0]）
          if (p && model) p.models = [model, ...(p.models || []).filter((m) => m !== model)];
        });
        hint(root, '已切换模型');
      } catch { hint(root, '保存失败，请重试'); }
    });
    popEl.querySelector('.om-w-lang').addEventListener('change', (ev) => {
      writeSettings((s2) => { s2.translation = { ...(s2.translation || {}), targetLang: ev.target.value }; })
        .then(() => hint(root, '已切换目标语言'))
        .catch(() => hint(root, '保存失败，请重试'));
    });
    popEl.querySelector('.om-w-mode').addEventListener('change', (ev) => {
      const mode = ev.target.value;
      writeSettings((s2) => { s2.translation = { ...(s2.translation || {}), mode }; })
        .then(async () => {
          console.info('[Vela] 翻译模式已存:', mode);
          // 本页已翻译时译文按新模式即时重铺（bridge 同 world 直达，无需重译）。
          // 以 bridge 实况判断：中途失败后 txTranslated 镜像被复位，但译文还铺在页面上
          if (window.__omTxBridge?.isActive?.()) {
            hint(root, '已切换翻译模式');
            window.dispatchEvent(new CustomEvent('om:tx-mode', { detail: mode }));
            return;
          }
          if (txStale()) {
            // 扩展重载后的旧译文重铺不了（新模式要重译）：还原后立刻按新模式重译，
            // 不留给用户「点了翻译却只是还原」的两段式操作
            domRestoreTx();
            txTranslated = false;
            anchor.classList.remove('tx-on');
            anchor.title = '翻译此页';
            closePop();
            const s = await readSettings();
            if (s?.providers.length) {
              try { openTxRunner(); return; } catch { /* 起不动就落到下次翻译 */ }
            }
            hint(root, '已还原原文，下次翻译用新模式');
            return;
          }
          hint(root, '已切换翻译模式');
        })
        .catch(() => hint(root, '保存失败，请重试'));
    });
    popEl.querySelector('.om-w-more').addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'om:open-options' }); } catch { /* 上下文失效 */ }
      closePop();
    });

    root.appendChild(popEl);
    // 点击面板以外区域 / Esc 立即关闭；齿轮不算外部（否则先关后开，开关失灵）
    popOutside = (ev) => {
      const path = ev.composedPath();
      if (path.includes(popEl) || (gearEl && path.includes(gearEl))) return;
      closePop();
    };
    document.addEventListener('pointerdown', popOutside, true);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closePop(); }, { once: true });
  }

  // 两段式（Monica 式）：悬停翻译按钮只亮出旁侧小齿轮，点齿轮才展开设置面板。
  // 齿轮是按钮的子节点：停在齿轮上等于没离开按钮，mouseleave 不会误收。
  function wireGearPop(root, txBtn) {
    gearHost = txBtn;
    gearEl = document.createElement('span');
    gearEl.className = 'om-w-gear';
    gearEl.setAttribute('role', 'button');
    gearEl.title = '网页翻译设置';
    gearEl.appendChild(svg('gear', 14));
    txBtn.appendChild(gearEl);

    // 齿轮贴着按钮边缘（无空隙），再加 200ms 隐藏缓冲：指针滑向齿轮途中不会闪收
    txBtn.addEventListener('mouseenter', () => {
      clearTimeout(gearHideTimer);
      gearEl.classList.add('show');
    });
    txBtn.addEventListener('mouseleave', () => {
      clearTimeout(gearHideTimer);
      gearHideTimer = setTimeout(() => { if (!popEl) gearEl.classList.remove('show'); }, 200);
    });
    gearEl.addEventListener('click', (e) => {
      e.stopPropagation(); // 别触发按钮本身的翻译开关
      if (popEl) closePop();
      else openPop(root, txBtn);
    });
  }

  function build() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;right:10px;top:38%;transform:translateY(-50%);z-index:2147483645;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' }); // open：便于测试与用户调试
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .stack { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .act {
          position: relative;
          width: 36px; height: 36px; border-radius: 50%; border: none; cursor: pointer;
          background: #212227; color: #fff; display: flex; align-items: center; justify-content: center;
          box-shadow: 0 3px 10px rgba(0,0,0,.26); padding: 0;
          transition: transform .12s ease, background .12s ease;
          user-select: none; -webkit-user-select: none;
        }
        .act:hover { transform: scale(1.06); background: #2c2d33; }
        .act:active { transform: scale(.96); }
        .pill {
          position: relative; border: none; cursor: pointer; padding: 0;
          height: 38px; border-radius: 19px; background: #6841ea; color: #fff;
          display: flex; align-items: center; gap: 6px; padding: 0 12px 0 7px;
          box-shadow: 0 4px 14px rgba(68,44,180,.36);
          font: 600 12px/1 system-ui, "Segoe UI", sans-serif;
          transition: transform .12s ease;
          user-select: none; -webkit-user-select: none;
        }
        .pill:hover { transform: scale(1.04); }
        .pill .logo {
          width: 25px; height: 25px; border-radius: 50%; background: #fff; color: #5a32e0;
          display: flex; align-items: center; justify-content: center; flex: none;
        }
        .dismiss {
          position: absolute; top: -6px; left: -6px; width: 16px; height: 16px;
          border-radius: 50%; cursor: pointer;
          background: #3a3b41; color: #fff; display: flex; align-items: center; justify-content: center;
          box-shadow: 0 2px 6px rgba(0,0,0,.3);
        }
        .dismiss:hover { background: #55565e; }
        .om-w-hint {
          position: absolute; right: 44px; top: 50%; transform: translateY(-50%);
          background: #212227; color: #fff; font: 12px/1.4 system-ui, sans-serif;
          padding: 7px 11px; border-radius: 8px; white-space: nowrap;
          opacity: 0; pointer-events: none; transition: opacity .15s;
        }
        .om-w-hint.show { opacity: 1; }
        .om-w-gear {
          position: absolute; left: -28px; top: 50%; transform: translateY(-50%);
          width: 24px; height: 24px; border-radius: 50%; cursor: pointer;
          background: #212227; color: #fff; display: flex; align-items: center; justify-content: center;
          box-shadow: 0 2px 8px rgba(0,0,0,.3);
          opacity: 0; pointer-events: none; transition: opacity .12s ease;
        }
        .om-w-gear.show { opacity: 1; pointer-events: auto; }
        .om-w-gear:hover { background: #2c2d33; }
        @media (prefers-color-scheme: dark) { .om-w-gear { background: #2d2d2f; } .om-w-gear:hover { background: #3a3a3d; } }
        .om-w-pop {
          position: absolute; right: 46px; width: 248px;
          background: #212227; color: #fff; border-radius: 12px;
          padding: 12px 14px 10px; box-shadow: 0 10px 32px rgba(0,0,0,.38);
          font: 12px/1.5 system-ui, "Segoe UI", sans-serif;
          display: flex; flex-direction: column; gap: 9px;
          animation: om-pop-in .15s ease;
        }
        @keyframes om-pop-in { from { transform: translateX(8px); opacity: 0; } }
        .om-w-pop-title { font-weight: 600; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
        .om-w-pop-x { cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; opacity: .7; }
        .om-w-pop-x:hover { opacity: 1; }
        .om-w-pop label { display: flex; flex-direction: column; gap: 4px; color: rgba(255,255,255,.82); }
        .om-w-pop select {
          background: #2c2d33; color: #fff; border: 1px solid rgba(255,255,255,.14);
          border-radius: 7px; padding: 6px 8px; font: 12px/1.4 system-ui, sans-serif;
          max-width: 100%;
        }
        .om-w-pop select:focus { outline: 1px solid #7d5af0; }
        .om-w-more {
          align-self: flex-start; background: none; border: none; cursor: pointer;
          color: #a88ff2; font: 12px/1.4 system-ui, sans-serif; padding: 0;
        }
        .om-w-more:hover { text-decoration: underline; }
        .om-w-pop-note { color: rgba(255,255,255,.45); font-size: 11px; }
        @media (prefers-color-scheme: dark) {
          .act { background: #2d2d2f; }
          .act:hover { background: #3a3a3d; }
        }
        /* 激活态（Monica 式）：一次性动作运行中紫色高亮；翻译按钮开关态紫色 + 角标对勾 */
        .act.active, .act.tx-on { background: #6841ea; }
        .act.active:hover, .act.tx-on:hover { background: #7d5af0; }
        .act.tx-on::after {
          content: '✓'; position: absolute; right: -3px; bottom: -3px;
          width: 15px; height: 15px; border-radius: 50%;
          background: #fff; color: #6841ea; font: 700 10px/15px system-ui, sans-serif;
          text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.3);
        }
        .pill.on { background: #5a35d0; box-shadow: 0 6px 18px rgba(68,44,180,.55); }
      </style>
      <div class="stack">
        <button class="act" data-act="page-summary" title="总结此页"></button>
        <button class="act" data-act="translate-page" title="翻译此页"></button>
        <button class="act" data-act="quick-action" title="解释选中文字"></button>
        <button class="act" data-act="mindmap" title="本页思维导图：划词高亮素材 / 整页正文生成导图（无需选中文字）"></button>
        <button class="pill" data-act="open-panel" title="展开 / 收起本页聊天卡">
          <span class="logo"></span><span>AI 助手</span>
          <span class="dismiss" role="button" title="隐藏浮窗（刷新页面后恢复）"></span>
        </button>
        <div class="om-w-hint"></div>
      </div>`;
    root.querySelector('[data-act="page-summary"]').appendChild(svg('doc', 17));
    root.querySelector('[data-act="translate-page"]').appendChild(svg('translate', 17));
    root.querySelector('[data-act="quick-action"]').appendChild(svg('explain', 17));
    root.querySelector('[data-act="mindmap"]').appendChild(svg('mind', 17));
    root.querySelector('.pill .logo').appendChild(svg('logo', 16));
    root.querySelector('.dismiss').appendChild(svg('close', 9));
    pillEl = root.querySelector('.pill');

    // 胶囊：就地开关页内聊天卡（无需 SW 参与，旧上下文失效也能开合）
    // 一次性动作（总结/解释）：sendMessage 交 SW 写 pendingTask，同时打开聊天卡即时执行。
    // 翻译是开关：就地启动隐藏 runner 编排，不弹聊天卡；按钮高亮到翻译落定。
    let busyBtn = null;
    const onActionRes = (res) => {
      const b = busyBtn;
      busyBtn = null;
      b?.classList.remove('active');
      if (res && res.ok) return;
      hint(root, res
        ? '动作失败，请重试'
        : '扩展未响应：请到 chrome://extensions 刷新 Vela，并刷新本页重试');
    };
    root.querySelector('.stack').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.classList.contains('dismiss')) return;
      if (btn.dataset.act === 'open-panel') {
        try { toggleChatCard(); } catch { hint(root, '无法打开聊天卡，请刷新页面后重试'); }
        return;
      }
      // 本页思维导图：与划词工具条同管线（带正文快照交 SW 开查看页），不开聊天卡
      if (btn.dataset.act === 'mindmap') {
        busyBtn = btn;
        btn.classList.add('active');
        send({ type: 'om:widget-action', kind: 'mindmap', from: 'widget', pageText: snapshotPageText() }, onActionRes);
        return;
      }
      // 翻译按钮是开关（Monica 式）：已翻译再点 = 还原原文并撤掉编排。
      // 以 bridge 实况兜底：中途失败后 txTranslated 被复位，但页面译文还在，仍应走还原
      if (btn.dataset.act === 'translate-page' && (txTranslated || txStale())) {
        txTranslated = false;
        btn.classList.remove('tx-on');
        btn.title = '翻译此页';
        // bridge 存活走同 world 事件；否则（扩展重载后旧译文残留）按 DOM 快照直接还原
        if (window.__omTxBridge?.isActive?.()) window.dispatchEvent(new CustomEvent('om:tx-restore'));
        else domRestoreTx();
        closeTxRunner();
        hint(root, '已还原原文');
        return;
      }
      // 翻译：本地校验供应商 → 就地启动隐藏 runner（不写 pendingTask、不开聊天卡）
      if (btn.dataset.act === 'translate-page') {
        const s = await readSettings();
        if (!s) { hint(root, '扩展上下文失效，请刷新页面'); return; }
        if (!s.providers.length) {
          hint(root, '翻译需要 LLM 供应商：请先在设置页配置并保存');
          try { chrome.runtime.sendMessage({ type: 'om:open-options' }); } catch { /* 上下文失效 */ }
          return;
        }
        btn.classList.add('active');
        try {
          openTxRunner();
        } catch {
          btn.classList.remove('active');
          hint(root, '无法启动翻译，请刷新页面后重试');
        }
        return;
      }
      busyBtn = btn;
      btn.classList.add('active');
      if (btn.dataset.act === 'quick-action') {
        const selection = (window.getSelection()?.toString() || '').trim();
        if (!selection) {
          btn.classList.remove('active');
          busyBtn = null;
          hint(root, '先选中网页文字，再点此解释');
          return;
        }
        send({ type: 'om:widget-action', kind: 'quick-action', actionId: 'qa-explain', selection: selection.slice(0, 2000), from: 'widget' }, onActionRes);
      } else {
        send({ type: 'om:widget-action', kind: btn.dataset.act, from: 'widget' }, onActionRes);
      }
      try { openChatCard(); } catch { /* 卡打不开时提示已由 onActionRes 给出 */ }
    });
    // 关闭：隐藏当前页浮窗并一并收起聊天卡；刷新或下次导航自动恢复
    root.querySelector('.dismiss').addEventListener('click', (e) => {
      e.stopPropagation();
      host.remove();
      closeChatCard();
      closeHoverPop();
    });

    // 翻译进行中让位给浮球（bridge 广播，旧版 bridge 只有这一条）
    window.addEventListener('om:tx-active', (ev) => {
      if (ev.detail) host.style.display = 'none';
    });
    // 翻译状态机：开始/进行中隐藏浮窗，完成后回来并亮「已翻译」开关态，还原后熄灭
    const txBtn = root.querySelector('[data-act="translate-page"]');
    window.addEventListener('om:tx-state', (ev) => {
      const { translated, running } = ev.detail || {};
      txTranslated = !!translated;
      if (!running) txBtn.classList.remove('active');
      txBtn.classList.toggle('tx-on', txTranslated);
      txBtn.title = txTranslated ? '已翻译：再点一次还原原文' : '翻译此页';
      host.style.display = running ? 'none' : '';
    });
    // 翻译编排 iframe（聊天卡或隐藏 runner）发来的收场通知：
    // om:tx-failed = 未开始/失败，复位按钮并就地给出原因；om:tx-done = 静默收场，撤掉 runner
    // 聊天卡 iframe 在宿主 shadow root 里：必须走 shadowRoot.querySelector 取窗口引用
    const cardFrame = () => document.getElementById(CARD_ID)?.shadowRoot?.querySelector('iframe')?.contentWindow || null;
    // SPA 站点换页不重载页面，也就不重载聊天卡：卡片只在加载时索取过一次正文，之后上下文就是旧页面的。
    // 卡片打开期间轮询地址（忽略 #hash），变化后等新页面渲染稳定（1.2s）再把新正文重发给卡片
    const pageKey = () => location.origin + location.pathname + location.search;
    let ctxPageKey = pageKey();
    let ctxTimer = 0;
    const ctxPoll = setInterval(() => {
      let alive = false;
      try { alive = !!chrome.runtime?.id; } catch { /* 上下文已失效 */ }
      if (!alive) { clearInterval(ctxPoll); clearTimeout(ctxTimer); return; } // 扩展重载后旧实例自行退场
      if (!chatCardOpen()) { ctxPageKey = pageKey(); return; }
      const k = pageKey();
      if (k === ctxPageKey) return;
      ctxPageKey = k;
      clearTimeout(ctxTimer);
      ctxTimer = setTimeout(() => {
        const w = cardFrame();
        if (w) { try { w.postMessage({ type: 'om:card-ctx', ...extractPageContext() }, '*'); } catch { /* 页面环境异常时忽略 */ } }
      }, 1200);
    }, 1000);
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      // 悬停弹层（本页 iframe）请求：blob 图转码 / 视频截帧。来源必须是弹层自己的 iframe
      if (d?.type === 'om:media-close') {
        // 悬停弹层点「✕」请求收起：只认弹层自己的窗口
        if (ev.source === hoverPopFrame()) closeHoverPop();
        return;
      }
      if (d?.type === 'om:media-img-req') {
        if (isMediaWin(ev.source)) imgToDataUrl(String(d.src || ''), Number(d.idx) || 0)
          .then((out) => { try { ev.source.postMessage({ type: 'om:media-img', src: d.src, ...out }, '*'); } catch { /* 面板已关 */ } });
        return;
      }
      if (d?.type === 'om:media-frames-req') {
        if (isMediaWin(ev.source)) captureFrames(Number(d.idx) || 0, Number(d.count) || 4, String(d.src || ''))
          .then((out) => { try { ev.source.postMessage({ type: 'om:media-frames', src: d.src, ...out }, '*'); } catch { /* 面板已关 */ } });
        return;
      }
      // 聊天卡索取宿主页正文：提炼后回传，由卡片挂到会话作为网页上下文（减少无上下文幻觉）
      if (d?.type === 'om:card-ctx-req') {
        if (ev.source === cardFrame()) {
          ctxPageKey = pageKey();
          try { ev.source.postMessage({ type: 'om:card-ctx', ...extractPageContext() }, '*'); } catch { /* 页面环境异常时忽略 */ }
        }
        return;
      }
      // 聊天卡上报的当前会话：存 sessionStorage（按标签页隔离），重开卡时恢复本标签页上次会话
      if (d?.type === 'om:card-conv') {
        if (ev.source === cardFrame()) {
          try { sessionStorage.setItem('om-card-conv', String(d.convId || '')); } catch { /* 页面禁用存储时忽略 */ }
        }
        return;
      }
      if (d?.type !== 'om:tx-failed' && d?.type !== 'om:tx-done') return;
      const fromCard = ev.source === cardFrame();
      const fromRunner = ev.source === txRunnerFrame()?.contentWindow;
      if (d.type === 'om:tx-done') {
        if (fromRunner) closeTxRunner();
        return;
      }
      if (!fromCard && !fromRunner) return;
      if (fromRunner) closeTxRunner();
      // 中途失败时页面可能仍持有已译文（bridge 未还原）：按钮态按 bridge 实况定，
      // 已译文的下次点击走还原而不是重新翻译
      txTranslated = !!window.__omTxBridge?.isActive?.();
      txBtn.classList.remove('active');
      txBtn.classList.toggle('tx-on', txTranslated);
      txBtn.title = txTranslated ? '已翻译：再点一次还原原文' : '翻译此页';
      hint(root, `翻译未完成：${d.message}`);
    });
    // 悬停翻译按钮亮出小齿轮，点齿轮展开快捷设置面板（Monica 式两段交互）
    wireGearPop(root, txBtn);

    // 扩展重载后旧 world 铺的译文还在页面上：按钮按已翻译态显示，
    // 再点一次走快照还原，而不是把中文当原文重译一遍
    if (txStale()) {
      console.info('[Vela] 检测到旧实例翻译残留：按钮置为已翻译态，再点一次按快照还原');
      txTranslated = true;
      txBtn.classList.add('tx-on');
      txBtn.title = '已翻译：再点一次还原原文';
    }

    window.__omWidget = { host, rt: chrome.runtime }; // rt：补注时判断旧实例是否属于当前扩展上下文
    console.info(`[Vela] 页面浮窗已注入 v${chrome.runtime.getManifest().version}`);
  }

  build();
})();
