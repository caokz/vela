// 自包含页面提取函数：经 chrome.scripting.executeScript({func}) 序列化进页面执行。
// 约束：每个导出函数必须完全自包含——不引用外部作用域、不做 import。

// 网页正文提取（总结用）：挑文本密度最高的候选容器，读 innerText。
// 返回 { title, url, text }；空页面返回 { text: '' }。
export function extractArticle() {
  const SKIP = 'script,style,noscript,template,iframe,svg,canvas,nav,footer,aside,form,button';
  const clones = document.querySelectorAll(SKIP);
  const hidden = [];
  // 记下原内联 display 再隐藏：还原时写回原值，不能一律清空——
  // 页面自己用内联 display:none 藏起来的菜单/弹层会被意外显示出来
  for (const n of clones) { hidden.push([n, n.style.display]); n.style.display = 'none'; }
  let title = document.title || '';
  let best = null;
  let bestScore = 0;
  const candidates = document.querySelectorAll(
    'article, main, [role="main"], #content, .content, .post, .article, .markdown-body',
  );
  for (const c of candidates) {
    const text = c.innerText || '';
    const score = text.length * (c.matches('article, main, [role="main"]') ? 1.2 : 1);
    if (text.length > 200 && score > bestScore) { best = c; bestScore = score; }
  }
  const container = best || document.body;
  const text = (container.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  for (const [n, display] of hidden) n.style.display = display;
  return {
    title,
    url: location.href,
    text,
    usedContainer: best ? 'main' : 'body',
  };
}

// 当前选区文本（LLM 任务模式 get_selection 工具用）。输入框内的选区 getSelection 拿不到，单独读
export function getSelectionText() {
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|email)$/i.test(a.type)))) {
    const t = a.value.slice(a.selectionStart ?? 0, a.selectionEnd ?? 0);
    if (t.trim()) return { title: document.title, url: location.href, text: t };
  }
  return { title: document.title, url: location.href, text: String(window.getSelection() || '') };
}

// 连续阅读：收集本页链接清单与 <link rel=next> 声明，交 src/read/series.js 的打分挑「下一页」。
// 归一化逻辑与 series.js normalizeUrl 同款（经典脚本禁 import，就地内联）：去 hash、只收 http(s)、相对地址按本页解析
export function collectAnchors() {
  const norm = (raw) => {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    try {
      const u = new URL(s, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      u.hash = '';
      return u.href;
    } catch { return ''; }
  };
  const linkNext = norm(document.querySelector('link[rel="next" i]')?.getAttribute('href') || '');
  const anchors = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (anchors.length >= 800) break;
    const href = norm(a.getAttribute('href') || '');
    if (!href) continue;
    anchors.push({
      href,
      text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      rel: (a.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(Boolean),
      inNav: !!a.closest('nav,footer,[role="navigation"],[class*="pag"],[class*="next"]'),
      order: anchors.length,
    });
  }
  return { linkNext, anchors };
}
