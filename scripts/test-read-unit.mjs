// 连续阅读（连读）单元测试（node:test，无浏览器）：
// 「下一页」链接打分（rel=next / 文本档位 / 同源约束 / 去重锚点 / 平分裁定）、
// URL 归一化、抓取 HTML 清洗（剥内联事件处理器），以及逐页 / 总览 prompt 构建。
// DOM 解析与抓取依赖 DOM 与 fetch，由 e2e（verify-read-series.mjs）覆盖。
// 用法：node scripts/test-read-unit.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, sameOrigin, pickNextLink } from '../src/read/series.js';
import { stripInlineHandlers } from '../src/common/html.js';
import { buildSeriesPagePrompt, buildSeriesDigestPrompt, SERIES_PAGE_CHARS } from '../src/llm/tasks.js';

const HERE = 'https://docs.example.com/guide/p1.html';
const a = (href, text, extra = {}) => ({ href: normalizeUrl(href, HERE), text, rel: [], inNav: false, order: 0, ...extra });
const pick = (anchors, opts = {}) => pickNextLink({ anchors, currentUrl: HERE, ...opts });

test('normalizeUrl：去 hash、相对地址按基址解析、非法与非 http(s) 拒收', () => {
  assert.equal(normalizeUrl(HERE + '#section'), HERE);
  assert.equal(normalizeUrl('/guide/p2.html', HERE), 'https://docs.example.com/guide/p2.html');
  assert.equal(normalizeUrl('p2.html', HERE), 'https://docs.example.com/guide/p2.html');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl(null), '');
  assert.equal(normalizeUrl('javascript:alert(1)'), '');
  assert.equal(normalizeUrl('mailto:a@b.c'), '');
  assert.equal(normalizeUrl('https://x/y', 'about:blank'), 'https://x/y'); // 绝对地址不吃基址
  assert.ok(sameOrigin(HERE, 'https://docs.example.com/other'));
  assert.ok(!sameOrigin(HERE, 'https://evil.example.com/'));
});

test('pickNextLink：<a rel=next> 与 <link rel=next> 优先', () => {
  const byText = pick([a('/guide/p2.html', '下一页')]);
  const byRel = pick([a('/guide/p2.html', '随便什么字', { rel: ['next'] }), a('/guide/p3.html', '下一页')]);
  assert.equal(byRel.url, 'https://docs.example.com/guide/p2.html');
  const byLink = pick([a('/guide/p3.html', '下一页')], { linkNext: '/guide/p2.html' });
  assert.equal(byLink.url, 'https://docs.example.com/guide/p2.html');
  assert.equal(byText.url, 'https://docs.example.com/guide/p2.html');
});

test('pickNextLink：文本档位——整段命中 > 前缀命中 > 纯箭头', () => {
  const exact = pick([a('/p2', '下一页'), a('/p3', '下一页：安装步骤')]);
  assert.equal(exact.url, 'https://docs.example.com/p2');
  const prefix = pick([a('/p3', '下一页：安装步骤'), a('/p4', '别的链接')]);
  assert.equal(prefix.url, 'https://docs.example.com/p3');
  const arrow = pick([a('/p2', '»'), a('/p9', ' unrelated')]);
  assert.equal(arrow.url, 'https://docs.example.com/p2');
  assert.equal(pick([a('/p2', 'Next')]).url, 'https://docs.example.com/p2');
  assert.equal(pick([a('/p2', 'Next Page »')]).url, 'https://docs.example.com/p2');
  assert.equal(pick([a('/p2', 'Next: Deployment')]).url, 'https://docs.example.com/p2');
});

test('pickNextLink：上一页 / 目录 / 长文本不成候选', () => {
  assert.equal(pick([a('/p0', '上一页'), a('/p0', 'Previous'), a('/toc', '目录'), a('/p0', '下一'.repeat(40))]), null);
  // 前缀命中限长：太长的「下一页…」多半是正文句子
  assert.equal(pick([a('/p0', `下一页${'内容'.repeat(30)}`)]), null);
});

test('pickNextLink：跨域 / 本页锚点一律不跟', () => {
  assert.equal(pick([a('https://evil.example.com/troll', '下一页', { rel: ['next'] })]), null);
  assert.equal(pick([], { linkNext: 'https://evil.example.com/troll' }), null);
  // 跨域诱饵在、同源真链也在：只跟同源
  const mixed = pick([a('https://evil.example.com/troll', '下一页', { rel: ['next'] }), a('/p2.html', '下一页')]);
  assert.equal(mixed.url, 'https://docs.example.com/p2.html');
  assert.equal(pick([a(HERE + '#top', '下一页')]), null); // 去掉 hash 就是本页
  assert.equal(pick([a('https://docs.example.com/guide/p1.html#x', '下一页')]), null);
});

test('pickNextLink：分页容器加分与文档序靠后裁定', () => {
  const inNav = pick([a('/p2', '下一页', { order: 3, inNav: true }), a('/p9', '下一页', { order: 9 })]);
  assert.equal(inNav.url, 'https://docs.example.com/p2'); // nav/footer 里的优先
  const later = pick([a('/p2', '下一页', { order: 2 }), a('/p3', '下一页', { order: 8 })]);
  assert.equal(later.url, 'https://docs.example.com/p3'); // 同分取文档序靠后的（页尾分页条）
});

test('抓取 HTML 清洗：剥所有标签上的 on*= 内联事件处理器，其余属性 / 文本 / 转义代码示例不动', () => {
  const src = `<body onload="boot()" onmouseover=track()>
    <a href="/p2.html" onclick="ga('p2')" ONTOGGLE="t()" data-onx="1" class="next">下一页</a>
    <svg onload="x()"><circle r="1"/></svg>
    <p>示例：&lt;button onclick="boom()"&gt; 是转义过的正文</p>`;
  const out = stripInlineHandlers(src);
  assert.ok(!/\son[a-z]+\s*=/i.test(out.replace(/&lt;[^&]*&gt;/g, '')), out); // 真实标签上的 on*= 全剥（含未加引号 / 大写 / svg）
  for (const gone of ['boot()', 'track()', 'ga(', 't()']) assert.ok(!out.includes(gone), gone); // 真标签的 handler 内容不残留
  assert.ok(out.includes('href="/p2.html"') && out.includes('data-onx="1"') && out.includes('class="next"')); // 其余属性原样
  assert.ok(out.includes('下一页') && out.includes('&lt;button onclick="boom()"&gt;')); // 文本与转义代码示例不动
  assert.equal(stripInlineHandlers(null), ''); // 空值安全
});

test('连读逐页 prompt：序号 / 标题 / 地址 / 正文与截断', () => {
  const p = buildSeriesPagePrompt({ index: 7, title: '窗口 API', url: 'https://x/p7', text: 'A'.repeat(SERIES_PAGE_CHARS + 500) });
  assert.ok(p.includes('第 7 页') && p.includes('窗口 API') && p.includes('https://x/p7'));
  assert.ok(p.includes('A'.repeat(100)));
  assert.ok(!p.includes('A'.repeat(SERIES_PAGE_CHARS + 1))); // 超出预算的部分不进 prompt
  assert.ok(p.includes('可能截断'));
  assert.ok(buildSeriesPagePrompt({ index: 1, title: 'T', url: 'u', text: '' }).includes('（这一页没有提取到正文）'));
});

test('连读总览 prompt：起始页 / 页数 / 逐页摘要（含缺失降级）', () => {
  const p = buildSeriesDigestPrompt({
    start: 'https://x/p1',
    pages: [{ index: 1, title: '起步', url: 'https://x/p1', summary: '要点一' }, { index: 2, title: '进阶', url: 'https://x/p2' }],
  });
  assert.ok(p.includes('https://x/p1') && p.includes('共 2 页'));
  assert.ok(p.includes('【第 1 页】起步') && p.includes('要点一'));
  assert.ok(p.includes('（这一页没有总结）'));
  assert.ok(p.includes('每页一行'));
});
