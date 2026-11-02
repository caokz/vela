// 页面级任务（总结/翻译）的纯函数：prompt 构建 + 输出解析。
// 零 chrome 依赖，Node 可直接 `node src/llm/tasks.js` 自测（文件尾有自测入口）。

export const SUMMARY_MAX_CHARS = 12000;

// ---- 网页总结 ----

export function buildSummaryPrompt({ title, url, text }) {
  const clipped = (text || '').slice(0, SUMMARY_MAX_CHARS);
  return [
    `请总结下面的网页内容，用中文回复。要求：`,
    `1. 先用 2-3 句话概括核心内容；`,
    `2. 再用要点列表（最多 8 条）列出关键信息；`,
    `3. 如有数据、结论或行动建议，单独列出。`,
    ``,
    `网页标题：${title || '（无标题）'}`,
    `网页地址：${url || '（未知）'}`,
    ``,
    `网页正文：`,
    clipped,
  ].join('\n');
}

// ---- 连续阅读（连读：跟随「下一页」链接逐页读一组文档） ----

export const SERIES_PAGE_CHARS = 12000;

// 逐页总结：每页一次独立调用（map-reduce 的 map），无状态、互不依赖
export function buildSeriesPagePrompt({ index, title, url, text }) {
  const clipped = (text || '').slice(0, SERIES_PAGE_CHARS);
  return [
    `你正在连续阅读一组系列文档（教程 / 手册的连续页面），下面是第 ${index} 页。请用中文总结这一页：`,
    `1. 先一句话说明这页讲什么；`,
    `2. 再用要点列表（3~6 条）提炼关键概念、参数、步骤或结论；`,
    `3. 保留重要的术语、代码标识符与命令原文；正文里没有的内容不要编造。`,
    ``,
    `本页标题：${title || '（无标题）'}`,
    `本页地址：${url || '（未知）'}`,
    ``,
    `本页正文（可能截断）：`,
    clipped || '（这一页没有提取到正文）',
  ].join('\n');
}

// 收尾总览（reduce）：逐页摘要拼成一篇整体笔记
export function buildSeriesDigestPrompt({ start, pages }) {
  const items = (pages || []).map((p) => `【第 ${p.index} 页】${p.title || '（无标题）'}（${p.url || ''}）\n${p.summary || '（这一页没有总结）'}`).join('\n\n');
  return [
    `你刚连续读完一组文档（从 ${start || '起始页'} 开始，共 ${(pages || []).length} 页），以下是逐页摘要。请输出一篇整体笔记，用中文：`,
    `1. 先用 3~5 句话概括这组文档的整体主题与脉络；`,
    `2. 再按顺序给出每页要点（每页一行，格式「第 n 页 · 标题：要点」）；`,
    `3. 最后给出跨页的关键结论、易混淆点或建议的阅读 / 实践顺序（如有）。`,
    ``,
    `逐页摘要：`,
    items,
  ].join('\n');
}

// ---- 划词思维导图 ----

export const MINDMAP_MAX_CHARS = 12000;

// 颗粒度与结构约束（两种生成模式共用，防「零碎拆解」：用户报障过整句被拆成单词级节点）
const MINDMAP_GRAIN_RULES = [
  `2. 颗粒度宁整勿碎：叶子节点表达一个完整要点（可独立看懂的关键短句，一般 8~25 字），严禁把一句话拆成单词级子节点、严禁开同义重复的分支；一个父节点下子节点以 2~6 个为宜，没有真正的子结构就不要再加一层`,
  `3. 分支结构按网页原文的章节脉络组织：原文的章节/主题对应上级分支，相邻或同主题的内容归纳合并到同一支下，不逐条机械映射`,
];

// 让模型把高亮片段整理成 markdown 无序列表（查看页解析成树渲染）。
// text 是页面正文快照（上下文，可空），highlights 是组装好的高亮片段（重点）。
// 输出格式与 .md 导出格式同构：重新解析导出文件可还原同一棵树。
// 叶子节点带〔片段n〕出处标注（查看页 splitRef 渲染成小字角标）。
export function buildMindmapPrompt({ title, text, highlights }) {
  const ctx = (text || '').slice(0, MINDMAP_MAX_CHARS);
  const hl = (highlights || '').slice(0, MINDMAP_MAX_CHARS);
  return [
    `根据对下面网页内容的理解，把用户在其中高亮标注的片段整理成一篇思维导图大纲。要求：`,
    `1. 只输出一个 markdown 无序列表：顶层条目是主题分支，子条目每级缩进 2 个空格；顶层 3~6 个分支，总层级不超过 4 级；不要输出任何解释、开场白或总结`,
    ...MINDMAP_GRAIN_RULES,
    `4. 用户高亮的片段是重点内容：所有片段的要点必须保留（可归纳合并，不可遗漏）；网页里没被高亮的部分不要单独成支；忠实反映要点，不要编造原文没有的信息`,
    `5. 出处标注：来自高亮片段的叶子节点，末尾标注来源片段编号，如〔片段2〕，多个来源写成〔片段1、片段3〕；由上下文推理补全的节点不标注；素材里没有【片段n】编号时不标注`,
    `6. 用简体中文概括；专有名词、术语、代码标识符保留原文`,
    ``,
    `网页标题：${title || '（无标题）'}`,
    ``,
    ctx ? `网页正文（供理解上下文，可能截断）：\n${ctx}` : `（没有网页正文上下文，直接整理下面的片段）`,
    ``,
    `【高亮片段】：`,
    hl,
  ].join('\n');
}

// 整页模式：不用高亮素材，直接把整篇网页正文整理成思维导图。
// 出处标注用〔§小节名〕（原文的小节标题即出处）。
export function buildMindmapFullPrompt({ title, text }) {
  const ctx = (text || '').slice(0, MINDMAP_MAX_CHARS);
  return [
    `把下面这篇网页的完整内容整理成一篇思维导图大纲。要求：`,
    `1. 只输出一个 markdown 无序列表：顶层条目是主题分支，子条目每级缩进 2 个空格；顶层 3~8 个分支，总层级不超过 4 级；不要输出任何解释、开场白或总结`,
    ...MINDMAP_GRAIN_RULES,
    `4. 忽略导航栏、目录、页脚、版权声明、广告等与正文无关的内容；忠实反映原文要点，不要编造`,
    `5. 出处标注：叶子节点末尾标注其内容所在的原文小节，如〔§小节名〕（小节名过长可截短到 12 字内）；没有明确小节归属的叶子不标注`,
    `6. 用简体中文概括；专有名词、术语、代码标识符保留原文`,
    ``,
    `网页标题：${title || '（无标题）'}`,
    ``,
    `网页正文（整页快照，可能截断）：`,
    ctx || `（没有网页正文）`,
  ].join('\n');
}

// ---- 网页媒体理解（图片 / 视频关键帧，附件随 user 消息下发） ----

// mode：'analyze' 分析内容 | 'extract' 逐字提取（OCR/表格/代码）| 'describe' 一句话概括（进导图素材）
export function buildImagePrompt({ mode, alt = '', src = '' }) {
  const asks = {
    analyze: '请分析这张网页图片：主体是什么、有哪些关键信息 / 数据 / 结论，用中文分点简明输出。图里看不清或没有的内容不要编造。',
    extract: '请把这张图片里的内容完整提取成文本：图中所有文字逐字保留（标题、标注、图例、坐标轴刻度、表格单元格都算），表格输出 markdown 表格，代码 / 命令输出代码块；纯图形部分各用一句话描述。不要遗漏、不要编造。',
    describe: '请用一两句话概括这张图片的内容要点，作为思维导图的素材使用；不要编造。',
  };
  const ctx = [alt && `图片说明：${alt}`, src && !src.startsWith('data:') && `图片来源：${src}`].filter(Boolean);
  return [asks[mode] || asks.analyze, ...ctx, '图片见本消息附带的图片内容。'].filter(Boolean).join('\n');
}

// 视频按时间轴抽关键帧后整包给视觉模型：mode 'analyze' 看内容演进 / 'extract' 逐帧提文字
export function buildVideoFramesPrompt({ mode, count, note = '' }) {
  const ask = mode === 'extract'
    ? '请按时间顺序逐帧查看这些视频关键帧，把画面里出现的所有文字逐字提取出来（字幕、标题、界面文案都算），并标注出现的先后顺序；纯图形内容用一句话概括。不要编造。'
    : '请按时间顺序查看这些视频关键帧，分析视频的主题与内容演进：讲的是什么、按先后发生了什么、有哪些关键信息或结论，用中文分点简明输出。看不清的不要编造。';
  return [ask, `共 ${count} 帧，按时间先后排列${note ? `（${note}）` : ''}。`].join('\n');
}

// ---- 翻译批处理 ----

export const TRANSLATE_BATCH_CHARS = 2400;

export function buildTranslateBatchPrompt({ items, targetLang }) {
  const lines = items.map((it, i) => `${i + 1}. ${it.text}`);
  return [
    `把下面的 ${items.length} 个编号段落翻译成${targetLang}。要求：`,
    `- 只输出一个 JSON 字符串数组，不要输出任何其他文字、解释或代码围栏`,
    `- 数组第 n 项是第 n 段的译文；与原文一一对应，数量必须相同`,
    `- 代码、命令行、路径、配置键值、环境变量、代码标识符、URL、邮箱、数字、公式保持原样不翻译；确实无法翻译的段落输出 null`,
    ``,
    lines.join('\n'),
  ].join('\n');
}

export function buildTranslateRetryPrompt({ items, targetLang }) {
  return [
    buildTranslateBatchPrompt({ items, targetLang }),
    ``,
    `注意：上一次输出无法解析。严格只输出 JSON 数组本身，以 [ 开头、] 结尾。`,
  ].join('\n');
}

// 解析模型输出为译文数组。五级容错，返回 (string|null)[]，长度与 items 对齐。
// 规则：解析出但为 null/空串 → null（标记失败）；多则截断、少则前缀生效余者 null。
export function parseTranslationArray(raw, count) {
  if (!raw || !raw.trim()) return fillFail(count);
  const text = raw.trim();

  // 1. 直接 parse
  let arr = tryParse(text);
  // 2. 剥 markdown 围栏 ```json ... ```
  if (!arr) arr = tryParse(text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, ''));
  // 3. 首个 [ 到末个 ] 的子串
  if (!arr) {
    const s = text.indexOf('[');
    const e = text.lastIndexOf(']');
    if (s !== -1 && e > s) arr = tryParse(text.slice(s, e + 1));
  }
  // 4. {"translations":[...]} 形态（第 3 步已能切出，但 JSON 对象里带转义时兜底）
  if (!arr) {
    const m = text.match(/"translations"\s*:\s*(\[[\s\S]*)/);
    if (m) {
      const s = m[1].indexOf('[');
      const e = m[1].lastIndexOf(']');
      if (s !== -1 && e > s) arr = tryParse(m[1].slice(s, e + 1));
    }
  }
  // 5. 字符串字面量正则兜底（数组被截断、JSON 非法但字面量完整时仍可抢救）
  if (!arr) {
    const lits = text.match(/"(?:[^"\\]|\\.)*"/g);
    if (lits && lits.length) {
      try {
        arr = lits.map((l) => JSON.parse(l));
      } catch { arr = null; }
    }
  }
  if (!Array.isArray(arr)) return fillFail(count);

  const out = arr.map((v) => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t ? t : null;
  });
  // 长度对齐：短则前缀生效，长则截断
  if (out.length < count) return [...out, ...fillFail(count - out.length)];
  return out.slice(0, count);
}

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

function fillFail(n) {
  return Array.from({ length: n }, () => null);
}

// 按字符预算切块：块数或总字符先到为准。返回 items 数组的切片下标区间列表。
export function planBatches(items, { maxBlocks = 12, maxChars = TRANSLATE_BATCH_CHARS } = {}) {
  const batches = [];
  let cur = [];
  let curChars = 0;
  for (const it of items) {
    const len = it.text.length;
    if (cur.length && (cur.length >= maxBlocks || curChars + len > maxChars)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(it);
    curChars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ---- Node 自测入口：node src/llm/tasks.js ----
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('tasks.js')) {
  const assert = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) process.exitCode = 1;
  };
  const P = buildSummaryPrompt({ title: 'T', url: 'https://x', text: 'hello' });
  assert('总结 prompt 含标题与正文', P.includes('T') && P.includes('hello') && P.includes('要点'));

  const SP = buildSeriesPagePrompt({ index: 3, title: 'DataStream API', url: 'https://x/p3', text: 'PAGE3-内容'.repeat(50) });
  assert('连读逐页 prompt：序号/标题/地址/正文与约束', SP.includes('第 3 页') && SP.includes('DataStream API') && SP.includes('https://x/p3') && SP.includes('PAGE3-内容') && SP.includes('不要编造'));
  assert('连读逐页 prompt：空正文降级说明', buildSeriesPagePrompt({ index: 1, title: 'T', url: 'u', text: '' }).includes('（这一页没有提取到正文）'));
  const SD = buildSeriesDigestPrompt({ start: 'https://x/p1', pages: [{ index: 1, title: '起步', url: 'https://x/p1', summary: '第一页要点' }, { index: 2, title: '进阶', url: 'https://x/p2', summary: '' }] });
  assert('连读总览 prompt：起始/页数/逐页摘要/格式', SD.includes('https://x/p1') && SD.includes('共 2 页') && SD.includes('【第 1 页】起步') && SD.includes('第一页要点') && SD.includes('（这一页没有总结）') && SD.includes('每页一行'));

  const MP = buildMindmapPrompt({ title: '导图主题', text: '网页正文', highlights: '【片段1】\n高亮A' });
  assert('导图 prompt 含标题/上下文/片段与格式要求', MP.includes('导图主题') && MP.includes('网页正文') && MP.includes('高亮A') && MP.includes('【高亮片段】') && MP.includes('无序列表'));
  assert('导图 prompt 无上下文时降级说明', buildMindmapPrompt({ title: 'T', highlights: '片段内容' }).includes('没有网页正文上下文'));
  assert('导图 prompt 颗粒度与出处约束', MP.includes('宁整勿碎') && MP.includes('单词级') && MP.includes('章节脉络') && MP.includes('〔片段2〕') && MP.includes('不可遗漏'));
  const MF = buildMindmapFullPrompt({ title: '整页主题', text: '整页正文' });
  assert('整页 prompt 含正文/结构/出处要求', MF.includes('整页快照') && MF.includes('整页正文') && !MF.includes('【高亮片段】') && MF.includes('宁整勿碎') && MF.includes('〔§小节名〕') && MF.includes('导航栏'));
  assert('整页 prompt 无正文降级说明', buildMindmapFullPrompt({ title: 'T' }).includes('（没有网页正文）'));

  const IA = buildImagePrompt({ mode: 'analyze', alt: '架构图', src: 'https://x/i.png' });
  assert('图片分析 prompt：要求/说明/来源', IA.includes('分析这张网页图片') && IA.includes('架构图') && IA.includes('https://x/i.png') && IA.includes('不要编造'));
  assert('图片提取 prompt：逐字与表格要求', buildImagePrompt({ mode: 'extract' }).includes('逐字保留') && buildImagePrompt({ mode: 'extract' }).includes('markdown 表格'));
  assert('图片一句话 prompt（进导图素材）', buildImagePrompt({ mode: 'describe', alt: '', src: 'data:image/png;base64,x' }).includes('一两句话概括')
    && !buildImagePrompt({ mode: 'describe', alt: '', src: 'data:image/png;base64,x' }).includes('data:image'));
  const VP = buildVideoFramesPrompt({ mode: 'analyze', count: 4, note: '时长约 60 秒' });
  assert('视频关键帧 prompt：帧数/顺序/注记', VP.includes('关键帧') && VP.includes('共 4 帧') && VP.includes('时长约 60 秒'));
  assert('视频提取 prompt：逐帧提文字', buildVideoFramesPrompt({ mode: 'extract', count: 3 }).includes('逐字提取'));

  const items = [{ id: 'a', text: 'Hello world' }, { id: 'b', text: 'Goodbye' }];
  const tp = buildTranslateBatchPrompt({ items, targetLang: '中文' });
  assert('翻译 prompt 编号行', tp.includes('1. Hello world') && tp.includes('2. Goodbye'));

  const ok = parseTranslationArray('["你好，世界","再见"]', 2);
  assert('合法 JSON', ok[0] === '你好，世界' && ok[1] === '再见');
  assert('数量不符（短）', parseTranslationArray('["只有一条"]', 2)[1] === null);
  const long = parseTranslationArray('["一","二","三"]', 2);
  assert('数量不符（长截断）', long.length === 2 && long[0] === '一');
  const fenced = parseTranslationArray('```json\n["甲","乙"]\n```', 2);
  assert('markdown 围栏', fenced[0] === '甲' && fenced[1] === '乙');
  const junk = parseTranslationArray('好的，翻译如下：["甲","乙"]，希望有帮助', 2);
  assert('前后缀包裹', junk[0] === '甲' && junk[1] === '乙');
  const obj = parseTranslationArray('{"translations": ["甲", "乙"]}', 2);
  assert('translations 包装', obj[0] === '甲' && obj[1] === '乙');
  const nulls = parseTranslationArray('["甲", null]', 2);
  assert('null 段标记失败', nulls[0] === '甲' && nulls[1] === null);
  const lits = parseTranslationArray('["第一段\\n带换行","第二段', 2);
  assert('截断字面量兜底', lits[0] === '第一段\n带换行' && lits[1] === null);
  assert('空输出', parseTranslationArray('', 1).every((v) => v === null));

  const long_items = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, text: 'x'.repeat(300) }));
  const batches = planBatches(long_items);
  assert('切块：2400 字符预算 → 8 字/块', batches.length === 4 && batches[0].length === 8, `batches=${batches.length}, first=${batches[0]?.length}`);
  assert('切块：块总数守恒', batches.reduce((s, b) => s + b.length, 0) === 30);
}
