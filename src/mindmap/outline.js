// 思维导图大纲的纯函数层：markdown 大纲 → 树、树 → markdown / FreeMind XML。
// 零 chrome 依赖，Node 可直接 `node src/mindmap/outline.js` 自测（文件尾有自测入口）。

// 标签清洗：去掉 **加粗**、__强调__、*斜体*、`代码`、[链接](url)、![图](url) 的标记只留
// 纯文本——节点标签与 FreeMind TEXT 都要纯文本，而模型输出常带行内修饰。
export function cleanLabel(s) {
  return String(s || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')        // 图片 → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // 链接 → 文字
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2') // 加粗
    .replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')    // 斜体
    .replace(/`([^`]*)`/g, '$1')                     // 行内代码
    .replace(/\s+/g, ' ')
    .trim();
}

// 解析 markdown 大纲为顶层节点数组（调用方自行包一层根）。支持：
// - 标题层级 #~######（level = # 数）；标题后的列表项挂在标题层之下
// - 嵌套列表 -/+/*/1.，2/4 空格或 tab 缩进（缩进栈推断层级，不依赖固定步长）
// - ``` 围栏整块忽略（模型有时给 markdown 代码块包一层）；结构行之前的前言行忽略
// 没有解析出任何结构行时返回 null。
export function parseOutline(md) {
  if (!md || !String(md).trim()) return null;
  const roots = [];
  const stack = [];       // {level, node}：当前挂载路径
  const listIndents = []; // 当前列表块的缩进栈
  let headingBase = 1;    // 列表项层级 = 最近标题层 + 缩进深度；无标题时从第 1 层起
  let saw = false;
  let fenced = false;
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '    ');
    if (/^\s*(```+|~~~+)/.test(line)) {
      // 结构内容出现前的围栏是「模型把整份大纲包了一层 ```markdown」：只剥标记，内容保留。
      // 出现后的围栏才是真代码块：切换开关跳过其内容
      if (!saw) continue;
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    let level = 0;
    let label = '';
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      level = h[1].length;
      label = h[2];
      headingBase = level + 1;
      listIndents.length = 0; // 标题块与列表块相互独立，标题重置列表缩进
    } else {
      const li = line.match(/^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.+)$/);
      if (!li) continue;
      const indent = li[1].length;
      while (listIndents.length && indent < listIndents[listIndents.length - 1]) listIndents.pop();
      if (!listIndents.length || indent > listIndents[listIndents.length - 1]) listIndents.push(indent);
      level = headingBase + listIndents.length - 1;
      label = li[2];
    }
    const text = cleanLabel(label);
    if (!text) continue;
    saw = true;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const node = { label: text, children: [] };
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ level, node });
  }
  return saw && roots.length ? roots : null;
}

// 标签尾部的出处标注（生成时带的〔片段2〕/〔§小节名〕）：渲染层拆出来显示成小字
// 角标，导出 .md/.mm 与编辑往返保留完整 label（splitRef 只读不改树）。
export function splitRef(label) {
  const s = String(label || '');
  const m = s.match(/^(.*?)(?:〔[^〔〕]*〕)+$/);
  if (!m || !m[1].trim()) return { main: s.trim(), ref: '' }; // 无标注 / 整个标签都是标注：不拆
  return { main: m[1].trim(), ref: s.slice(m[1].length).trim() };
}

export function countNodes(tree) {
  let n = 0;
  const walk = (t) => { n++; (t.children || []).forEach(walk); };
  walk(tree);
  return n;
}

// 树 → 规范 markdown（导出 .md）。根作一级标题，子层是 2 空格缩进的无序列表，
// 与 parseOutline 输入格式同构：重新解析导出文件可还原同一棵树。
export function outlineToMarkdown(tree) {
  const out = [`# ${tree.label || '思维导图'}`];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      out.push(`${'  '.repeat(depth)}- ${n.label}`);
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(tree.children || [], 0);
  return out.join('\n') + '\n';
}

const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
));

// 树 → FreeMind 1.0.1 XML（导出 .mm，XMind / FreeMind / 幕布等均可导入）。
export function outlineToFreemind(tree) {
  const one = (n, depth) => {
    const pad = '  '.repeat(depth + 1);
    const kids = (n.children || []).map((c) => one(c, depth + 1)).join(`\n${pad}`);
    return kids
      ? `<node TEXT="${escXml(n.label)}">\n${pad}${kids}\n${'  '.repeat(depth)}</node>`
      : `<node TEXT="${escXml(n.label)}"/>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.0.1">\n  ${one(tree, 0)}\n</map>\n`;
}

// ---- Node 自测入口：node src/mindmap/outline.js ----
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('outline.js')) {
  const assert = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) process.exitCode = 1;
  };
  const t = parseOutline('- 甲\n  - 甲一\n  - 甲二\n- 乙');
  assert('纯嵌套列表', t?.length === 2 && t[0].children.length === 2 && t[1].children.length === 0, JSON.stringify(t));
  const h = parseOutline('# 根\n## 甲\n- 甲一\n  1. 孙\n## 乙');
  assert('标题 + 挂靠标题的列表', h?.length === 1 && h[0].label === '根' && h[0].children.length === 2
    && h[0].children[0].children[0].children.length === 1, JSON.stringify(h));
  assert('空输入返回 null', parseOutline('') === null && parseOutline('随便一句话\n没有结构') === null);
  assert('出处标注拆分：片段式', splitRef('要点〔片段2〕').main === '要点' && splitRef('要点〔片段2〕').ref === '〔片段2〕');
  assert('出处标注拆分：多来源与 § 小节', splitRef('A〔片段1、片段3〕').ref === '〔片段1、片段3〕' && splitRef('A〔§运行时架构〕').main === 'A');
  assert('出处标注拆分：无标注 / 纯标注不拆', splitRef('普通标签').ref === '' && splitRef('〔片段1〕').main === '〔片段1〕' && splitRef('〔片段1〕').ref === '');
  const fw = parseOutline('```markdown\n- 甲\n  - 甲一\n```\n希望有帮助');
  assert('整份围栏包裹：剥标记留内容', fw?.length === 1 && fw[0].children.length === 1, JSON.stringify(fw));
  const md = outlineToMarkdown({ label: '根 <A&B>', children: [{ label: '分支', children: [] }] });
  assert('markdown 导出根标题', md.startsWith('# 根 <A&B>\n- 分支\n'), md);
  const mm = outlineToFreemind({ label: '根"a&b', children: [{ label: '子<c>', children: [] }] });
  assert('FreeMind 转义与包裹', mm.startsWith('<?xml') && mm.includes('<map version="1.0.1">') && mm.includes('TEXT="根&quot;a&amp;b"') && mm.includes('TEXT="子&lt;c&gt;"'), mm);
}
