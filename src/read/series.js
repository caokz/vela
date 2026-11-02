// 连续阅读（连读）：从当前文档页开始，自动发现「下一页」链接、逐页抓取正文，
// 供聊天视图逐页流式总结并最终汇总。导航是纯规则打分（Crawl4AI 式确定性跟随），
// 不烧 LLM 调用；token 只花在每页的总结与最后的总览上。
// 编排跑在扩展页（MV3 约束：长循环不进 SW）。打分 / 归一化是纯函数，Node 可单测；
// parseSeriesHtml / fetchSeriesPage 依赖 DOM 与 fetch，由浏览器 e2e 覆盖。

import { parseFetchedHtml } from '../common/html.js';

// 单次连读上限（防失控长循环；llmSettings.readSeries.maxPages 可调小做测试）
export const SERIES_MAX_PAGES = 30;
// 逐页礼貌间隔：抓完一页等一拍再抓下一页
export const SERIES_DELAY_MS = 800;
// 单页正文进 prompt 的字符上限（与网页总结同档）
export const SERIES_PAGE_CHARS = 12000;
const FETCH_TIMEOUT_MS = 20000;
const FETCH_MAX_BYTES = 3 * 1024 * 1024;

// URL 归一化：去 hash、只收 http(s)。非法 / 非网页协议返回空串
export function normalizeUrl(raw, base = '') {
  const s = String(raw ?? '').trim();
  if (!s) return ''; // 空串带基址会被 new URL 解析成基址自身，必须先挡掉
  try {
    const u = new URL(s, base || undefined);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

export function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

// 「下一页」文本识别：整段匹配（第 2 档）与前缀匹配（第 3 档，如「下一页：Windows 安装」/「NextDeployment」）。
// 先剥首尾箭头装饰（"下一页 »" / "» Next"），剩下的核心词命中才算；纯箭头单独一档（分低些：面包屑分隔符也长这样）
const NEXT_WORDS = '下一页|下一节|下一章|下一篇|下页|下一个|next(?:\\s*page)?';
function matchNextText(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || t.length > 60) return 0;
  const hadArrow = /^[»›→>]+|[»›→<]+$/.test(t);
  t = t.replace(/^[»›→>\s]+/, '').replace(/[»›←<\s]+$/, '').trim();
  if (!t) return hadArrow ? 4 : 0; // "»" / "›" 独立成链：典型分页器
  if (new RegExp(`^(?:${NEXT_WORDS})$`).test(t)) return 2;
  if (new RegExp(`^(?:${NEXT_WORDS})[:：›»→\\s]`).test(t) && t.length <= 40) return 3;
  return 0;
}

// 从一页的链接清单里挑「下一页」。anchors: [{ href(已归一化), text, rel(数组), inNav, order }]，
// linkNext: <link rel=next> 声明的地址（可空）。返回 { url, text } 或 null。
// 只做「挑哪条」：跨域一律不跟（安全默认，防被外站诱饵链带走）；是否已读（回环）由调用方判。
//   评分：<link rel=next> 120 > <a rel=next> 100 > 整段文本命中 80 > 前缀命中 60 > 纯箭头 50；
//   位于 nav/footer/分页容器内 +15；同分取文档序靠后的（分页条通常在页尾）
export function pickNextLink({ anchors = [], linkNext = '', currentUrl = '' }) {
  const current = normalizeUrl(currentUrl);
  const origin = current ? new URL(current).origin : '';
  let best = null;
  const consider = (url, text, score, order) => {
    if (!url) return;
    if (current && url === current) return; // 本页锚点（去 hash 后同址）不算翻页
    if (origin && !sameOrigin(url, current)) return; // 只跟同源：外站链接一律跳过
    if (best && (best.score > score || (best.score === score && best.order >= order))) return;
    best = { url, text: String(text || '').trim().slice(0, 60), score, order };
  };
  let lastOrder = -1;
  for (const a of anchors) lastOrder = Math.max(lastOrder, a.order ?? 0);
  const linkTarget = normalizeUrl(linkNext, current || undefined); // 相对 href 按当前页地址解析
  if (linkTarget) consider(linkTarget, 'link[rel=next]', 120, lastOrder + 1);
  for (const a of anchors) {
    const rel = Array.isArray(a.rel) ? a.rel : String(a.rel || '').toLowerCase().split(/\s+/);
    if (rel.includes('next')) { consider(a.href, a.text, 100, a.order ?? 0); continue; }
    const tier = matchNextText(a.text);
    if (!tier) continue;
    const score = tier === 2 ? 80 : tier === 3 ? 60 : 50;
    consider(a.href, a.text, score + (a.inNav ? 15 : 0), a.order ?? 0);
  }
  return best ? { url: best.url, text: best.text } : null;
}

// 从 Document（实况 DOM 或 DOMParser 文档）收集链接清单。baseUrl：解析相对 href 用——
// DOMParser 解析出的文档 base 是扩展页自身，相对链接必须显式按页面地址解析
export function docToAnchors(doc, baseUrl = '') {
  const linkNext = normalizeUrl(doc.querySelector('link[rel="next" i]')?.getAttribute('href') || '', baseUrl || undefined);
  const anchors = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    if (anchors.length >= 800) break;
    const href = normalizeUrl(a.getAttribute('href') || '', baseUrl || a.baseURI || undefined);
    if (!href) continue;
    anchors.push({
      href,
      text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      rel: (a.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(Boolean),
      inNav: !!a.closest?.('nav,footer,[role="navigation"],[class*="pag"],[class*="next"]'),
      order: anchors.length,
    });
  }
  return { linkNext, anchors };
}

// 抓回来的 HTML → { title, text, anchors, linkNext }：先收链接（页脚 / 目录里的都在），
// 再摘掉导航与脚本类节点提正文（与 injected.extractArticle 同一套排除表）
export function parseSeriesHtml(html, baseUrl = '') {
  const doc = parseFetchedHtml(html); // 统一清洗：先剥内联事件处理器再解析（见 common/html.js）
  const { linkNext, anchors } = docToAnchors(doc, baseUrl);
  doc.querySelectorAll('script,style,noscript,template,iframe,svg,canvas,nav,footer,aside,form,button')
    .forEach((n) => n.remove());
  const BLOCK = 'p,div,section,article,li,tr,h1,h2,h3,h4,h5,h6,pre,blockquote,br,dd,dt,table,ul,ol,header,main';
  doc.querySelectorAll(BLOCK).forEach((n) => n.append(doc.createTextNode('\n')));
  const root = doc.querySelector('article, main, [role="main"], #content, .content') || doc.body;
  const text = (root?.textContent || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
  return { title: doc.title || '', text, anchors, linkNext };
}

// 有界读取：超过 FETCH_MAX_BYTES 截断，防止大页面把扩展页内存撑爆（与 browser-tools 同款）
async function readBody(res) {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    out += decoder.decode(value, { stream: true });
    if (size > FETCH_MAX_BYTES) { reader.cancel().catch(() => {}); break; }
  }
  return out + decoder.decode();
}

// 抓取下一页：超时 20s、跟随重定向（重定向落点由调用方再查一遍已读集合）
export async function fetchSeriesPage(url, signal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ac.signal, credentials: 'omit', redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    const raw = await readBody(res);
    if (!/html/i.test(type) && !/^\s*</.test(raw)) throw new Error('不是 HTML 页面，无法继续跟随下一页');
    const { title, text, anchors, linkNext } = parseSeriesHtml(raw, res.url || url);
    return { url: normalizeUrl(res.url || url), title, text, anchors, linkNext };
  } catch (e) {
    if (ac.signal.aborted && !signal?.aborted) throw new Error('抓取超时（20 秒）');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
