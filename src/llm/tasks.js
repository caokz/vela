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
