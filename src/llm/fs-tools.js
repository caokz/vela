// LLM 任务模式的本机知识库工具：list_files / search_files / read_file（只读，直接执行）、
// write_file / edit_file（先弹审批卡并展示 diff）、load_skill（说明型 skill）。
// roots 来自会话知识库里浏览器授权的文件夹 / 文件（kb/store.js loadRoots），授权范围即用户所选目录。

import {
  walk, locate, classify, readFileHandle, readRawText, lineDiff, formatDiff, parseSkill, resolveRoot,
  fmtSize, looksBinary, decodeText, LIMITS,
} from '../kb/files.js';
import { ensurePermission } from '../kb/store.js';

const MAX_SKILLS = 50;
const WRITABLE = (name) => !['docx', 'xlsx', 'pptx', 'pdf', 'image', 'legacy-office'].includes(classify(name));

// 简易 glob：* ? 与 **；不含 / 时只匹配文件名
function globRe(glob) {
  const g = String(glob).trim();
  const src = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return { re: new RegExp(`^${src}$`, 'i'), byName: !g.includes('/') };
}

/**
 * 扫描各知识库目录下的 .vela/skills/<名称>/SKILL.md
 * @returns {Promise<Array<{ name, description, dir: string, root }>>}
 */
export async function discoverSkills(roots) {
  const skills = [];
  for (const root of roots.filter((r) => r.kind === 'dir')) {
    let base;
    try { base = await root.handle.getDirectoryHandle('.vela').then((d) => d.getDirectoryHandle('skills')); } catch { continue; }
    for await (const [name, h] of base.entries()) {
      if (h.kind !== 'directory' || skills.length >= MAX_SKILLS) continue;
      try {
        const fh = await h.getFileHandle('SKILL.md');
        const s = parseSkill(decodeText(new Uint8Array(await (await fh.getFile()).arrayBuffer())), name);
        skills.push({ name: s.name, description: s.description, dir: `${root.name}/.vela/skills/${name}`, root });
      } catch { /* 没有 SKILL.md 的目录跳过 */ }
    }
  }
  return skills;
}

export function fsSystemPrompt(roots, skills) {
  if (!roots.length) return '';
  const lines = [
    '本对话的知识库（用户本机的文件夹 / 文件）：',
    ...roots.map((r) => `- ${r.name}${r.kind === 'dir' ? '/（文件夹）' : '（文件）'}`),
    `调用文件工具时路径以知识库名称开头，例如 ${roots[0].name}${roots[0].kind === 'dir' ? '/src/Main.java' : ''}。`,
    '分析项目时先 list_files 看结构、search_files 定位关键词，再 read_file 细读相关文件；不要一次读取大量无关文件。',
    '搜索没找到时先自查再下结论：换同义词 / 类名的其他写法、用 glob 或 path 缩小范围重搜；search_files 结果末尾若有「⚠ 没有搜全」，说明没找到不等于不存在，必须按提示缩小范围继续搜。',
    '确认知识库里确实没有，再告诉用户「知识库里没有 X」并说明你准备联网获取什么；联网读取的 URL 必须来自知识库 / 网页里出现过的链接或你已核实的地址，不要凭记忆拼写分支名和包路径。',
    'read_file 支持文本 / 代码（带行号）、docx、xlsx、pptx（转成 Markdown），PDF 与图片会作为附件直接交给你阅读。',
    'write_file / edit_file 会修改用户本机文件，执行前用户会看到 diff 并确认；只在用户要求修改时使用，优先用 edit_file 做小范围修改。',
  ];
  if (skills.length) {
    lines.push('', '可用的 skill（用户提供的操作说明；任务与描述相符时先调用 load_skill 读取完整说明再照做）：');
    for (const s of skills) lines.push(`- ${s.name}：${s.description || '（无描述）'}`);
  }
  return lines.join('\n');
}

export function createFsTools(roots, skills = []) {
  if (!roots.length) return [];
  const tools = [
    {
      name: 'list_files',
      description: '列出知识库目录结构（文件带大小）。自动跳过 node_modules、.git、dist、build 等目录。不传 path 时列出所有知识库的顶层。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，以知识库名称开头；省略则从各知识库根开始' },
          depth: { type: 'integer', description: '展开层数，默认 2，最大 6' },
        },
      },
      summarize: (a) => a.path || '知识库',
      run: async (args) => {
        const depth = Math.min(6, Math.max(1, Number.isInteger(args.depth) ? args.depth : 2));
        const targets = args.path ? [await locate(roots, args.path)] : roots.map((r) => ({ root: r, handle: r.handle, kind: r.kind, rel: r.name }));
        const out = [];
        const MAX = 500;
        for (const t of targets) {
          if (t.kind === 'file') {
            const f = await t.handle.getFile();
            out.push(`${t.rel}（${fmtSize(f.size)}）`);
            continue;
          }
          out.push(`${t.rel}/`);
          await walk(t.handle, t.rel, async ({ name, kind, handle, depth: d }) => {
            if (out.length >= MAX) return 'stop';
            const pad = '  '.repeat(d);
            if (kind === 'dir') { out.push(`${pad}${name}/`); return d < depth; }
            const f = await handle.getFile();
            out.push(`${pad}${name}（${fmtSize(f.size)}）`);
            return true;
          }, { maxDepth: depth });
        }
        if (out.length >= MAX) out.push(`…（条目过多，仅显示前 ${MAX} 项；请指定子目录 path 继续查看）`);
        return out.join('\n');
      },
    },
    {
      name: 'search_files',
      description: '在知识库的文本 / 代码文件里搜索关键词或正则，返回「路径:行号: 内容」，同时列出文件名匹配的文件。Office、PDF、二进制文件不参与内容搜索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词（默认不区分大小写）或正则表达式' },
          regex: { type: 'boolean', description: 'query 是否按正则解释，默认 false' },
          case_sensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
          path: { type: 'string', description: '限定搜索的目录或文件，以知识库名称开头；省略则搜索全部知识库' },
          glob: { type: 'string', description: '文件过滤，如 *.java、src/**/*.ts' },
          max_results: { type: 'integer', description: '最多返回的匹配行数，默认 80，最大 300' },
        },
        required: ['query'],
      },
      summarize: (a) => `${a.query}${a.glob ? `（${a.glob}）` : ''}`,
      run: async (args, { signal }) => {
        const max = Math.min(300, Math.max(1, Number.isInteger(args.max_results) ? args.max_results : 80));
        let re;
        try {
          re = new RegExp(args.regex ? args.query : String(args.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), args.case_sensitive ? '' : 'i');
        } catch (e) {
          throw new Error(`正则无效：${e.message}`);
        }
        const g = args.glob ? globRe(args.glob) : null;
        const targets = args.path ? [await locate(roots, args.path)] : roots.map((r) => ({ root: r, handle: r.handle, kind: r.kind, rel: r.name }));
        // 阶段 1：遍历整棵树，只看名字——文件名匹配在这里就能找到（不读内容，便宜），并收集待读的候选文件
        const nameHits = [];
        const files = []; // { fh, path }
        let walkTruncated = false;
        const partial = [];
        const consider = (fh, path) => {
          const name = path.split('/').pop();
          if (re.test(name)) nameHits.push(path);
          if (g && !g.re.test(g.byName ? name : path.split('/').slice(1).join('/'))) return;
          const type = classify(name);
          if (type !== 'text' && type !== 'unknown') return;
          files.push({ fh, path });
        };
        for (const t of targets) {
          if (t.kind === 'file') { consider(t.handle, t.rel); continue; }
          const w = await walk(t.handle, t.rel, ({ path, kind, handle }) => { if (kind === 'file') consider(handle, path); return true; }, { signal });
          if (w.truncated) walkTruncated = true;
          partial.push(...w.partialDirs);
        }
        // 阶段 2：并发读取候选文件内容并匹配（经 bridge 时是并发请求），总时限内尽量读完
        const found = []; // { idx, line, text }
        let scanned = 0;
        let skippedBig = 0;
        let timedOut = false;
        let next = 0;
        const deadline = Date.now() + LIMITS.searchBudgetMs;
        const worker = async () => {
          for (;;) {
            if (signal?.aborted || found.length >= max * 2) return;
            if (Date.now() > deadline) { timedOut = true; return; }
            const idx = next++;
            if (idx >= files.length) return;
            try {
              const file = await files[idx].fh.getFile();
              if (file.size > LIMITS.searchFileBytes) { skippedBig++; continue; }
              const bytes = new Uint8Array(await file.arrayBuffer());
              if (looksBinary(bytes)) continue;
              scanned++;
              const lines = decodeText(bytes).split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) found.push({ idx, line: i + 1, text: lines[i].trim().slice(0, 300) });
            } catch { /* 单个文件读不了（被占用 / 刚被删）不影响整体 */ }
          }
        };
        await Promise.all(Array.from({ length: LIMITS.searchConcurrency }, worker));
        found.sort((x, y) => x.idx - y.idx || x.line - y.line); // 并发读取的完成顺序不定，按遍历顺序输出
        const hits = found.slice(0, max).map((h) => `${files[h.idx].path}:${h.line}: ${h.text}`);
        const out = [];
        if (nameHits.length) out.push(`文件名匹配（${nameHits.length}）：`, ...nameHits.slice(0, 50).map((p) => `- ${p}`), '');
        out.push(hits.length ? `内容匹配（${hits.length}${found.length > max ? '+，已达上限' : ''}，扫描 ${scanned} 个文件）：` : `内容无匹配（扫描 ${scanned} 个文件）`);
        out.push(...hits);
        // 覆盖说明：没搜全时必须明说，否则「无匹配」会被当成「知识库里没有」
        const warn = [];
        if (walkTruncated) warn.push(`目录遍历达到 ${LIMITS.walkEntries} 个条目上限，排在后面的目录没有搜到`);
        if (partial.length) warn.push(`这些目录条目过多、只列出了一部分：${partial.slice(0, 5).join('、')}${partial.length > 5 ? ` 等 ${partial.length} 个` : ''}`);
        if (timedOut) warn.push(`读取文件内容超过 ${LIMITS.searchBudgetMs / 1000} 秒，只扫描了 ${scanned} / ${files.length} 个候选文件`);
        if (skippedBig) warn.push(`${skippedBig} 个超过 ${fmtSize(LIMITS.searchFileBytes)} 的文件未搜索内容`);
        if (warn.length) out.push('', `⚠ 没有搜全：${warn.join('；')}。请用 path 限定到具体子目录、或用 glob 缩小范围后再搜，不要据此断定知识库里没有。`);
        else if (!hits.length && !nameHits.length) out.push('', `（已完整遍历 ${files.length} 个文本文件，确实没有匹配。可换同义关键词 / 正则再试，或用 list_files 确认目录里有什么。）`);
        return out.join('\n');
      },
    },
    {
      name: 'read_file',
      description: '读取知识库里的文件。文本 / 代码带行号返回，可用 start_line / end_line 分段读；docx / pptx 转 Markdown；xlsx 按工作表转表格（可选 sheet、max_rows）；PDF 与图片作为附件交给你阅读。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，以知识库名称开头' },
          start_line: { type: 'integer', description: '起始行（含），文本文件有效' },
          end_line: { type: 'integer', description: '结束行（含），文本文件有效' },
          sheet: { type: 'string', description: 'xlsx 工作表名称，省略则读全部' },
          max_rows: { type: 'integer', description: 'xlsx 每个工作表最多读取行数，默认 200' },
        },
        required: ['path'],
      },
      summarize: (a) => `${a.path}${a.start_line ? `:${a.start_line}-${a.end_line ?? ''}` : ''}`,
      run: async (args) => {
        const t = await locate(roots, args.path, { kind: 'file' });
        return readFileHandle(t.handle, t.rel, { startLine: args.start_line, endLine: args.end_line, sheet: args.sheet, maxRows: args.max_rows });
      },
    },
    {
      name: 'write_file',
      description: '新建或整体覆盖知识库文件夹里的一个文本文件（会自动创建中间目录）。修改已有文件的局部内容请用 edit_file。不能写 Office / PDF / 图片。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，以知识库名称开头' },
          content: { type: 'string', description: '文件的完整内容' },
        },
        required: ['path', 'content'],
      },
      needsApproval: true,
      summarize: (a) => a.path,
      approvalText: (a) => `写入文件 ${a.path}`,
      approvalDetail: async (a) => {
        const old = await locate(roots, a.path, { kind: 'file' }).then((t) => readRawText(t.handle)).catch(() => null);
        const d = formatDiff(lineDiff(old ?? '', a.content));
        return { title: old == null ? `新建文件 ${a.path}（${String(a.content).split(/\r?\n/).length} 行）` : `覆盖文件 ${a.path}（+${d.add} −${d.del}）`, diff: d.text };
      },
      run: async (args) => {
        const { root } = resolveRoot(roots, args.path);
        if (!WRITABLE(args.path)) throw new Error('只能写入文本类文件，Office / PDF / 图片不支持写入');
        await requireWrite(root);
        const t = await locate(roots, args.path, { kind: 'file', create: true });
        const old = await readRawText(t.handle).catch(() => null);
        await writeText(t.handle, args.content);
        return `${old ? '已覆盖' : '已新建'} ${t.rel}（${String(args.content).split(/\r?\n/).length} 行）`;
      },
    },
    {
      name: 'edit_file',
      description: '在知识库的文本文件里把 old_string 精确替换为 new_string。old_string 必须在文件中唯一（或设置 replace_all），需包含足够的上下文；先用 read_file 确认原文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，以知识库名称开头' },
          old_string: { type: 'string', description: '要替换的原文（完全一致，含缩进）' },
          new_string: { type: 'string', description: '替换后的内容' },
          replace_all: { type: 'boolean', description: '替换所有出现处，默认 false' },
        },
        required: ['path', 'old_string'],
      },
      needsApproval: true,
      summarize: (a) => a.path,
      approvalText: (a) => `编辑文件 ${a.path}`,
      approvalDetail: async (a) => {
        const t = await locate(roots, a.path, { kind: 'file' });
        const old = await readRawText(t.handle);
        const next = applyEdit(old, a);
        const d = formatDiff(lineDiff(old, next));
        return { title: `编辑文件 ${a.path}（+${d.add} −${d.del}）`, diff: d.text };
      },
      run: async (args) => {
        const { root } = resolveRoot(roots, args.path);
        await requireWrite(root);
        const t = await locate(roots, args.path, { kind: 'file' });
        const old = await readRawText(t.handle);
        const next = applyEdit(old, args);
        await writeText(t.handle, next);
        const d = formatDiff(lineDiff(old, next));
        return `已修改 ${t.rel}（+${d.add} −${d.del} 行）`;
      },
    },
  ];
  if (skills.length) {
    tools.push({
      name: 'load_skill',
      description: `读取一个 skill 的完整说明（SKILL.md）及其目录下的附带文件清单。可用：${skills.map((s) => s.name).join('、')}`,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', enum: skills.map((s) => s.name), description: 'skill 名称' } },
        required: ['name'],
      },
      summarize: (a) => a.name,
      run: async (args) => {
        const s = skills.find((x) => x.name === args.name);
        const dir = await locate(roots, s.dir, { kind: 'dir' });
        const md = await locate(roots, `${s.dir}/SKILL.md`, { kind: 'file' });
        const body = parseSkill(await readRawText(md.handle), s.name).body;
        const files = [];
        await walk(dir.handle, s.dir, ({ path, kind }) => { if (kind === 'file' && !path.endsWith('/SKILL.md')) files.push(path); return true; }, { maxDepth: 4 });
        return [`# skill：${s.name}`, '', body.trim(), ...(files.length ? ['', '附带文件（可用 read_file 读取）：', ...files.map((f) => `- ${f}`)] : [])].join('\n');
      },
    });
  }
  return tools;
}

// 精确替换：CRLF 文件里模型给的 \n 片段按 \r\n 再匹配一次
export function applyEdit(text, { old_string: oldStr, new_string: newStr = '', replace_all: all }) {
  if (!oldStr) throw new Error('old_string 不能为空');
  let o = oldStr;
  let n = newStr;
  if (!text.includes(o) && text.includes('\r\n') && o.includes('\n')) {
    o = o.replace(/\r?\n/g, '\r\n');
    n = n.replace(/\r?\n/g, '\r\n');
  }
  const count = text.split(o).length - 1;
  if (!count) throw new Error('old_string 在文件中找不到：请先 read_file 确认原文（含缩进与空格）');
  if (count > 1 && !all) throw new Error(`old_string 在文件中出现 ${count} 次：请加入更多上下文使其唯一，或设置 replace_all`);
  return all ? text.split(o).join(n) : text.replace(o, () => n);
}

async function requireWrite(root) {
  // 审批卡「允许」点击刚发生，处于用户手势内，可弹出写入授权
  const state = await ensurePermission(root.handle, 'readwrite', true);
  if (state !== 'granted') throw new Error(`没有「${root.name}」的写入授权（浏览器授权被拒绝或未弹出）`);
}

async function writeText(fh, content) {
  const w = await fh.createWritable();
  await w.write(String(content));
  await w.close();
}
