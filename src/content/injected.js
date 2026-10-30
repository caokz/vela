// 自包含页面提取函数：经 chrome.scripting.executeScript({func}) 序列化进页面执行。
// 约束：每个导出函数必须完全自包含——不引用外部作用域、不做 import。

// 网页正文提取（总结用）：挑文本密度最高的候选容器，读 innerText。
// 返回 { title, url, text }；空页面返回 { text: '' }。
export function extractArticle() {
  const SKIP = 'script,style,noscript,template,iframe,svg,canvas,nav,footer,aside,form,button';
  const clones = document.querySelectorAll(SKIP);
  const hidden = [];
  for (const n of clones) { hidden.push(n); n.setAttribute('data-om-hidden', '1'); n.style.display = 'none'; }
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
  for (const n of hidden) { n.style.display = ''; n.removeAttribute('data-om-hidden'); }
  return {
    title,
    url: location.href,
    text,
    usedContainer: best ? 'main' : 'body',
  };
}
