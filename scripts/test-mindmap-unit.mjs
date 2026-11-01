// 思维导图纯函数单元：markdown 大纲 → 树解析（列表缩进 / 标题挂靠 / 容错）、
// 树 → markdown（导出格式与解析同构，roundtrip）/ FreeMind XML、高亮素材库（draft.js）、
// prompt 构建（网页上下文 + 高亮片段）。
// 用法：node scripts/test-mindmap-unit.mjs
import { parseOutline, outlineToMarkdown, outlineToFreemind, countNodes, cleanLabel, splitRef } from '../src/mindmap/outline.js';
import {
  DRAFT_KEY, DRAFT_MAX_ITEMS, PAGE_CTX_MAX,
  pageKeyOf, normText, addItem, removeItems, setPageText, draftSig, textSig, assembleDraftText,
} from '../src/mindmap/draft.js';
import { buildMindmapPrompt, buildMindmapFullPrompt, MINDMAP_MAX_CHARS } from '../src/llm/tasks.js';

let fails = 0;
const check = (name, ok, detail = '') => {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${d && !ok ? ' — ' + d : ''}`);
  if (!ok) fails++;
};

const shape = (t) => JSON.stringify(t, (k, v) => (k === 'children' && !v.length ? undefined : v));

// ---- 解析：嵌套列表 ----
const t1 = parseOutline('- 甲\n  - 甲一\n    - 孙一\n  - 甲二\n- 乙');
check('2 空格缩进嵌套层级', t1?.length === 2 && t1[0].children.length === 2
  && t1[0].children[0].children.length === 1 && t1[0].children[0].children[0].label === '孙一', shape(t1));

const t2 = parseOutline('* 甲\n    * 甲一\n        * 孙一\n* 乙');
check('4 空格缩进（缩进栈推断，不依赖固定步长）', t2?.length === 2 && t2[0].children[0].children.length === 1, shape(t2));

const t3 = parseOutline('- 甲\n\t- 甲一');
check('tab 缩进按 4 空格处理', t3?.length === 1 && t3[0].children.length === 1, shape(t3));

const t4 = parseOutline('1. 甲\n2. 乙\n   1) 乙一');
check('有序列表（1. / 1)）同无序列表', t4?.length === 2 && t4[1].children.length === 1, shape(t4));

const t5 = parseOutline('- 甲\n  - 甲一\n      - 跳级');
check('跳档缩进按一层处理（不悬空）', t5?.[0].children[0].children.length === 1 && t5[0].children.length === 1, shape(t5));

// ---- 解析：标题 ----
const t6 = parseOutline('# 主题\n## 甲\n- 甲一\n  - 孙一\n## 乙\n- 乙一');
check('标题层级 + 列表挂靠最近标题', t6?.length === 1 && t6[0].label === '主题' && t6[0].children.length === 2
  && t6[0].children[0].children[0].children.length === 1, shape(t6));

const t7 = parseOutline('### 甲\n#### 乙\n##### 丙');
check('纯标题层级（跳级收拢到最近祖先）', t7?.length === 1 && t7[0].children[0].children.length === 1, shape(t7));

const t8 = parseOutline('## 甲\n- 甲一\n# 乙\n- 乙一');
check('同级标题分段（栈弹出）', t8?.length === 2 && t8[0].children.length === 1 && t8[1].children.length === 1, shape(t8));

// ---- 解析：容错 ----
check('空输入返回 null', parseOutline('') === null);
check('纯散文（无结构行）返回 null', parseOutline('这是一段话。\n没有列表也没有标题。') === null);
const t9 = parseOutline('好的，大纲如下：\n\n- 甲\n  - 甲一\n\n希望有帮助！');
check('前言与尾注忽略', t9?.length === 1 && t9[0].children.length === 1, shape(t9));
const t10 = parseOutline('```markdown\n- 甲\n  - 甲一\n```');
check('``` 围栏剥掉（模型爱包一层代码块）', t10?.length === 1 && t10[0].children.length === 1, shape(t10));
const t11 = parseOutline('- **重点**：结论\n- [链接文字](https://x) 说明\n- `code_id` 用法\n- ![图](https://y) 忽略');
check('行内标记清洗为纯文本', t11?.every((n) => !/(\*\*|__|\[|\]|`)/.test(n.label)) && t11[0].label === '重点：结论'
  && t11[1].label === '链接文字 说明' && t11[2].label === 'code_id 用法', shape(t11));
const t12 = parseOutline('-   甲\n-\n  -  甲一');
check('多余空白与空条目', t12?.length === 1 && t12[0].label === '甲' && t12[0].children.length === 1, shape(t12));

check('cleanLabel 独立可用', cleanLabel('**A** __B__ *C*') === 'A B C' && cleanLabel(undefined) === '');

// ---- 导出与 roundtrip ----
const tree = { label: '根', children: [
  { label: '甲', children: [{ label: '甲一', children: [] }, { label: '甲二', children: [] }] },
  { label: '乙', children: [] },
] };
const md = outlineToMarkdown(tree);
check('markdown 导出格式', md === '# 根\n- 甲\n  - 甲一\n  - 甲二\n- 乙\n', JSON.stringify(md));
const rt = parseOutline(md);
check('roundtrip：导出再解析还原同一棵树', shape(rt) === shape([{ ...tree }]), `${shape(rt)} vs ${shape([{ ...tree }])}`);
check('countNodes 计根', countNodes(tree) === 5 && countNodes({ label: 'x', children: [] }) === 1);

const mm = outlineToFreemind(tree);
check('FreeMind 结构与转义', mm.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.0.1">')
  && mm.includes('<node TEXT="根">') && mm.includes('<node TEXT="甲一"/>') && mm.trimEnd().endsWith('</map>'), mm);
const mmEsc = outlineToFreemind({ label: 'A&B"<>', children: [] });
check('FreeMind XML 转义（& < > " \'）', mmEsc.includes('<node TEXT="A&amp;B&quot;&lt;&gt;"/>'), mmEsc);

// ---- 高亮素材库（draft.js：高亮只记录，生成永远显式） ----
check('storage 键与上限常量', DRAFT_KEY === 'omMindmapInbox' && DRAFT_MAX_ITEMS === 100 && PAGE_CTX_MAX === 12000);
check('页 key 去 hash', pageKeyOf('https://a.b/x#sec') === 'https://a.b/x' && pageKeyOf('https://a.b/x') === 'https://a.b/x');
check('normText 只压空白不改内文', normText(' 第一段\n\t') === '第一段' && normText(undefined) === '');

let page = addItem({ url: 'https://a.b/x', title: 'T', items: [] }, { texts: ['第一段'], title: 'T', ts: 1 });
page = addItem(page, { texts: ['  第一段 ', '第二段\n换行'], title: 'T', ts: 2 });
check('追加素材：归一去重、保留换行', page.items.length === 2 && page.items[1].text === '第二段\n换行' && page.updatedAt === 2, shape(page.items));
check('素材 id 前缀 hl:', page.items.every((it) => /^hl:/.test(it.id)));

page = removeItems(page, ['第一段']);
check('按归一文本移除素材', page.items.length === 1 && page.items[0].text.startsWith('第二段'));

page = setPageText(page, { text: 'x'.repeat(PAGE_CTX_MAX + 99), ts: 9 });
check('页面正文快照截断到上限', page.text.length === PAGE_CTX_MAX && page.textAt === 9);

const sigA = draftSig([{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }]);
check('指纹稳定', sigA === draftSig([{ id: 'x', text: '甲' }, { id: 'y', text: '乙' }]) && /^[0-9a-z]+$/.test(sigA));
check('顺序变化换指纹（增删会乱结构）', sigA !== draftSig([{ id: 'b', text: '乙' }, { id: 'a', text: '甲' }]));
check('增删改都换指纹', sigA !== draftSig([{ id: 'a', text: '甲' }, { id: 'b', text: '丙' }])
  && sigA !== draftSig([{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }, { id: 'c', text: '丙' }])
  && sigA !== draftSig([{ id: 'a', text: '甲' }]));
check('空素材指纹一致', draftSig([]) === draftSig([]));
check('正文指纹带 p 前缀且与素材指纹不撞', textSig('正文').startsWith('p') && textSig('正文') === textSig('正文 ') && textSig('甲') !== textSig('乙') && !draftSig([]).startsWith('p'));

const asm = assembleDraftText([{ id: 'a', text: 'AAA' }, { id: 'b', text: 'BBB' }]);
check('组装带片段编号标记', asm === '【片段1】\nAAA\n\n【片段2】\nBBB', asm);
check('空白片段跳过', assembleDraftText([{ id: 'a', text: '  ' }, { id: 'b', text: 'B' }]) === '【片段1】\nB');
const big = assembleDraftText([{ id: 'a', text: '甲'.repeat(9000) }, { id: 'b', text: '乙'.repeat(6000) }], 12000);
check('超限按比例截断且每段都在', big.includes('【片段1】') && big.includes('【片段2】') && big.length < 12000 + 200, big.length);
check('空素材组装为空串', assembleDraftText([]) === '');

// ---- prompt（网页上下文 + 高亮片段） ----
const p = buildMindmapPrompt({ title: '标题X', text: '网页正文语境', highlights: asm });
check('导图 prompt 含标题/正文语境/片段与格式约束', p.includes('标题X') && p.includes('网页正文语境')
  && p.includes('【片段1】') && p.includes('AAA') && p.includes('【高亮片段】') && p.includes('无序列表') && p.includes('不要编造'));
check('导图 prompt 颗粒度与出处标注约束', p.includes('宁整勿碎') && p.includes('单词级') && p.includes('章节脉络')
  && p.includes('〔片段2〕') && p.includes('不可遗漏') && p.includes('没有【片段n】编号时不标注'));
check('导图 prompt 无上下文时降级说明', buildMindmapPrompt({ title: 'T', highlights: '片段' }).includes('没有网页正文上下文'));
const long = '字'.repeat(MINDMAP_MAX_CHARS + 500);
const p2 = buildMindmapPrompt({ title: '标题X', text: long, highlights: asm });
check('导图 prompt 正文截断到上限', p2.includes('字'.repeat(100)) && p2.length < MINDMAP_MAX_CHARS * 2 + 600, p2.length);
check('导图 prompt 无标题兜底', buildMindmapPrompt({ text: 't', highlights: 'h' }).includes('（无标题）'));

// ---- 整页模式 prompt ----
const pf = buildMindmapFullPrompt({ title: '标题Y', text: '整页正文语境' });
check('整页 prompt 含标题/正文/结构约束', pf.includes('标题Y') && pf.includes('整页快照') && pf.includes('整页正文语境')
  && pf.includes('宁整勿碎') && pf.includes('章节脉络') && pf.includes('导航栏') && !pf.includes('【高亮片段】'));
check('整页 prompt 出处用 § 小节', pf.includes('〔§小节名〕') && !pf.includes('〔片段2〕'));
check('整页 prompt 无正文降级', buildMindmapFullPrompt({ title: 'T' }).includes('（没有网页正文）'));
const pf2 = buildMindmapFullPrompt({ text: 'x'.repeat(MINDMAP_MAX_CHARS + 500) });
check('整页 prompt 正文截断到上限', pf2.length < MINDMAP_MAX_CHARS + 600, pf2.length);

// ---- 出处标注拆分（渲染层小字角标 / 导出保留完整 label） ----
check('拆出处：片段式', splitRef('要点〔片段2〕').main === '要点' && splitRef('要点〔片段2〕').ref === '〔片段2〕');
check('拆出处：多来源与 § 小节', splitRef('A〔片段1、片段3〕').ref === '〔片段1、片段3〕'
  && splitRef('B〔§运行时架构〕').main === 'B' && splitRef('B〔§运行时架构〕').ref === '〔§运行时架构〕');
check('拆出处：无标注与纯标注不拆', splitRef('普通标签').ref === '' && splitRef('〔片段1〕').ref === '');
const refTree = parseOutline('- 甲\n  - 要点〔片段2〕')[0].children[0];
check('带出处的标签进树保持完整（导出/编辑往返不丢）', refTree.label === '要点〔片段2〕'
  && outlineToMarkdown({ label: '根', children: [refTree] }).includes('要点〔片段2〕'));

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
