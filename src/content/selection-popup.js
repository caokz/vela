// 划词悬浮工具条（Monica 式）：选中网页文字后弹出，提供高亮 / 翻译 / 总结 / 快速提问。
// 选中内容在 <pre>/<code> 里时切换成「解释代码」单项。与 widget.js 同 world 注册（经典 IIFE，禁 import）。
// 翻译/总结/解释代码不走聊天卡：就地开 sel-panel 面板（扩展源 iframe 直调 LLM 流式渲染），
// 面板里的「追问」才转 agent（经 SW 写 pendingTask 回开聊天卡）。
// 另有代码块 hover 胶囊（解释 + 复制）：无需选中，悬停 <pre> 右上角出现。
// 高亮是本地 DOM 动作：选区 Range 在弹出时克隆缓存，点击动作不依赖活选区
// （真实点击瞬间浏览器可能清掉选区，getRangeAt 会抛异常——这是旧版「点了没反应」的根因）。
(() => {
  'use strict';
  if (window.__omSelPopup) {
    // 扩展重载后旧脚本上下文失效：工具条残留但收不到消息，检测后摘掉重铺。
    // 判活：失效上下文里 chrome.runtime.id 是 undefined 而不是抛错（旧版 try/catch 永远判活，
    // 补注直接 return，旧工具条一直残留、动作报「扩展未响应」）；隔离世界复用时
    // chrome.runtime 也可能换成新对象，旧实例记下的 runtime 引用对不上同样视为失效
    let alive = false;
    try { alive = !!chrome.runtime?.id && window.__omSelPopup.rt === chrome.runtime; } catch { /* 上下文已失效 */ }
    if (alive) return;
    try { window.__omSelPopup.dispose?.(); } catch { /* 旧版本无 dispose */ }
    window.__omSelPopup.host?.remove();
    window.__omSelPopup = null;
  }

  // 页面级监听统一挂 AbortSignal，并在每次触发时自检：扩展重载/更新后新实例跑在新的隔离世界，
  // 看不到也摘不掉本实例；本实例的上下文已失效（chrome.runtime.id 变 undefined）时自行注销，
  // 否则旧监听继续在每次划词时弹出一个点了只报「扩展未响应」的死工具条，与新工具条叠在一起
  const lifetime = new AbortController();
  const extAlive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  function on(target, type, fn, opt) {
    const o = typeof opt === 'boolean' ? { capture: opt } : { ...(opt || {}) };
    target.addEventListener(type, (e) => {
      if (!extAlive()) { api.dispose(); return; }
      fn(e);
    }, { ...o, signal: lifetime.signal });
  }

  const HOST_ID = 'om-sel-host';
  const PANEL_ID = 'om-sel-panel-host';
  const CBTN_ID = 'om-sel-cbtn-host';
  const HBTN_ID = 'om-sel-hlbtn-host';
  // 与 SW 侧 quick-action 截断上限一致（widget.js 旧管线是 2000，划词语境放宽到 8000）
  const MAX_TEXT = 8000;
  // 版本可见标记：MV3 扩展刷新后旧标签页里的 content script 仍是旧代码（要整页重载才换新）。
  // 控制台日志 + 工具条/胶囊 title 都带版本号，验收时一眼确认跑的是不是新版
  const VER = chrome.runtime.getManifest().version;

  // 与 widget.js ICONS 同风格的原创线性图标
  const ICONS = {
    hl: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    translate: '<path d="M3 5h9M7.5 5c0 4.5-2 8.5-4.5 10.5M4.5 9.5c1.6 3 4 5.2 7 6"/><path d="M12.5 19.5l4-10 4 10M14 16.5h5"/>',
    summary: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    ask: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 1 1 16.1-3.8z"/>',
    code: '<path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  };

  // 剪贴板兜底：宿主页用 Permissions-Policy 头禁掉 Clipboard API 时退回 execCommand
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch { /* 走兜底 */ }
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

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

  // 扩展重载后旧页面的运行时已失效：sendMessage 同步抛错或永不回调，统一按无响应落定
  function send(msg, onRes) {
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; onRes?.(res); } };
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        done(res);
      });
    } catch { done(undefined); }
    setTimeout(() => done(undefined), 2500);
  }

  // 选区锚点/焦点所在的元素（文本节点取父元素）
  function nodeEl(n) {
    return n?.nodeType === 1 ? n : n?.parentElement ?? null;
  }

  function ownUi(el) {
    return !!el?.closest(`#om-widget-host, #om-card-host, #om-tx-runner-host, #om-sel-host, ${PANEL_ID}, ${CBTN_ID}, ${HBTN_ID}`);
  }

  function editableOrOwnUi(el) {
    return !!el?.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
    ) || ownUi(el);
  }

  // 采集当前选区并克隆 Range：后续动作（高亮等）全用克隆，不依赖活选区
  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const text = sel.toString().replace(/​/g, '').trim();
    if (!text) return null;
    const anchorEl = nodeEl(sel.anchorNode);
    const focusEl = nodeEl(sel.focusNode);
    if (editableOrOwnUi(anchorEl) || editableOrOwnUi(focusEl)) return null;
    // 代码选区：两端都落在同一个 <pre>（块级代码）才算。行内 <code> 是普通正文的一部分，
    // 选中含行内代码的句子应弹 4 钮（翻译/总结），不能误判成「解释代码」
    const preA = anchorEl?.closest('pre') ?? null;
    const codeEl = preA && preA === focusEl?.closest('pre') ? preA : null;
    const ranges = [];
    for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
    return { text, rect: sel.getRangeAt(0).getBoundingClientRect(), code: !!codeEl, ranges, anchorEl, focusEl };
  }

  // ---------- 本地高亮（Monica 式荧光笔 + 悬停工具条） ----------
  // 4 色荧光笔：默认黄。span 上 data-c 记当前色，悬停胶囊可换色/复制/提问/删除。
  const HL_COLORS = {
    y: { bg: 'rgba(255,222,89,.6)', name: '黄色' },
    g: { bg: 'rgba(96,220,140,.5)', name: '绿色' },
    b: { bg: 'rgba(88,178,255,.5)', name: '蓝色' },
    p: { bg: 'rgba(255,128,214,.5)', name: '粉色' },
  };

  function ensureHlStyle() {
    if (document.getElementById('om-hl-style')) return;
    const st = document.createElement('style');
    st.id = 'om-hl-style';
    st.textContent = `
.om-hl{background-color:${HL_COLORS.y.bg};background-image:linear-gradient(${HL_COLORS.y.bg},${HL_COLORS.y.bg});border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone;forced-color-adjust:none;}
.om-hl[data-c="g"]{background-color:${HL_COLORS.g.bg};background-image:linear-gradient(${HL_COLORS.g.bg},${HL_COLORS.g.bg})}
.om-hl[data-c="b"]{background-color:${HL_COLORS.b.bg};background-image:linear-gradient(${HL_COLORS.b.bg},${HL_COLORS.b.bg})}
.om-hl[data-c="p"]{background-color:${HL_COLORS.p.bg};background-image:linear-gradient(${HL_COLORS.p.bg},${HL_COLORS.p.bg})}`;
    (document.head || document.documentElement).appendChild(st);
  }

  // 颜色三保险：class + 页内 <style> + 内联样式（CSSOM 赋值不受页面 CSP 限制）。
  // 内联侧 background-color 与同色 background-image（linear-gradient）双写：只按
  // background-color 长手覆盖的样式（深色类扩展的常见改法，含 !important）压不住
  // background-image 链路，任一头活着就显色。注意 Chrome 自动深色
  // （WebContentsForceDark）会把两层一起深色化，双写救不了它（verify-hl-forcedark
  // 实测：黄被画成暗琥珀，仍可辨但变暗）。曾按内联色修过「span 在但整片失色」的报障。
  function applyHlColor(span, key) {
    const c = HL_COLORS[key] || HL_COLORS.y;
    span.style.backgroundColor = c.bg;
    span.style.backgroundImage = `linear-gradient(${c.bg}, ${c.bg})`;
    span.style.forcedColorAdjust = 'none'; // Windows 高对比度（forced-colors）下保住背景色
  }

  // 增强绘制（0.7.10 像素终验失败时启用）：box-shadow inset 与 outline 是独立于 background
  // 的绘制层，只按 background-color/-image 下手的覆盖（深色类扩展常见改法）压不住它们；
  // 内联 !important 又压过页面样式表的 !important。
  function escalateHlPaint(span) {
    if (span.dataset.hlBoost) return;
    span.dataset.hlBoost = '1';
    const c = HL_COLORS[span.dataset.c || 'y'];
    span.style.cssText += `;box-shadow:inset 0 0 0 999px ${c.bg} !important;outline:2px solid ${c.bg} !important;outline-offset:-2px;`;
  }

  // 摘掉单个高亮 span：子节点提回父级后 normalize 合并被切分的文本节点
  function unwrapSpan(s) {
    const p = s.parentNode;
    if (!p) return;
    while (s.firstChild) p.insertBefore(s.firstChild, s);
    p.removeChild(s);
    p.normalize?.();
  }

  function unwrapHighlights(range) {
    const spans = [...document.querySelectorAll('.om-hl')].filter((s) => range.intersectsNode(s));
    hlSelfRemoved = spans.length > 0; // 自己删的不算外部移除（diagnoseHl 用）
    for (const s of spans) unwrapSpan(s);
    return spans.length;
  }

  // 已在高亮内的选区再点一次 = 取消；否则把每个 range 的内容包进 .om-hl span。
  // 全部走克隆 Range：点击瞬间活选区被清也能正常工作。
  // extractContents 天然处理跨节点切分，插回 span 后视觉连续（box-decoration-break:clone）
  function toggleHighlight(st) {
    ensureHlStyle();
    if (st.anchorEl?.closest('.om-hl') && st.focusEl?.closest('.om-hl')) {
      for (const r of st.ranges) unwrapHighlights(r);
      hideHlBtn();
      return;
    }
    hideHlBtn();
    let first = null;
    for (const range of st.ranges) {
      const wrap = document.createElement('span');
      wrap.className = 'om-hl';
      applyHlColor(wrap, 'y'); // 内联底色：默认黄
      try {
        wrap.appendChild(range.extractContents());
        range.insertNode(wrap);
        if (!first && wrap.isConnected && wrap.textContent.trim()) first = wrap;
      } catch { /* 跨特殊节点切不动就跳过这一段 */ }
    }
    // 即时反馈：高亮生成后直接挂出悬停胶囊（Monica 式），不用再悬停一次才能看到操作项
    if (first) { showHlBtn(first); diagnoseHl(first); }
  }

  // 应用后自检 + 持续监测 + 像素终验（0.7.10）。0.7.9 的全部检查都在 DOM/computed 层：
  // 用户报障取证（19.png）证明这些全绿——4 次应用、computed 黄、矩形一致、无遮挡、
  // 15s 监测零告警——截图时被高亮的文字原位正常显示而整页无任何高亮像素。失效发生在
  // DOM 检查看不到的绘制层。现在 400ms 首检（computed 底色/尺寸/遮挡/内联样式）通过后：
  // 1s×15s 监测移除/颜色覆盖（覆盖先自动修复最多 3 次）；700ms/5.2s/12s 三次像素终验——
  // SW 代截当前视口，canvas 按 span 矩形采样，未测到高亮色先增强绘制复验，仍无色才红
  // toast 报障；15s 之外由 MutationObserver 兜晚期移除。
  let hlSelfRemoved = false; // 用户经胶囊自己删除/取消不算外部移除
  let hlRepairs = 0;
  function diagnoseHl(span) {
    hlSelfRemoved = false;
    hlRepairs = 0;
    let driftLogged = false;
    const t0 = Date.now();
    const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);
    const norm = (v) => String(v || '').replace(/\s+/g, '').replace(/(^|[^\d])\./g, '$10.'); // '.6' → '0.6'，与 computed 归一成同一写法
    const wantBg = () => norm(HL_COLORS[span.dataset.c || 'y'].bg); // 胶囊换色后按新色监测
    const fail = (msg) => {
      try { console.warn(`[Vela] 高亮颜色未生效 v${VER} | ${msg}`); } catch { /* 页面禁 console */ }
      const t = document.createElement('div');
      t.id = 'om-hl-diag';
      t.textContent = `[Vela] 高亮颜色未生效：${msg}`;
      t.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:440px;padding:10px 14px;background:#2b1c1c;color:#ffb4ab;border:1px solid #f28b82;border-radius:8px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
      (document.body || document.documentElement).appendChild(t);
      setTimeout(() => t.remove(), 12000);
    };
    setTimeout(() => {
      if (!span.isConnected) { fail('高亮 span 生成后立刻被移除（疑似其他扩展改写了 DOM）'); return; }
      const cs = getComputedStyle(span);
      const bg = cs.backgroundColor;
      const r0 = span.getBoundingClientRect();
      if (!r0.width || !r0.height) { fail(`span 尺寸为 ${Math.round(r0.width)}x${Math.round(r0.height)}（display=${cs.display}）`); return; }
      const inlineOk = norm(span.style.backgroundColor) === wantBg() || norm(span.style.backgroundImage).includes(wantBg());
      if (norm(bg) !== norm('rgba(255, 222, 89, 0.6)')) { fail(`computed 背景=${bg}（期望 rgba(255, 222, 89, 0.6)），内联样式${inlineOk ? '在' : '丢失'} — 页面或其他扩展覆盖了颜色`); return; }
      // 遮挡判定按行盒逐个取中心点，任一行盒命中本高亮即算可见。不能取外接矩形中心：
      // 跨行高亮（第 1 行后半 + 第 2 行前半）的外接矩形中心落在段落里未高亮的文字上，
      // 命中的是父级 <p>，会误报「被 P 遮挡」（github README 上的真实报障）
      // 命中链跳过本扩展自己的浮层（悬停胶囊挂在首行下方，正好压在第 2 行上），取其下第一个页面元素
      const ownLayer = (el) => !!el?.closest?.('[id^="om-"]') && !el.closest('.om-hl');
      let hit = null;
      let visible = false;
      for (const rc of span.getClientRects()) {
        if (rc.width < 2 || rc.height < 2) continue;
        const el = document.elementsFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2).find((x) => !ownLayer(x));
        if (el && (el === span || el.closest('.om-hl') === span)) { visible = true; break; }
        hit = hit || el;
      }
      if (!visible && hit) { fail(`被 ${hit.tagName + (hit.id ? '#' + hit.id : '')} 遮挡，颜色画了但看不见`); return; }
      if (!inlineOk) { fail('内联底色丢失，仅剩样式表链路'); return; }
      try { console.info(`[Vela] 高亮已应用 v${VER} | 底色=${bg} 矩形=${Math.round(r0.width)}x${Math.round(r0.height)} 位置=(${Math.round(r0.left)},${Math.round(r0.top)})`); } catch { /* 页面禁 console */ }
      // 像素终验（0.7.10）：把「样式算了」升级成「屏幕画了」。截屏由 SW 代做（内容脚本
      // 无 captureVisibleTab 权限），dataUrl 画进 canvas 后按 span 视口矩形采样，按色相族
      // 判定（黄系覆盖白底合成 ≈(255,235,155) 与深底/强制深色的暗琥珀）。未测到色先增强
      // 绘制再复验一次，仍无色才红 toast——用户环境的真凶会在下一次截图里留下像素层结论。
      const colorPred = (key) => {
        if (key === 'g') return (r, g, b) => g - r > 25 && g - b > 18 && g > 120;
        if (key === 'b') return (r, g, b) => b - r > 30 && b - g > 18 && b > 120;
        if (key === 'p') return (r, g, b) => r - g > 30 && b - g > 18 && r > 120;
        return (r, g, b) => r - b > 35 && g - b > 20 && r > 40; // 黄系：白底≈(255,235,155)，暗琥珀≈(56,40,4)
      };
      const sampleRect = async () => {
        const r0 = span.getBoundingClientRect();
        if (r0.bottom < 0 || r0.top > window.innerHeight || r0.right < 0 || r0.left > window.innerWidth) return { skip: '高亮已滚出视口' };
        const shot = await new Promise((resolve) => send({ type: 'om:capture-visible-tab' }, (r) => resolve(r && r.ok ? r.dataUrl : null)));
        if (!shot) return { skip: '无法截屏' };
        const img = new Image();
        await new Promise((res2, rej2) => { img.onload = res2; img.onerror = rej2; img.src = shot; }); // 页面 CSP 拦 data: 图片时抛出走跳过
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth;
        cv.height = img.naturalHeight;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        const scale = img.naturalWidth / window.innerWidth;
        const x0 = Math.max(0, Math.round(r0.left * scale)), y0 = Math.max(0, Math.round(r0.top * scale));
        const x1 = Math.min(cv.width, Math.round(r0.right * scale)), y1 = Math.min(cv.height, Math.round(r0.bottom * scale));
        if (x1 - x0 < 8 || y1 - y0 < 8) return { skip: '矩形过小' };
        const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        const pred = colorPred(span.dataset.c || 'y');
        let hit = 0;
        for (let i = 0; i < d.length; i += 4) if (pred(d[i], d[i + 1], d[i + 2])) hit++;
        return { ratio: hit / (d.length / 4) };
      };
      const pixelCheck = async () => {
        if (!span.isConnected || document.visibilityState !== 'visible' || span.dataset.hlPix === 'ok') return;
        try {
          const s1 = await sampleRect();
          if (s1.skip) { try { console.info(`[Vela] 像素验证跳过（${s1.skip}）v${VER}`); } catch { /* 页面禁 console */ } return; }
          if (s1.ratio >= 0.05) {
            const from = span.dataset.hlPix;
            span.dataset.hlPix = 'ok';
            try { console.info(`[Vela] ${span.dataset.hlBoost ? '增强绘制后' : ''}像素验证通过（屏幕已测到高亮色）${from === 'fail' ? '，已从报障恢复' : ''} v${VER} | 占比=${(s1.ratio * 100).toFixed(1)}%`); } catch { /* 页面禁 console */ }
            return;
          }
          escalateHlPaint(span);
          await new Promise((r2) => setTimeout(r2, 400));
          if (!span.isConnected) return;
          const s2 = await sampleRect();
          if (s2.ratio !== undefined && s2.ratio >= 0.05) {
            if (span.dataset.hlPix !== 'ok') {
              span.dataset.hlPix = 'boost-ok';
              try { console.warn(`[Vela] 屏幕像素一度未测到高亮色，已增强绘制（box-shadow/outline 层）后恢复显色 v${VER} | 占比=${(s2.ratio * 100).toFixed(1)}%`); } catch { /* 页面禁 console */ }
            }
            return;
          }
          if (span.dataset.hlPix === 'fail') return;
          span.dataset.hlPix = 'fail';
          fail('屏幕像素未测到高亮色（DOM 样式正常，增强绘制无效）— 疑似页面或其他扩展拦截绘制，请截图此提示与控制台反馈');
          try { console.warn(`[Vela] 像素验证失败 v${VER} | 屏幕未测到高亮色（占比=${((s2.ratio ?? s1.ratio) * 100).toFixed(1)}%），DOM 样式正常，已增强绘制仍无效 — 疑似页面或其他扩展拦截绘制`); } catch { /* 页面禁 console */ }
        } catch {
          try { console.info(`[Vela] 像素验证跳过（页面限制）v${VER}`); } catch { /* 页面禁 console */ }
        }
      };
      setTimeout(pixelCheck, 700);
      setTimeout(pixelCheck, 5200);
      setTimeout(pixelCheck, 12000);
      const iv = setInterval(() => {
        if (hlSelfRemoved) { clearInterval(iv); return; }
        if (!span.isConnected) { clearInterval(iv); fail(`${elapsed()} 秒后高亮 span 被移除（疑似其他扩展重建了段落，如翻译/阅读类扩展）`); return; }
        const rr = span.getBoundingClientRect();
        if (!driftLogged && (rr.bottom < 0 || rr.top > window.innerHeight)) {
          driftLogged = true;
          try { console.info(`[Vela] ${elapsed()} 秒后高亮已滚出视口（span 在 DOM、颜色正常，滚动所致，非故障）`); } catch { /* 页面禁 console */ }
        }
        if (norm(getComputedStyle(span).backgroundColor) === wantBg()) return;
        if (hlRepairs >= 3) { clearInterval(iv); fail(`${elapsed()} 秒后颜色仍被覆盖（已自动修复 ${hlRepairs} 次无效，computed 背景=${getComputedStyle(span).backgroundColor}）`); return; }
        hlRepairs++;
        ensureHlStyle(); // 页内样式表链路可能被移除，一并补回
        applyHlColor(span, span.dataset.c || 'y');
        try { console.warn(`[Vela] ${elapsed()} 秒后高亮颜色被外部覆盖，已自动重写修复（第 ${hlRepairs} 次）`); } catch { /* 页面禁 console */ }
      }, 1000);
      setTimeout(() => clearInterval(iv), 15500);
      // 15s 监测期外的晚期移除兜底（0.7.10）：只盯本 span 的祖先链摘除，命中即带时间戳
      // 报障留证（自己经胶囊删除/取消有 hlSelfRemoved 护栏）
      setTimeout(() => {
        if (!span.isConnected || hlSelfRemoved) return;
        const ob = new MutationObserver((muts) => {
          if (hlSelfRemoved) { ob.disconnect(); return; }
          for (const m of muts) for (const n of m.removedNodes) {
            if (n === span || (n.nodeType === 1 && n.contains?.(span))) {
              ob.disconnect();
              fail(`${elapsed()} 秒后高亮 span 被移除（疑似其他扩展重建了段落，如翻译/阅读类扩展）`);
              return;
            }
          }
        });
        ob.observe(document.documentElement, { childList: true, subtree: true });
      }, 16000);
    }, 400);
  }

  // ---------- 工具条本体 ----------
  let host = null;
  let root = null;
  const api = {
    host: null,
    rt: chrome.runtime, // 补注时判断本实例是否属于当前扩展上下文
    refresh: () => show(), // refresh 供测试与程序化触发
    // 被新实例替换：摘掉页面级监听与本实例挂出的全部 UI（已生成的高亮 span 保留）
    dispose: () => {
      lifetime.abort();
      destroy();
      hideCodeBtn();
      hideHlBtn();
      closePanel();
    },
    // 调试口（隔离世界可见）：测试/排障用
    hlState: () => ({ pill: !!hlBtnHost, span: !!hlBtnSpan, hl: document.querySelectorAll('.om-hl').length }),
    showHlOnFirst: () => { const s = document.querySelector('.om-hl'); if (s) showHlBtn(s); return !!hlBtnHost; },
  };

  function destroy() {
    host?.remove();
    host = null;
    root = null;
    api.host = null;
  }

  function build(codeMode, hlOn) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.title = `Vela 划词工具条 v${VER}`;
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483645;';
    root = host.attachShadow({ mode: 'open' }); // open：便于测试与用户调试
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          display: flex; align-items: center; gap: 2px;
          background: #212227; border-radius: 10px; padding: 4px;
          box-shadow: 0 6px 20px rgba(0,0,0,.32);
          font: 12px/1 system-ui, "Segoe UI", sans-serif;
          animation: om-sel-in .12s ease;
        }
        @keyframes om-sel-in { from { transform: translateY(3px); opacity: 0; } }
        button {
          border: none; cursor: pointer; background: none; color: #fff;
          width: 30px; height: 30px; border-radius: 7px; padding: 0;
          display: flex; align-items: center; justify-content: center;
          transition: background .1s ease;
        }
        button:hover { background: #2c2d33; }
        button:active { transform: scale(.94); }
        button.on { background: rgba(255,222,89,.22); color: #ffe05a; }
        .wide {
          width: auto; padding: 0 12px; gap: 6px;
          font: 600 12px/1 system-ui, "Segoe UI", sans-serif;
        }
        @media (prefers-color-scheme: dark) { .bar { background: #2d2d2f; } button:hover { background: #3a3a3d; } }
      </style>
      <div class="bar"></div>`;
    const bar = root.querySelector('.bar');
    if (codeMode) {
      const btn = document.createElement('button');
      btn.className = 'wide';
      btn.dataset.act = 'explain-code';
      btn.title = '解释这段代码';
      btn.appendChild(svg('code', 15));
      btn.appendChild(document.createTextNode('解释代码'));
      bar.appendChild(btn);
    } else {
      for (const [act, icon, title] of [
        ['highlight', 'hl', '高亮（再点已高亮内容可取消）'],
        ['translate', 'translate', '翻译选中文字'],
        ['summary', 'summary', '总结选中文字'],
        ['ask', 'ask', '快速提问：带上选中内容向 AI 提问'],
      ]) {
        const btn = document.createElement('button');
        btn.dataset.act = act;
        btn.title = title;
        if (act === 'highlight' && hlOn) btn.classList.add('on');
        btn.appendChild(svg(icon, 16));
        bar.appendChild(btn);
      }
    }
    // 按下不抢焦点/不清选区。必须拦 mousedown 而非 pointerdown：
    // 取消 pointerdown 会按规范抑制后续兼容性鼠标事件（含 click），真实点击全部失灵
    bar.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.addEventListener('click', onClick);
    document.documentElement.appendChild(host);
    api.host = host;
  }

  function place(rect) {
    const bar = root.querySelector('.bar');
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    let x = rect.left + rect.width / 2 - w / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    let y = rect.bottom + 8;
    if (y + h > window.innerHeight - 8) y = rect.top - h - 8; // 下方放不下翻到选区上方
    if (y < 8) y = 8;
    host.style.left = `${Math.round(x)}px`;
    host.style.top = `${Math.round(y)}px`;
  }

  function onClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const st = lastState;
    destroy(); // 动作一经触发先收工具条，选区已在弹出时克隆缓存
    if (!st) return;
    const act = btn.dataset.act;
    if (act === 'highlight') {
      toggleHighlight(st);
      try { window.getSelection()?.removeAllRanges(); } catch { /* 选区已不存在 */ }
      return;
    }
    if (act === 'ask') {
      send({ type: 'om:widget-action', kind: 'ask', selection: st.text.slice(0, MAX_TEXT), from: 'sel-popup' }, onActionRes);
      return;
    }
    // 翻译 / 总结 / 解释代码：就地面板（直调 LLM），不开聊天卡
    const panelAct = act === 'translate' ? 'translate' : act === 'summary' ? 'summary' : 'explain';
    openPanel(panelAct, st.text.slice(0, MAX_TEXT), st.rect);
  }

  function onActionRes(res) {
    if (res && res.ok) return;
    console.warn('[Vela] 划词动作未执行：', res ? '后台处理失败' : '扩展未响应（请到 chrome://extensions 刷新 Vela 后重试）');
  }

  let lastState = null; // 最后一笔有效选区（含克隆 Range）：点击时活选区被清也能执行

  function show() {
    const st = currentSelection();
    if (!st) {
      destroy();
      return;
    }
    lastState = st;
    const hlOn = !st.code && !!st.anchorEl?.closest('.om-hl') && !!st.focusEl?.closest('.om-hl');
    destroy();
    hideCodeBtn();
    build(st.code, hlOn);
    place(st.rect);
  }

  // ---------- 就地结果面板（sel-panel 扩展页 iframe） ----------
  let panelHost = null;
  let panelJob = null; // { act, text, rect }：面板 ready 后下发

  function panelFrame() {
    return panelHost?.querySelector('iframe') || null;
  }

  function closePanel() {
    panelHost?.remove();
    panelHost = null;
    panelJob = null;
  }

  function panelOpen() {
    // 以 DOM 为准：宿主节点被外部移除（测试/页面脚本）时变量会 stale
    if (panelHost && !document.getElementById(PANEL_ID)) {
      panelHost = null;
      panelJob = null;
    }
    return panelHost !== null;
  }

  function openPanel(act, text, anchorRect) {
    closePanel();
    let url;
    try {
      url = chrome.runtime.getURL('src/page/sel-panel.html');
    } catch {
      console.warn('[Vela] 扩展上下文不可用，无法打开划词面板');
      return;
    }
    panelJob = { act, text, rect: anchorRect };
    panelHost = document.createElement('div');
    panelHost.id = PANEL_ID;
    panelHost.style.cssText = `all:initial;position:fixed;left:0;top:0;z-index:2147483646;width:min(480px,calc(100vw - 24px));`;
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.title = 'Vela 划词面板';
    // 宿主页可 delegation 放行 clipboard-write，面板里「复制」优先走原生 API
    frame.allow = 'clipboard-write';
    frame.style.cssText = 'display:block;width:100%;height:200px;border:0;background:transparent;';
    panelHost.appendChild(frame);
    document.documentElement.appendChild(panelHost);
  }

  // 面板自报高度后按锚点定位：下方优先，放不下翻上方，整体夹在视口内
  function placePanel(h) {
    if (!panelHost || !panelJob?.rect) return;
    const rect = panelJob.rect;
    const w = panelHost.offsetWidth;
    let x = rect.left + rect.width / 2 - w / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const maxH = Math.min(h, Math.round(window.innerHeight * 0.6));
    let y = rect.bottom + 8;
    if (y + maxH > window.innerHeight - 8) y = Math.max(8, rect.top - maxH - 8);
    panelHost.style.height = `${maxH}px`;
    panelHost.style.left = `${Math.round(x)}px`;
    panelHost.style.top = `${Math.round(y)}px`;
    const frame = panelFrame();
    if (frame && maxH > 0) frame.style.height = `${maxH}px`;
  }

  on(window, 'message', (ev) => {
    if (!panelHost || ev.source !== panelFrame()?.contentWindow) return;
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'om:sel-panel-ready') {
      panelFrame()?.contentWindow?.postMessage(
        { type: 'om:sel-panel-run', act: panelJob?.act, text: panelJob?.text },
        '*',
      );
    } else if (d.type === 'om:sel-panel-height') {
      placePanel(Math.max(120, Math.min(Number(d.h) || 200, 600)));
    } else if (d.type === 'om:sel-panel-close') {
      closePanel();
    } else if (d.type === 'om:sel-panel-ask') {
      // 追问：此时才转 agent——带上原文与面板结果开聊天卡直接发送（autoSend），
      // 用户已在面板输入完问题，不需要到聊天卡再点一次发送
      const titles = { translate: '翻译', explain: '解释代码', summary: '总结' };
      const ctx = [
        `【选中内容】`,
        String(panelJob?.text || '').slice(0, 2000),
        '',
        `【${titles[panelJob?.act] || 'AI'}结果】`,
        String(d.result || '').slice(0, 3000),
        '',
        '【我的问题】',
        String(d.question || '').slice(0, 2000),
      ].join('\n');
      send({ type: 'om:widget-action', kind: 'ask', autoSend: true, selection: ctx, from: 'sel-popup' }, onActionRes);
    }
  });

  // ---------- 代码块 hover 胶囊（Monica 式：无需选中，悬停 <pre> 右上角出现） ----------
  let cbtnHost = null;
  let cbtnPre = null;

  function hideCodeBtn() {
    cbtnHost?.remove();
    cbtnHost = null;
    cbtnPre = null;
  }

  function showCodeBtn(pre) {
    const text = (pre.innerText || '').trim();
    if (text.length < 12 || ownUi(pre) || panelOpen()) return;
    cbtnPre = pre;
    cbtnHost = document.createElement('div');
    cbtnHost.id = CBTN_ID;
    cbtnHost.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483644;';
    const croot = cbtnHost.attachShadow({ mode: 'open' });
    croot.innerHTML = `
      <style>
        :host { all: initial; }
        .pill {
          display: flex; align-items: center; gap: 2px;
          background: #212227; border-radius: 9px; padding: 3px;
          box-shadow: 0 4px 14px rgba(0,0,0,.3);
          font: 12px/1 system-ui, "Segoe UI", sans-serif;
          animation: om-cb-in .12s ease;
        }
        @keyframes om-cb-in { from { transform: translateY(2px); opacity: 0; } }
        button {
          border: none; cursor: pointer; background: none; color: #fff;
          height: 26px; border-radius: 6px; padding: 0;
          display: flex; align-items: center; justify-content: center;
          transition: background .1s ease;
        }
        button:hover { background: #2c2d33; }
        button:active { transform: scale(.94); }
        .explain { width: auto; padding: 0 10px; gap: 5px; font: 600 12px/1 system-ui, "Segoe UI", sans-serif; }
        .copy { width: 26px; }
        .copied { color: #7ee787; }
        @media (prefers-color-scheme: dark) { .pill { background: #2d2d2f; } button:hover { background: #3a3a3d; } }
      </style>
      <div class="pill">
        <button class="explain" title="用 AI 解释这段代码"><span class="ic"></span>解释</button>
        <button class="copy" title="复制代码"></button>
      </div>`;
    const pill = croot.querySelector('.pill');
    pill.querySelector('.explain .ic').appendChild(svg('spark', 14));
    const copyBtn = croot.querySelector('.copy');
    copyBtn.appendChild(svg('copy', 14));
    // 同工具条：拦 mousedown 保选区/焦点；取消 pointerdown 会吞掉真实 click
    pill.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    pill.addEventListener('pointerdown', (e) => e.stopPropagation());
    pill.querySelector('.explain').addEventListener('click', () => {
      const text2 = (cbtnPre?.innerText || '').trim();
      const rect = cbtnPre?.getBoundingClientRect();
      hideCodeBtn();
      if (text2 && rect) openPanel('explain', text2.slice(0, MAX_TEXT), rect);
    });
    copyBtn.addEventListener('click', async () => {
      const t = (cbtnPre?.innerText || '').trim();
      if (!t) return;
      if (await copyText(t)) {
        copyBtn.replaceChildren(svg('check', 14));
        copyBtn.classList.add('copied');
        setTimeout(() => {
          if (!cbtnHost) return;
          copyBtn.replaceChildren(svg('copy', 14));
          copyBtn.classList.remove('copied');
        }, 1200);
      }
    });
    document.documentElement.appendChild(cbtnHost);
    // 定位：代码块右上角内侧，水平溢出视口时贴右缘
    const rect = pre.getBoundingClientRect();
    const w = pill.offsetWidth;
    const x = Math.max(8, Math.min(rect.right - w - 10, window.innerWidth - w - 8));
    const y = Math.max(8, Math.min(rect.top + 8, window.innerHeight - 40));
    cbtnHost.style.left = `${Math.round(x)}px`;
    cbtnHost.style.top = `${Math.round(y)}px`;
  }

  // 悬停 <pre> 出胶囊；移出（胶囊或代码块之外）即收。合成 mouseover 也能触发（测试用）
  on(document, 'mouseover', (e) => {
    if (cbtnHost && e.composedPath().includes(cbtnHost)) return; // 悬停在胶囊上：保持
    const pre = e.target?.closest?.('pre') || null;
    if (pre === cbtnPre) return;
    hideCodeBtn();
    if (pre) showCodeBtn(pre);
  });

  // ---------- 高亮区悬停胶囊（Monica 式：换色 / 复制 / AI 提问 / 删除） ----------
  let hlBtnHost = null;
  let hlBtnSpan = null;
  let hlShowTs = 0; // 胶囊挂出时间：刚挂出的即时反馈胶囊延时收得更久
  let hlHideTimer = 0; // 移出胶囊/高亮区后的延时收起

  function hideHlBtn() {
    clearTimeout(hlHideTimer);
    hlHideTimer = 0;
    hlBtnHost?.remove();
    hlBtnHost = null;
    hlBtnSpan = null;
  }

  function showHlBtn(span) {
    if (ownUi(span) || panelOpen()) return;
    hlBtnSpan = span;
    hlBtnHost = document.createElement('div');
    hlBtnHost.id = HBTN_ID;
    hlBtnHost.title = `Vela 高亮 v${VER}`;
    hlBtnHost.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483644;';
    const hroot = hlBtnHost.attachShadow({ mode: 'open' });
    hroot.innerHTML = `
      <style>
        :host { all: initial; }
        .pill {
          display: flex; align-items: center; gap: 3px;
          background: #212227; border-radius: 9px; padding: 3px;
          box-shadow: 0 4px 14px rgba(0,0,0,.3);
          animation: om-hb-in .12s ease;
        }
        @keyframes om-hb-in { from { transform: translateY(2px); opacity: 0; } }
        .dot, button {
          border: none; cursor: pointer; border-radius: 6px; padding: 0;
          display: flex; align-items: center; justify-content: center;
          transition: background .1s ease;
        }
        .dot { width: 22px; height: 22px; background: none; }
        .dot i {
          width: 13px; height: 13px; border-radius: 50%;
          box-shadow: inset 0 0 0 1px rgba(0,0,0,.25);
          transition: transform .1s ease;
        }
        .dot:hover { background: #2c2d33; }
        .dot:hover i { transform: scale(1.15); }
        .dot.on { background: #3a3b42; }
        .dot.on i { outline: 2px solid #fff; outline-offset: 1px; }
        button {
          width: 26px; height: 26px; background: none; color: #fff;
        }
        button:hover { background: #2c2d33; }
        button:active { transform: scale(.94); }
        .sep { width: 1px; height: 16px; background: #4a4b52; margin: 0 2px; }
        .copied { color: #7ee787; }
        @media (prefers-color-scheme: dark) { .pill { background: #2d2d2f; } button:hover, .dot:hover { background: #3a3a3d; } }
      </style>
      <div class="pill"></div>`;
    const pill = hroot.querySelector('.pill');
    const cur = hlBtnSpan.dataset.c || 'y';
    for (const [c, { bg, name }] of Object.entries(HL_COLORS)) {
      const dot = document.createElement('button');
      dot.className = 'dot' + (c === cur ? ' on' : '');
      dot.dataset.c = c;
      dot.title = name;
      const i = document.createElement('i');
      i.style.background = bg;
      dot.appendChild(i);
      dot.addEventListener('click', () => {
        if (!hlBtnSpan?.isConnected) { hideHlBtn(); return; }
        // 换色只动本 span：内联底色 + data-c 双写；换色后胶囊保持，便于继续试色（Monica 同款）
        applyHlColor(hlBtnSpan, c);
        if (c === 'y') delete hlBtnSpan.dataset.c;
        else hlBtnSpan.dataset.c = c;
        pill.querySelectorAll('.dot').forEach((d) => d.classList.toggle('on', d === dot));
      });
      pill.appendChild(dot);
    }
    const sep = document.createElement('span');
    sep.className = 'sep';
    pill.appendChild(sep);
    const copyBtn = document.createElement('button');
    copyBtn.title = '复制高亮内容';
    copyBtn.appendChild(svg('copy', 14));
    copyBtn.addEventListener('click', async () => {
      const t = (hlBtnSpan?.innerText || '').trim();
      if (!t) return;
      if (await copyText(t)) {
        copyBtn.replaceChildren(svg('check', 14));
        copyBtn.classList.add('copied');
        setTimeout(() => {
          if (!hlBtnHost) return;
          copyBtn.replaceChildren(svg('copy', 14));
          copyBtn.classList.remove('copied');
        }, 1200);
      }
    });
    pill.appendChild(copyBtn);
    const askBtn = document.createElement('button');
    askBtn.title = '对高亮内容提问';
    askBtn.appendChild(svg('spark', 15));
    askBtn.addEventListener('click', () => {
      const t = (hlBtnSpan?.innerText || '').trim();
      hideHlBtn();
      if (t) send({ type: 'om:widget-action', kind: 'ask', selection: t.slice(0, MAX_TEXT), from: 'sel-popup' }, onActionRes);
    });
    pill.appendChild(askBtn);
    const delBtn = document.createElement('button');
    delBtn.title = '删除高亮';
    delBtn.appendChild(svg('trash', 14));
    delBtn.addEventListener('click', () => {
      const s = hlBtnSpan;
      hideHlBtn();
      hlSelfRemoved = true; // 自己删的不算外部移除（diagnoseHl 用）
      if (s?.isConnected) unwrapSpan(s);
    });
    pill.appendChild(delBtn);
    // 同工具条：拦 mousedown 保选区/焦点；取消 pointerdown 会吞掉真实 click
    pill.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    pill.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.documentElement.appendChild(hlBtnHost);
    // 定位：高亮首行下方居中（span 可能折行，取第一个矩形），放不下翻上方
    const rects = span.getClientRects();
    const rect = (rects && rects[0]) || span.getBoundingClientRect();
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    let x = rect.left + rect.width / 2 - w / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    let y = rect.bottom + 6;
    if (y + h > window.innerHeight - 8) y = Math.max(8, rect.top - h - 6);
    hlBtnHost.style.left = `${Math.round(x)}px`;
    hlBtnHost.style.top = `${Math.round(y)}px`;
    hlShowTs = Date.now();
  }

  // 悬停 .om-hl 出胶囊；移出（胶囊或高亮区之外）延时收，期间移回胶囊/高亮区即取消。
  // 合成 mouseover 也能触发（测试用）。
  // 延时收而不是立即收：①工具条在选区上方、胶囊在高亮下方，鼠标从工具条移向胶囊必然
  // 先划过正文（<p> 的 mouseover），立即收会让胶囊永远够不着；②点高亮后工具条销毁，
  // Blink 重算 hover 向光标下元素补发 mouseover，旧版 250ms 宽限期到点按光标位置复核——
  // 光标仍停在已销毁的工具条处、既不在胶囊也不在高亮上，即时反馈胶囊约 260ms 必被收掉。
  // 刚挂出的即时反馈胶囊给 1.5s 够到，之后的悬停胶囊 300ms
  function cancelHlHide() {
    clearTimeout(hlHideTimer);
    hlHideTimer = 0;
  }
  function scheduleHlHide(ms) {
    if (hlHideTimer) return; // 已在倒计时：持续划过正文不续期
    hlHideTimer = setTimeout(() => {
      hlHideTimer = 0;
      hideHlBtn();
    }, ms);
  }
  on(document, 'mouseover', (e) => {
    const path = e.composedPath();
    if (hlBtnHost && path.includes(hlBtnHost)) { cancelHlHide(); return; } // 悬停在胶囊上：保持
    const hl = e.target?.closest?.('.om-hl') || null;
    if (hl && hl === hlBtnSpan) { cancelHlHide(); return; }
    if (hl) {
      hideHlBtn();
      showHlBtn(hl);
      return;
    }
    if (hlBtnHost) scheduleHlHide(Date.now() - hlShowTs < 1500 ? 1500 : 300);
  });

  // ---------- 事件接线 ----------
  // 弹出时机：mouseup（拖选/双击）与 keyup（Shift+方向键扩选）。
  // selectionchange 只用来收：选区清空（点了别处/全选取消）立即隐藏
  on(document, 'mouseup', (e) => {
    if (host && e.composedPath().includes(host)) return; // 在工具条上松开不重摆
    setTimeout(show, 0); // 双击的第二次 click 先于 selection 定型，延迟到本轮事件收尾
  });
  on(document, 'keyup', () => show());
  on(document, 'selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !String(sel).trim()) destroy();
  });
  // 工具条锚在视口坐标：滚动 / 缩放后位置失真，直接收（重新选中会再弹）。
  // 只认会挪动锚点的滚动：页面本身或锚点的某个祖先容器。页面里无关的滚动容器（轮播、
  // 自动滚动的目录/聊天挂件、跑马灯）持续发 scroll，旧版一律收起，工具条刚弹出就消失
  const scrollMoves = (t, el) => !!el && (t === document || t === window || t === document.documentElement
    || t === document.body || (typeof t?.contains === 'function' && t.contains(el)));
  on(window, 'scroll', (e) => {
    const t = e.target;
    if (host && scrollMoves(t, lastState?.anchorEl)) destroy();
    if (cbtnHost && scrollMoves(t, cbtnPre)) hideCodeBtn();
    if (hlBtnHost && scrollMoves(t, hlBtnSpan)) hideHlBtn();
  }, true);
  on(window, 'resize', () => { destroy(); hideCodeBtn(); hideHlBtn(); });
  on(document, 'keydown', (e) => {
    if (e.key === 'Escape') { destroy(); hideCodeBtn(); hideHlBtn(); closePanel(); }
  });
  on(document, 'pointerdown', (e) => {
    const path = e.composedPath();
    if (host && !path.includes(host)) destroy();
    if (cbtnHost && !path.includes(cbtnHost)) hideCodeBtn();
    if (hlBtnHost && !path.includes(hlBtnHost)) hideHlBtn();
    // 面板 iframe 内的点击不会冒泡到本页：能到这里说明点在面板外
    if (panelHost && !path.includes(panelHost)) closePanel();
  }, true);

  window.__omSelPopup = api;
  console.info(`[Vela] 划词工具条已注入 v${VER}`);
})();
