// 页面桥接脚本：chrome.scripting.executeScript({files}) 注入的经典 IIFE（禁 import/export）。
// 职责：块发现与打标、视口观察（IntersectionObserver + MutationObserver）、按需上报待译块、
//       监听 Port 按模式回填译文（对照/沉浸）、还原、Shadow DOM 浮球、SPA 路由守卫。
// 样式约定：.om-tx-dst / .om-tx-wait 由编排页经 insertCSS 下发；浮球样式内嵌 Shadow root。
(() => {
  'use strict';
  if (window.__omTxBridge) {
    window.__omTxBridge.reset(); // 重复注入：先还原上一轮，再接管
  }

  const state = {
    port: null,
    mode: 'bilingual', // bilingual | immersive
    targetLang: '',
    started: false,
    originals: new Map(), // id -> { node, text, hasRich }
    translations: new Map(), // id -> string
    failed: new Set(),
    skipped: new Set(), // 编排端因上限拒收的块 id（不计失败，但计入落定）
    requested: new Set(), // 已通过 om:tx_need 上报的块
    blocks: new Map(), // id -> { node, text }
    nextId: 0,
    appliedCnt: 0,
    finished: false,
    disconnected: false,
    observer: null,
    mo: null,
    needTimer: 0,
    needBuf: [], // 待上报的 { id, text }
    ball: null, // { host, root, ... }
    ballDoneTimer: 0, // 完成态浮球延时收场
    urlTimer: 0,
    startUrl: '',
  };

  // ---------- 块发现（与总结提取互不依赖；翻译调度按视口按需上报） ----------
  // label：文档站侧栏（Hugo book / Antora 等）的折叠章节标题放在 <label> 里，
  // 不收录则整条侧栏目录永远进不了翻译；表单 label 通常包住 input，会被子树检查拒掉
  // [role=…]：x.ai / Notion 式对比表不用 <table>，是 div + ARIA 表格角色
  // （rowheader / columnheader / cell，网格表格为 gridcell）——不收录则整张表进不了翻译；
  // 纯图标格子无文本，会被文本过滤自然淘汰
  const SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, '
    + '[role="rowheader"], [role="columnheader"], [role="cell"], [role="gridcell"], '
    + 'figcaption, dd, dt, label';
  // 子树含这些元素 → 整块跳过。不含 <a>/<code>/<kbd>/<samp>：文档站标题内嵌锚点链接、
  // 正文/表格单元格混行内代码（选项名、参数值）都是正常可译内容，行内代码由 prompt 保持原样；
  // 代码块已由 pre 覆盖；沉浸模式整块替换为纯译文，行内标记按 innerHTML 快照在还原时恢复。
  // 不含 <svg>：图标（导航链接的 chevron、按钮里的图形）innerText 无文本，不是拒收理由——
  // 含图标的链接一旦被拒，顶栏导航整排都进不了翻译。
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'iframe', 'canvas', 'pre',
    'button', 'select', 'textarea', 'sup', 'sub', 'form', 'input',
  ]);

  // 标识符 / 配置项 / 路径 / 键值对：无空格或 key=value 形态的纯 ASCII 机器文本，不翻译
  function looksLikeConfig(t) {
    if (/[^\x00-\x7F]/.test(t)) return false; // 含非 ASCII（如中文）→ 自然语言
    if (!/\s/.test(t)) return t.length >= 4 && /[._\-/:=@#$]/.test(t);
    return /^[\w.\-/:]+\s*[=:]\s*\S+$/.test(t); // key: value / key = value
  }

  function candidateText(node) {
    if (node.getAttribute('data-om-tx') != null) return null; // 已收录
    if (node.closest('.om-tx-dst')) return null; // 自己插入的译文节点不收录，防重复翻译
    if (SKIP_TAGS.has(node.tagName.toLowerCase())) return null;
    // 标题豁免：手风琴问题头（WAI-ARIA 标准模式 h3 > button > span 问题文本 + svg 加号）
    // 会被子树检查整块拒掉，FAQ 问题永远进不了翻译；h1-h6 容许内嵌 button
    const lax = /^h[1-6]$/i.test(node.tagName);
    for (const d of node.querySelectorAll('*')) {
      const t = d.tagName.toLowerCase();
      if (SKIP_TAGS.has(t) && !(lax && t === 'button')) return null; // 子树含代码/结构元素
    }
    // 可见性不在收录时判（见 ensureObserver）：折叠菜单/隐藏帧收录时不可见，展开后仍要能译
    const raw = (node.innerText || '').replace(/\s+/g, ' ').trim();
    if (raw.length < 2) return null;
    const useful = raw.replace(/[0-9\s.,:;!?%()[\]{}@#^&*+=\-_/"'`~<>|\\/，。：；！？（）【】、…·-]/g, '');
    if (raw.length >= 8 && useful.length / raw.length < 0.4) return null; // 数字/URL/符号占比过高
    if (looksLikeConfig(raw)) return null;
    return raw.length > 2000 ? raw.slice(0, 2000) + '…' : raw;
  }

  // 收录一个候选块：打标 + 进入视口观察。返回是否收录。
  // 上限由编排页按“已受理翻译量”控制；发现阶段不设限，否则长页下半部分
  // 根本进不了观察器，滚动续译就断了。
  function adopt(node) {
    const text = candidateText(node);
    if (text == null) return false;
    const id = state.nextId++;
    node.setAttribute('data-om-tx', String(id));
    // 原文快照存进 DOM 属性：扩展重载后旧 world 不可达，新实例要撤销沉浸式
    // 替换（textContent 已换掉，originals 只在旧 world 内存里）只能靠这份快照
    const html = node.innerHTML;
    if (html.length <= 20000) node.setAttribute('data-om-tx-orig', html);
    state.blocks.set(id, { node, text });
    state.observer?.observe(node);
    return true;
  }

  function discover(rootNode = document) {
    const all = [...rootNode.querySelectorAll(SELECTOR)];
    // 局部重扫时不能做全局 leaf-most 过滤（会误收祖先），只看无已收录块后代的节点
    for (const n of all) {
      if (n.querySelector(SELECTOR)) continue;
      // li 的全部文本都来自唯一子链接（顶栏/目录导航的标准形态）时让 <a> 自己当块
      // （第二遍兜底收走）：沉浸模式 li 整块 textContent 替换会把链接抹掉，导航就点不动了
      if (n.tagName === 'LI') {
        const links = n.querySelectorAll('a');
        if (links.length === 1
          && (links[0].innerText || '').replace(/\s+/g, ' ').trim() === (n.innerText || '').replace(/\s+/g, ' ').trim()) continue;
      }
      adopt(n);
    }
    // 第二遍兜底：主选择器盖不住的行内文本（页脚/顶栏导航链接、列标题 span、面包屑）。
    // a/span 不能进主选择器——leaf-most 过滤会把「带内联链接的正文段落」拆成只译链接。
    // 祖先或后代有已收录块的都跳过（悬停大菜单 a 内含 span 标题 + p 描述，重复收会双译）；
    // 按钮内文本是 UI 控件不译，选项卡标签（role=tab，如 Individual/Teams/API）例外
    for (const n of rootNode.querySelectorAll('a, span')) {
      if (n.closest('[data-om-tx]') || n.querySelector('[data-om-tx]')) continue;
      const ctrl = n.closest('button, [role="button"]');
      if (ctrl && ctrl.getAttribute('role') !== 'tab') continue;
      adopt(n);
    }
  }

  // ---------- 视口观察：进视口（含下方 1 屏预取）→ 节流上报待译 ----------
  function flushNeed() {
    state.needTimer = 0;
    if (!state.needBuf.length || !state.port || state.disconnected) return;
    const items = state.needBuf.splice(0, state.needBuf.length);
    try {
      state.port.postMessage({ type: 'om:tx_need', items, total: state.blocks.size });
    } catch { /* 编排端已断开：丢弃本批，等重新连接 */ }
  }

  function scheduleNeed(id, text, node) {
    if (state.requested.has(id)) return;
    state.requested.add(id);
    node.classList.add('om-tx-wait');
    state.needBuf.push({ id, text });
    if (!state.needTimer) state.needTimer = setTimeout(flushNeed, 150);
  }

  function ensureObserver() {
    if (state.observer) return;
    state.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const id = Number(en.target.getAttribute('data-om-tx'));
        const rec = state.blocks.get(id);
        if (!rec || state.translations.has(id) || state.failed.has(id) || state.requested.has(id)) {
          state.observer?.unobserve(en.target);
          continue;
        }
        // 可见性只卡「未渲染」（display:none）：IO 只在几何量变化时回调，opacity/visibility
        // 变化不会再触发——淡入弹层/悬停菜单若因 opacity:0 被扣下，就永远等不到第二次回调
        // （弹框弹出后不自动翻译即此）。淡入中的块直接上报，译文落在透明容器里，展开即见；
        // display:none 的块没有几何量本就进不了回调，展开后 IO 自然补发
        if (typeof en.target.checkVisibility === 'function' && !en.target.checkVisibility()) continue;
        state.observer?.unobserve(en.target);
        scheduleNeed(id, rec.text, rec.node);
      }
    }, { rootMargin: '0px 0px 100% 0px' }); // 下方 1 屏预取：滚动到达前先开译
  }

  function ensureMo() {
    if (state.mo) return;
    let t = 0;
    let pending = []; // 去抖窗口内累计的插入节点，去抖只延后处理、不丢弃
    state.mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) if (n.nodeType === 1) pending.push(n);
      }
      if (!pending.length) return;
      clearTimeout(t);
      t = setTimeout(() => {
        const nodes = pending;
        pending = [];
        if (!state.started) return;
        for (const n of nodes) {
          if (n.isConnected === false) continue;
          if (n.matches?.(SELECTOR) && !n.querySelector(SELECTOR)) adopt(n);
          else if (n.querySelectorAll) discover(n);
        }
      }, 500);
    });
    state.mo.observe(document.body, { childList: true, subtree: true });
  }

  // ---------- DOM 定位 ----------
  const nodeOf = (id) => document.querySelector(`[data-om-tx='${id}']`);

  function remember(id, node) {
    if (!state.originals.has(id)) {
      // innerHTML 快照：沉浸模式整块替换为纯译文会清掉行内元素（链接/代码），
      // 还原/切回对照时按快照恢复原标记
      state.originals.set(id, { node, html: node.innerHTML });
    }
  }

  // 把块还原到收录时的原始标记（对照模式插入的译文节点由调用方先行移除）
  function restoreMarkup(rec) {
    if (rec.node.isConnected && rec.node.innerHTML !== rec.html) rec.node.innerHTML = rec.html;
  }

  function clearApplied(id) {
    const rec = state.originals.get(id);
    if (!rec) return;
    // 对照模式插入的兄弟/内部节点
    for (const n of rec.node.parentElement?.querySelectorAll(`[data-om-tx-dst='${id}']`) || []) n.remove();
    for (const n of rec.node.querySelectorAll(`[data-om-tx-dst='${id}']`)) n.remove();
    // 沉浸模式替换的文本（含被清掉的行内标记，按快照恢复）
    restoreMarkup(rec);
    rec.node.classList.remove('om-tx-failed', 'om-tx-wait');
  }

  // ---------- 回填 ----------
  function applyBilingual(id, text) {
    const rec = state.originals.get(id);
    const node = rec.node;
    if (!node.isConnected) return false;
    restoreMarkup(rec); // 从沉浸切回时先还原原标记
    let dst = document.querySelector(`[data-om-tx-dst='${id}']`) || node.parentElement?.querySelector(`[data-om-tx-dst='${id}']`);
    for (const n of node.querySelectorAll(`[data-om-tx-dst='${id}']`)) dst = n;
    if (!dst) {
      dst = document.createElement(node.tagName === 'TD' || node.tagName === 'TH' || node.tagName === 'LI' ? 'div' : node.tagName === 'BLOCKQUOTE' ? 'p' : 'div');
      dst.className = 'om-tx-dst';
      dst.setAttribute('data-om-tx-dst', String(id));
      // 格子型宿主（td/th/li/blockquote、ARIA 表格格子）译文放进格子内部，其余插为兄弟——
      // 表格行/ARIA 行是表格或网格布局，译文插成兄弟会多出一列、把整行挤乱
      const role = node.getAttribute('role');
      if (node.tagName === 'TD' || node.tagName === 'TH' || node.tagName === 'LI' || node.tagName === 'BLOCKQUOTE'
        || role === 'cell' || role === 'gridcell' || role === 'rowheader' || role === 'columnheader') {
        node.appendChild(dst);
      } else {
        node.parentElement?.insertBefore(dst, node.nextSibling);
      }
    }
    dst.textContent = text;
    return true;
  }

  function applyImmersive(id, text) {
    const rec = state.originals.get(id);
    if (!rec.node.isConnected) return false;
    for (const n of rec.node.parentElement?.querySelectorAll(`[data-om-tx-dst='${id}']`) || []) n.remove();
    rec.node.textContent = text; // 整块替换为纯译文；原标记在还原时按快照恢复
    return true;
  }

  function applyItem(id, text) {
    const node = nodeOf(id);
    if (!node) return false;
    remember(id, node);
    node.classList.remove('om-tx-wait');
    state.translations.set(id, text);
    return state.mode === 'immersive' ? applyImmersive(id, text) : applyBilingual(id, text);
  }

  function reapplyAll() {
    for (const [id, text] of state.translations) {
      const rec = state.originals.get(id);
      if (!rec) continue;
      // 先还原到原始态，再按新模式铺一遍
      for (const n of rec.node.parentElement?.querySelectorAll(`[data-om-tx-dst='${id}']`) || []) n.remove();
      for (const n of rec.node.querySelectorAll(`[data-om-tx-dst='${id}']`)) n.remove();
      restoreMarkup(rec);
      if (state.mode === 'immersive') rec.node.textContent = text;
      else applyBilingual(id, text);
    }
  }

  // ---------- 还原与清理 ----------
  function restore({ keepBall = false } = {}) {
    for (const id of state.originals.keys()) clearApplied(id);
    try { state.port?.postMessage({ type: 'om:tx_ended', reason: 'restored' }); } catch { /* 端口已断 */ }
    state.originals.clear();
    state.translations.clear();
    state.failed.clear();
    state.skipped.clear();
    state.requested.clear();
    state.blocks.clear();
    state.nextId = 0;
    state.appliedCnt = 0;
    state.needBuf = [];
    document.querySelectorAll('[data-om-tx]').forEach((n) => {
      // originals 里没核销到的块（SPA 换节点、中途失败）按快照兜底还原
      const orig = n.getAttribute('data-om-tx-orig');
      if (orig != null && n.innerHTML !== orig) n.innerHTML = orig;
      n.removeAttribute('data-om-tx');
      n.removeAttribute('data-om-tx-orig');
      n.classList.remove('om-tx-wait', 'om-tx-failed');
    });
    state.observer?.disconnect();
    state.observer = null;
    state.mo?.disconnect();
    state.mo = null;
    if (state.urlTimer) { clearInterval(state.urlTimer); state.urlTimer = 0; }
    if (state.ballDoneTimer) { clearTimeout(state.ballDoneTimer); state.ballDoneTimer = 0; }
    window.removeEventListener('popstate', onNav);
    window.removeEventListener('hashchange', onNav);
    if (!keepBall) destroyBall();
    try { window.dispatchEvent(new CustomEvent('om:tx-active', { detail: false })); } catch { /* 页面环境异常时忽略 */ }
    notifyState({ translated: false, running: false });
    state.finished = false;
    state.started = false;
    state.disconnected = false;
    state.port = null;
  }

  function onNav() {
    if (!state.urlTimer) return;
    const url = location.href;
    if (url !== state.startUrl) restore();
    else if (state.ball) setBallState('done');
  }

  // ---------- 浮球 ----------
  function ensureBall() {
    if (state.ball) return state.ball;
    // 扩展重载后旧 isolated world 的浮球 DOM 还留在页面上（新世界看不见旧 JS 引用），
    // 先移除再建，否则双球并存
    document.getElementById('om-tx-ball-host')?.remove();
    const host = document.createElement('div');
    host.id = 'om-tx-ball-host';
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:120px;z-index:2147483646;width:44px;height:44px;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'closed' });
    const purple = getComputedStyle(host).color.trim() || '';
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .ball {
          width: 44px; height: 44px; border-radius: 50%;
          background: #6841ea; cursor: pointer; position: relative;
          box-shadow: 0 4px 16px rgba(0,0,0,.24);
          display: flex; align-items: center; justify-content: center;
          font: 600 11px/1 system-ui, sans-serif; color: #fff;
          user-select: none; -webkit-user-select: none;
        }
        .ball:hover { transform: scale(1.05); }
        .ball.gray { background: #8a8a92; }
        .ball svg.ring { position: absolute; inset: -4px; width: 52px; height: 52px; transform: rotate(-90deg); pointer-events: none; }
        .ring circle { fill: none; stroke-width: 3; }
        .ring .bg { stroke: rgba(255,255,255,.25); }
        .ring .fg { stroke: #fff; stroke-linecap: round; transition: stroke-dashoffset .3s; }
        .menu {
          position: absolute; right: 0; bottom: 52px; min-width: 128px;
          background: #fff; color: #262626; border-radius: 12px; overflow: hidden;
          box-shadow: 0 8px 32px rgba(0,0,0,.2);
          font: 13px/1.4 system-ui, sans-serif; display: none;
        }
        .menu.open { display: block; }
        .menu button {
          display: block; width: 100%; text-align: left; border: none; background: none;
          padding: 9px 14px; font: inherit; color: inherit; cursor: pointer;
        }
        .menu button:hover { background: #f5f5f5; }
        .menu button.on { color: #6841ea; font-weight: 600; }
        .menu hr { border: none; border-top: 1px solid rgba(79,89,102,.12); margin: 0; }
        @media (prefers-color-scheme: dark) {
          .menu { background: #2d2d2f; color: #f3f3f3; }
          .menu button:hover { background: rgba(243,243,243,.06); }
          .menu hr { border-top-color: rgba(86,86,95,.32); }
          .menu button.on { color: #9880f8; }
        }
      </style>
      <div class="ball" part="ball">
        <span class="label"></span>
        <svg class="ring" viewBox="0 0 52 52">
          <circle class="bg" cx="26" cy="26" r="23"></circle>
          <circle class="fg" cx="26" cy="26" r="23" stroke-dasharray="144.5" stroke-dashoffset="144.5"></circle>
        </svg>
      </div>
      <div class="menu">
        <button data-act="bilingual">对照模式</button>
        <button data-act="immersive">沉浸模式</button>
        <hr />
        <button data-act="restore">还原原文</button>
        <button data-act="close">关闭</button>
      </div>`;
    const ball = root.querySelector('.ball');
    const label = root.querySelector('.label');
    const ringFg = root.querySelector('.ring .fg');
    const menu = root.querySelector('.menu');
    const btnBi = root.querySelector('[data-act="bilingual"]');
    const btnIm = root.querySelector('[data-act="immersive"]');
    ball.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    menu.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      menu.classList.remove('open');
      if (act === 'bilingual' || act === 'immersive') {
        state.mode = act;
        reapplyAll();
        syncMenu();
      } else if (act === 'restore') {
        restore({ keepBall: false });
      } else if (act === 'close') {
        state.port?.postMessage({ type: 'om:tx_error', message: '用户关闭翻译', fatal: true });
        restore({ keepBall: false });
      }
    });
    document.addEventListener('click', () => menu.classList.remove('open'), true);
    state.ball = {
      host, root, ball, label, ringFg, menu, btnBi, btnIm,
      purple: purple || '#6841ea',
    };
    syncMenu();
    setBallState('loading');
    return state.ball;
  }

  function syncMenu() {
    if (!state.ball) return;
    state.ball.btnBi.classList.toggle('on', state.mode === 'bilingual');
    state.ball.btnIm.classList.toggle('on', state.mode === 'immersive');
  }

  function setBallState(kind, detail) {
    const b = state.ball;
    if (!b) return;
    b.menu.classList.remove('open');
    if (kind === 'loading') {
      b.ball.classList.remove('gray');
      b.label.textContent = '…';
      b.ringFg.style.strokeDashoffset = '144.5';
    } else if (kind === 'progress') {
      b.ball.classList.remove('gray');
      b.label.textContent = `${detail.pct}%`;
      b.ringFg.style.strokeDashoffset = String(144.5 * (1 - detail.pct / 100));
    } else if (kind === 'done') {
      b.ball.classList.remove('gray');
      b.label.textContent = state.mode === 'immersive' ? '译' : '双';
      b.ringFg.style.strokeDashoffset = '0';
    } else if (kind === 'disconnected') {
      b.ball.classList.add('gray');
      b.label.textContent = '译';
    }
    if (detail?.failed) b.label.textContent = `${state.mode === 'immersive' ? '译' : '双'}!`;
  }

  function destroyBall() {
    if (!state.ball) return;
    state.ball.host.remove();
    state.ball = null;
  }

  // ---------- 状态广播（页面浮窗监听：translated=已翻译可还原，running=翻译进行中） ----------
  function notifyState(detail) {
    try { window.dispatchEvent(new CustomEvent('om:tx-state', { detail })); } catch { /* 页面环境异常时忽略 */ }
  }

  // ---------- Port 协议 ----------
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'om-tx') return;
    state.port = port;
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'om:tx_start': {
          state.mode = msg.mode || 'bilingual';
          console.info('[Vela] bridge 启动翻译：mode =', state.mode);
          state.finished = false;
          state.disconnected = false;
          state.started = true;
          state.startUrl = location.href;
          // 残留清扫：bridge 重新注入（尤其扩展重载后旧实例 state 已丢）时，
          // 上一轮的译文节点/打标可能还留在页面上，不清掉会与新译文叠加成两份。
          // 沉浸式残留是 textContent 替换，删标记回不来：按 DOM 快照还原原文，
          // 否则新实例把中文当原文再译一遍，还原也只会还出中文
          document.querySelectorAll('.om-tx-dst').forEach((n) => n.remove());
          document.querySelectorAll('[data-om-tx]').forEach((n) => {
            const orig = n.getAttribute('data-om-tx-orig');
            if (orig != null && n.innerHTML !== orig) n.innerHTML = orig;
            n.removeAttribute('data-om-tx');
            n.removeAttribute('data-om-tx-orig');
            n.classList.remove('om-tx-wait', 'om-tx-failed');
          });
          ensureBall();
          ensureObserver();
          discover();
          if (!state.blocks.size) {
            // 没有可译块：致命收场，别让浮球停在加载态
            port.postMessage({ type: 'om:tx_error', message: '页面上没有找到可翻译的文本块', fatal: true });
            restore({ keepBall: false });
            break;
          }
          ensureMo();
          try { window.dispatchEvent(new CustomEvent('om:tx-active', { detail: true })); } catch { /* 忽略 */ }
          notifyState({ translated: true, running: true });
          // SPA 守卫：URL 变化自动还原
          window.removeEventListener('popstate', onNav);
          window.removeEventListener('hashchange', onNav);
          window.addEventListener('popstate', onNav);
          window.addEventListener('hashchange', onNav);
          if (state.urlTimer) clearInterval(state.urlTimer);
          state.urlTimer = setInterval(onNav, 1500);
          port.postMessage({ type: 'om:tx_ready', total: state.blocks.size });
          break;
        }
        case 'om:tx_batch': {
          // done 之后滚动触发新一批：回到进行中态
          if (state.finished) {
            state.finished = false;
            if (state.ballDoneTimer) { clearTimeout(state.ballDoneTimer); state.ballDoneTimer = 0; }
            ensureBall(); // 完成态浮球可能已延时收场，新批次要重建
            setBallState('loading');
            notifyState({ translated: true, running: true });
          }
          const appliedIds = [];
          const failedIds = [];
          for (const it of msg.items) {
            if (it.text == null) {
              state.failed.add(it.id);
              state.blocks.get(it.id)?.node.classList.remove('om-tx-wait');
              state.blocks.get(it.id)?.node.classList.add('om-tx-failed');
              failedIds.push(it.id);
              continue;
            }
            if (applyItem(it.id, it.text)) { appliedIds.push(it.id); state.appliedCnt += 1; }
            else failedIds.push(it.id);
          }
          const settled = state.appliedCnt + state.failed.size + state.skipped.size;
          if (state.requested.size) {
            setBallState('progress', { pct: Math.min(99, Math.round((settled / state.requested.size) * 100)) });
          }
          port.postMessage({ type: 'om:tx_batch_applied', appliedIds, failedIds });
          break;
        }
        case 'om:tx_progress': {
          if (msg.phase === 'done') {
            // 已请求的全部落定才置 done；新内容上报会经 om:tx_batch 重新激活
            if (state.requested.size && state.appliedCnt + state.failed.size + state.skipped.size >= state.requested.size) {
              state.finished = true;
              setBallState('done', { failed: state.failed.size });
              notifyState({ translated: true, running: false });
              // 完成态浮球只停留 3 秒：还原/切模式由浮窗按钮（✓）和设置齿轮承接，
              // 常驻的「双/译」球和浮窗并存反而像残留
              state.ballDoneTimer = setTimeout(() => {
                state.ballDoneTimer = 0;
                destroyBall();
              }, 3000);
            }
          } else if (msg.phase === 'translating') {
            setBallState('progress', { pct: Math.round(msg.pct || 0) });
          }
          break;
        }
        case 'om:tx_set_mode': {
          state.mode = msg.mode;
          reapplyAll();
          syncMenu();
          if (state.finished) {
            if (state.ballDoneTimer) { clearTimeout(state.ballDoneTimer); state.ballDoneTimer = 0; }
            ensureBall();
            setBallState('done', { failed: state.failed.size });
          }
          break;
        }
        case 'om:tx_skip': {
          // 编排端按上限拒收的块：撤掉「翻译中」标记并计为落定（不计失败红点）；
          // 留在 requested 里，避免观察器再上报 → 再拒收的死循环
          for (const id of msg.ids || []) {
            const b = state.blocks.get(id);
            if (!b || !state.requested.has(id)) continue;
            state.skipped.add(id);
            b.node.classList.remove('om-tx-wait');
          }
          break;
        }
        case 'om:tx_cancel':
        case 'om:tx_restore':
          restore({ keepBall: false });
          break;
        default:
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      state.disconnected = true;
      // 译完后编排页收场：还原由浮窗按钮（✓）承接，浮球直接撤掉；
      // 译到一半断开：浮球变灰保留，本地还原仍可用
      if (state.finished) destroyBall();
      else {
        setBallState('disconnected');
        // 中断收场：在途块的「翻译中」标记不会再有结果，撤掉防永久闪烁（已译文保留）
        document.querySelectorAll('[data-om-tx].om-tx-wait').forEach((n) => n.classList.remove('om-tx-wait'));
      }
    });
  });

  // 页面浮窗「翻译此页」按钮再点一次 = 还原原文（与浮球菜单同路径，同 ISOLATED world 直达）
  window.addEventListener('om:tx-restore', () => restore({ keepBall: false }));
  // 浮窗设置齿轮就地切模式：已收录译文直接按新模式重铺，无需重译。
  // 未启动时也先记住模式，镜像态失真（如中途失败被复位）不挡住切换
  window.addEventListener('om:tx-mode', (ev) => {
    if (!ev.detail) return;
    state.mode = ev.detail;
    if (!state.started) return;
    reapplyAll();
    syncMenu();
  });

  // isActive：浮窗按钮的 txTranslated 镜像可能失真（中途失败被复位），还原开关以实况为准
  window.__omTxBridge = { reset: () => restore({ keepBall: false }), isActive: () => state.started };
})();
