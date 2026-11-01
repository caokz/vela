// 高亮素材库的纯函数层：划词点「高亮」→ SW 把内容增量写进 omMindmapInbox（按页 key 聚合），
// 思维导图查看页读同一份组装生成文本、比对内容指纹决定是否重新生成。
// 零 chrome 依赖，Node 可直接 `node src/mindmap/draft.js` 自测（文件尾有自测入口）。

export const DRAFT_KEY = 'omMindmapInbox';
export const DRAFT_MAX_ITEMS = 100; // 单页最多收集段数（超出丢最旧）
export const DRAFT_ITEM_MAX = 4000; // 单段最大字符
export const DRAFT_MAX_PAGES = 200; // 最多保留多少页素材（按 updatedAt 淘汰最久未更新的）
export const PAGE_CTX_MAX = 12000; // 页面正文快照上限（生成时作上下文）

// 页 key：去掉 hash（SPA 页内锚点切换不算换页），query 保留（带参页面是不同内容）
export function pageKeyOf(url) {
  return String(url || '').split('#')[0];
}

// 文本归一：去重 / 移除匹配 / 指纹比较用；存储原文不动
export function normText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

// 追加素材（不可变：返回新条目）。按归一文本去重——重新高亮同一段不会产生重复项
export function addItem(page, { texts, title = '', ts = Date.now() }) {
  const items = [...(page?.items || [])];
  const norms = new Set(items.map((it) => normText(it.text)));
  for (const t of texts || []) {
    const text = String(t || '').trim().slice(0, DRAFT_ITEM_MAX); // 首尾空白是噪音，内部换行保留
    const n = normText(text);
    if (!n || norms.has(n)) continue;
    norms.add(n);
    items.push({ id: `hl:${ts.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, ts });
  }
  const trimmed = items.length > DRAFT_MAX_ITEMS ? items.slice(items.length - DRAFT_MAX_ITEMS) : items;
  return { ...page, url: page?.url || '', title: title || page?.title || '', items: trimmed, updatedAt: ts };
}

// 移除素材：按归一文本匹配（取消高亮 / 胶囊删除时同步清库）
export function removeItems(page, texts) {
  const gone = new Set((texts || []).map(normText).filter(Boolean));
  const items = (page?.items || []).filter((it) => !gone.has(normText(it.text)));
  return { ...page, items, updatedAt: Date.now() };
}

// 内容指纹（djb2）：素材集合是否变化决定「直接看旧图」还是「重新生成」。
// 与条目顺序无关的比对会误判（顺序本身也是信息），这里保留顺序敏感性。
export function draftSig(items) {
  let h = 5381;
  for (const it of items || []) {
    for (const ch of normText(it?.text)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
    h = ((h * 33) ^ 0x1f) >>> 0; // 段间分隔符，防相邻段拼接歧义
  }
  return h.toString(36);
}

// 正文快照指纹（整页生成模式用）：同样 djb2，但加 p 前缀——两种指纹同存于历史
// 记录的 sig 字段，前缀保证永不相撞，判断「正文没变 → 直接看旧图」。
export function textSig(text) {
  let h = 5381;
  for (const ch of normText(String(text || '').slice(0, PAGE_CTX_MAX))) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return 'p' + h.toString(36);
}

// 页面正文快照：打开查看页时由内容脚本带回、SW 刷新（生成时作 LLM 的上下文，
// 让它按网页结构理解高亮片段的归属）。只有素材条目存在时才有意义。
export function setPageText(page, { text, ts = Date.now() }) {
  return { ...page, text: String(text || '').slice(0, PAGE_CTX_MAX), textAt: ts };
}

// 组装生成文本：【片段 n】分隔（prompt 据此按语义归并）。总量超限时按长度比例截断，
// 每段保底 200 字，尽量每段都留份（buildMindmapPrompt 侧还有最终硬截断兜底）。
export function assembleDraftText(items, maxChars = 12000) {
  const list = (items || []).filter((it) => normText(it?.text));
  if (!list.length) return '';
  const lens = list.map((it) => String(it.text).length);
  const total = lens.reduce((a, b) => a + b, 0);
  const budget = total <= maxChars
    ? lens
    : lens.map((l) => Math.max(200, Math.floor((maxChars * l) / total)));
  return list
    .map((it, i) => `【片段${i + 1}】\n${String(it.text).trim().slice(0, budget[i])}`)
    .join('\n\n');
}

// ---- Node 自测入口：node src/mindmap/draft.js ----
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('draft.js')) {
  const assert = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) process.exitCode = 1;
  };
  assert('页 key 去掉 hash', pageKeyOf('https://x/a?b=1#sec') === 'https://x/a?b=1');
  assert('normText 压空白', normText(' a\n b\t c ') === 'a b c');

  let p = addItem(null, { texts: ['第一段', '  第二段  '], title: 'T', ts: 1 });
  assert('追加两段', p.items.length === 2 && p.items[1].text === '第二段');
  p = addItem(p, { texts: [' 第一段\n\t'], ts: 2 }); // 归一后与第一段相同
  assert('归一去重', p.items.length === 2);
  p = addItem(p, { texts: ['第三段'], ts: 3 });
  p = removeItems(p, ['第二段']);
  assert('按归一文本移除', p.items.length === 2 && !p.items.some((it) => it.text === '第二段'));
  p = removeItems(p, ['不存在的']);
  assert('移除不匹配项不变', p.items.length === 2);

  const s1 = draftSig(p.items);
  assert('指纹稳定', draftSig([...p.items]) === s1);
  assert('增删改都换指纹', draftSig([...p.items, { text: '新段' }]) !== s1
    && draftSig(p.items.slice(0, 1)) !== s1 && draftSig([{ text: p.items[0].text + 'x' }, p.items[1]]) !== s1);
  assert('空素材指纹一致', draftSig([]) === draftSig(null));
  assert('正文指纹稳定且带 p 前缀', textSig('正文 ABC') === textSig('正文  ABC\n') && textSig('正文').startsWith('p'));
  assert('正文变化换指纹且不与素材指纹相撞', textSig('正文一') !== textSig('正文二') && !draftSig([{ text: 'x' }]).startsWith('p'));

  const txt = assembleDraftText([{ text: 'AAA' }, { text: 'BBB' }], 100);
  assert('组装带片段标记', txt === '【片段1】\nAAA\n\n【片段2】\nBBB', txt);
  const big = assembleDraftText([{ text: '甲'.repeat(9000) }, { text: '乙'.repeat(3000) }], 6000);
  assert('超限按比例截断且两段都在', big.includes('【片段1】') && big.includes('【片段2】')
    && big.indexOf('乙') > 0 && big.length < 9000, big.length);
  assert('空素材组装为空串', assembleDraftText([]) === '' && assembleDraftText([{ text: '  ' }]) === '');
  const snap = setPageText(p, { text: '正文'.repeat(PAGE_CTX_MAX), ts: 9 });
  assert('正文快照截断到上限', snap.text.length === PAGE_CTX_MAX && snap.textAt === 9);
}
