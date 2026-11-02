// 本机知识库（浏览器授权的文件夹 / 文件）读写核心：路径解析、目录遍历、按格式读取、
// 文本解码、行级 diff、skill 说明解析。句柄来自 File System Access API
// （showDirectoryPicker / showOpenFilePicker），授权范围天然限定在用户选的目录内。
// 纯函数部分（normalizePath / lineDiff / parseSkill / classify）不碰浏览器 API，Node 下可单测。

import { docxToText, xlsxToText, pptxToText } from './office.js';

// 遍历 / 搜索时跳过的目录：依赖、构建产物、版本库、IDE 缓存
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', '.idea', '__pycache__',
  '.venv', 'venv', '.gradle', '.next', '.nuxt', 'coverage', '.cache', '.pytest_cache', '.mvn', 'bin', 'obj',
]);

const TEXT_EXT = new Set(('md markdown txt text rst adoc csv tsv log json jsonc json5 yaml yml toml ini cfg conf properties env '
  + 'xml html htm xhtml css scss sass less svg vue svelte astro js mjs cjs jsx ts tsx mts cts '
  + 'java kt kts scala groovy gradle py pyi rb php go rs c h cc cpp cxx hpp hh cs fs vb swift m mm '
  + 'dart lua pl pm r jl ex exs erl hrl clj cljs elm hs ml mli sh bash zsh fish ps1 psm1 bat cmd '
  + 'sql graphql gql proto thrift tf hcl dockerfile makefile cmake mk lock gitignore gitattributes editorconfig '
  + 'tex bib ipynb').split(/\s+/));
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export const LIMITS = {
  textBytes: 2 * 1024 * 1024, // 单个文本文件读取上限
  officeBytes: 30 * 1024 * 1024,
  pdfBytes: 15 * 1024 * 1024,
  imageBytes: 5 * 1024 * 1024,
  readChars: 60000, // read_file 单次返回字符上限
  searchFileBytes: 1024 * 1024, // 搜索跳过更大的文件
  walkEntries: 300000, // 单次遍历最多访问的条目数（Flink 这类大仓库有数万文件；超限时搜索结果会明确提示没搜全）
  searchBudgetMs: 40000, // search_files 读取文件内容的总时限
  searchConcurrency: 16, // 并发读取文件数（经 bridge 时是并发的 WebSocket 请求）
};

// 文件类型：text | docx | xlsx | pptx | pdf | image | legacy-office | unknown
export function classify(name) {
  const lower = String(name).toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() : lower;
  if (['docx', 'xlsx', 'pptx'].includes(ext)) return ext;
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_MIME[ext]) return 'image';
  if (['doc', 'xls', 'ppt'].includes(ext)) return 'legacy-office';
  if (TEXT_EXT.has(ext) || /^(dockerfile|makefile|readme|license|changelog|\.[\w.-]+rc)$/i.test(lower)) return 'text';
  return 'unknown';
}

// 模型给的路径 → 段数组。统一 / 分隔，去掉 ./ 与首尾斜杠；禁止 .. 与盘符/绝对路径
export function normalizePath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/');
  if (/^[a-z]:/i.test(s) || s.startsWith('~')) throw new Error(`请用知识库内的相对路径（以知识库名称开头），不要用本机绝对路径：${s}`);
  const segs = s.split('/').filter((x) => x && x !== '.');
  if (segs.some((x) => x === '..')) throw new Error('路径不能包含 ..');
  return segs;
}

/**
 * 路径 → { root, segs }。roots: [{ name, handle, kind:'dir'|'file' }]。
 * 首段匹配知识库名称；只有一个知识库目录时允许省略名称前缀。
 */
export function resolveRoot(roots, path) {
  const segs = normalizePath(path);
  if (!roots.length) throw new Error('本对话的知识库里没有浏览器授权的本机文件夹 / 文件');
  if (!segs.length) {
    if (roots.length === 1) return { root: roots[0], segs: [] };
    throw new Error(`请指定知识库名称，可选：${roots.map((r) => r.name).join('、')}`);
  }
  const hit = roots.find((r) => r.name === segs[0]);
  if (hit) return { root: hit, segs: segs.slice(1) };
  const dirs = roots.filter((r) => r.kind === 'dir');
  if (roots.length === 1 && dirs.length === 1) return { root: dirs[0], segs };
  throw new Error(`路径须以知识库名称开头，可选：${roots.map((r) => r.name).join('、')}（收到 ${path}）`);
}

// 定位句柄。create：写入时逐级创建目录与文件
export async function locate(roots, path, { kind = 'any', create = false } = {}) {
  const { root, segs } = resolveRoot(roots, path);
  if (root.kind === 'file') {
    if (segs.length) throw new Error(`${root.name} 是单个文件，没有子路径`);
    return { root, handle: root.handle, kind: 'file', rel: root.name };
  }
  let dir = root.handle;
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    const name = segs[i];
    if (last && kind !== 'dir') {
      try {
        const fh = await dir.getFileHandle(name, { create: create && kind === 'file' });
        return { root, handle: fh, kind: 'file', rel: [root.name, ...segs].join('/') };
      } catch (e) {
        if (kind === 'file') throw notFound(e, root, segs);
      }
    }
    try {
      dir = await dir.getDirectoryHandle(name, { create });
    } catch (e) {
      throw notFound(e, root, segs);
    }
  }
  return { root, handle: dir, kind: 'dir', rel: [root.name, ...segs].join('/') };
}

function notFound(e, root, segs) {
  if (e?.name === 'NotAllowedError') return new Error('没有该文件夹的访问授权：请在发送消息时允许访问，或在知识库里重新添加');
  if (e?.name === 'TypeMismatchError') return new Error(`${[root.name, ...segs].join('/')} 的类型不对（文件 / 目录混淆）`);
  if (e?.name === 'ReadOnlyError') return e; // 快照等只读根：原样抛出，错误信息里已写明原因与出路
  return new Error(`找不到 ${[root.name, ...segs].join('/')}`);
}

/**
 * 深度优先遍历目录（跳过 IGNORE_DIRS 与隐藏目录，.vela 除外）。
 * visit({ path, name, kind, handle, depth }) 返回 false 停止下钻该目录。
 */
export async function walk(dirHandle, prefix, visit, { maxDepth = 64, signal } = {}) {
  let seen = 0;
  let truncated = false; // 条目数达到 LIMITS.walkEntries，后面的目录没有遍历
  const partialDirs = []; // 被数据源截断（bridge 单目录条目上限）、没列全的目录
  const rec = async (dir, pre, depth) => {
    const items = [];
    for await (const [name, h] of dir.entries()) items.push([name, h]);
    if (dir.truncated) partialDirs.push(pre);
    items.sort((a, b) => (a[1].kind === b[1].kind ? a[0].localeCompare(b[0]) : a[1].kind === 'directory' ? -1 : 1));
    for (const [name, h] of items) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (++seen > LIMITS.walkEntries) { truncated = true; return false; }
      const path = `${pre}/${name}`;
      if (h.kind === 'directory') {
        if (IGNORE_DIRS.has(name) || (name.startsWith('.') && name !== '.vela')) continue;
        const go = await visit({ path, name, kind: 'dir', handle: h, depth });
        if (go !== false && depth < maxDepth && (await rec(h, path, depth + 1)) === false) return false;
      } else if ((await visit({ path, name, kind: 'file', handle: h, depth })) === 'stop') return false;
    }
    return true;
  };
  await rec(dirHandle, prefix, 1);
  return { seen, truncated, partialDirs };
}

// 字节 → 文本：BOM 识别 UTF-16；UTF-8 严格解码失败（中文 Windows 老文件常见）退到 GBK
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    try { return new TextDecoder('gbk').decode(b); } catch { return new TextDecoder().decode(b); }
  }
}

// 前 8KB 出现 NUL 视为二进制
export function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export { fmtSize };

/**
 * 读一个文件句柄，按格式分派。返回 { text, attachments? }：
 * 文本带行号（可按行段读）；Office 转 Markdown；PDF / 图片作为附件交给模型原生读取。
 */
export async function readFileHandle(fh, rel, { startLine, endLine, sheet, maxRows } = {}) {
  const file = await fh.getFile();
  const type = classify(file.name);
  const head = `文件：${rel}（${fmtSize(file.size)}）`;
  if (type === 'legacy-office') throw new Error('旧版二进制 Office 格式（.doc/.xls/.ppt）不支持，请另存为 .docx/.xlsx/.pptx');
  if (type === 'docx' || type === 'xlsx' || type === 'pptx') {
    if (file.size > LIMITS.officeBytes) throw new Error(`文件过大（${fmtSize(file.size)}），上限 ${fmtSize(LIMITS.officeBytes)}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const body = type === 'docx' ? await docxToText(bytes)
      : type === 'xlsx' ? await xlsxToText(bytes, { sheet, maxRows: Math.min(2000, maxRows || 200) })
        : await pptxToText(bytes);
    return { text: `${head}\n\n${clip(body)}` };
  }
  if (type === 'pdf' || type === 'image') {
    const cap = type === 'pdf' ? LIMITS.pdfBytes : LIMITS.imageBytes;
    if (file.size > cap) throw new Error(`文件过大（${fmtSize(file.size)}），上限 ${fmtSize(cap)}`);
    const mime = type === 'pdf' ? 'application/pdf' : IMAGE_MIME[file.name.toLowerCase().split('.').pop()];
    return {
      text: `${head}\n已把${type === 'pdf' ? ' PDF 文档' : '图片'}原文件附在本条工具结果中，请直接阅读其内容。（当前模型不支持${type === 'pdf' ? ' PDF' : '图片'}输入时请求会报错。）`,
      attachments: [{ kind: type, mime, name: file.name, data: b64(new Uint8Array(await file.arrayBuffer())) }],
    };
  }
  if (file.size > LIMITS.textBytes) throw new Error(`文件过大（${fmtSize(file.size)}），文本读取上限 ${fmtSize(LIMITS.textBytes)}；可先用 search_files 定位关键行`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (type === 'unknown' && looksBinary(bytes)) throw new Error(`${rel} 是二进制文件，无法按文本读取`);
  const lines = decodeText(bytes).split(/\r?\n/);
  const s = Math.max(1, Number.isInteger(startLine) ? startLine : 1);
  const e = Math.min(lines.length, Number.isInteger(endLine) ? endLine : lines.length);
  const width = String(e).length;
  let out = '';
  let last = s - 1;
  for (let i = s; i <= e; i++) {
    const line = `${String(i).padStart(width)}│${lines[i - 1]}\n`;
    if (out.length + line.length > LIMITS.readChars) break;
    out += line;
    last = i;
  }
  const more = last < e ? `\n…（已截断：显示到第 ${last} 行，共 ${lines.length} 行；用 start_line=${last + 1} 继续读）` : '';
  return { text: `${head}，共 ${lines.length} 行${s > 1 || e < lines.length ? `，第 ${s}-${last} 行` : ''}\n\n${out}${more}` };
}

function clip(s) {
  return s.length > LIMITS.readChars ? `${s.slice(0, LIMITS.readChars)}\n…（已截断，共 ${s.length} 字符）` : s;
}

// 读文本原文（写入 / 编辑前比对用）：文件不存在返回 null
export async function readRawText(fh) {
  if (!fh) return null;
  const file = await fh.getFile();
  if (file.size > LIMITS.textBytes) throw new Error(`文件过大（${fmtSize(file.size)}），不支持编辑`);
  return decodeText(new Uint8Array(await file.arrayBuffer()));
}

/**
 * 行级 diff（LCS），返回 [{ op: ' '|'-'|'+', text }]。超过 maxCells 时退化为整段替换。
 */
export function lineDiff(a, b, { maxCells = 4_000_000 } = {}) {
  const A = String(a ?? '').split(/\r?\n/);
  const B = String(b ?? '').split(/\r?\n/);
  // 去掉公共前后缀，缩小 DP 规模
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const out = A.slice(0, pre).map((text) => ({ op: ' ', text }));
  if ((a2.length + 1) * (b2.length + 1) > maxCells) {
    out.push(...a2.map((text) => ({ op: '-', text })), ...b2.map((text) => ({ op: '+', text })));
  } else {
    const n = a2.length;
    const m = b2.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { out.push({ op: ' ', text: a2[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: a2[i++] });
      else out.push({ op: '+', text: b2[j++] });
    }
    while (i < n) out.push({ op: '-', text: a2[i++] });
    while (j < m) out.push({ op: '+', text: b2[j++] });
  }
  out.push(...A.slice(A.length - suf).map((text) => ({ op: ' ', text })));
  return out;
}

// diff → 只保留改动附近 context 行的统一格式文本（审批卡展示用）
export function formatDiff(ops, { context = 3, maxLines = 400 } = {}) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const lines = [];
  let skipped = false;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) { skipped = true; continue; }
    if (skipped && lines.length) lines.push('…');
    skipped = false;
    lines.push(`${ops[i].op}${ops[i].text}`);
    if (lines.length >= maxLines) { lines.push(`…（差异过长，仅显示前 ${maxLines} 行）`); break; }
  }
  const add = ops.filter((o) => o.op === '+').length;
  const del = ops.filter((o) => o.op === '-').length;
  return { text: lines.join('\n'), add, del };
}

/**
 * SKILL.md 解析：YAML frontmatter 的 name / description（只认单行 key: value）。
 * 没有 frontmatter 时用目录名 + 正文首个非空行作描述。
 */
export function parseSkill(text, dirName) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const body = m ? src.slice(m[0].length) : src;
  const firstLine = body.split(/\r?\n/).map((s) => s.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return { name: meta.name || dirName, description: meta.description || firstLine.slice(0, 200), body };
}
