// Office 文档 → 纯文本 / Markdown（零依赖：zip.js 解包 + DOMParser 解析 XML）。
// docx：段落 + 标题级别 + 列表 + 表格；xlsx：逐工作表转 Markdown 表格（共享字符串、内联字符串、
// 布尔值）；pptx：按页提取文字。按元素 localName 遍历，不依赖命名空间前缀写法。
// 旧版二进制 .doc / .xls / .ppt 不支持。

import { openZip } from './zip.js';

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Office 文档 XML 解析失败');
  return doc;
}

const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
const kid = (el, name) => kids(el, name)[0] || null;
function descendants(el, name) {
  return [...el.getElementsByTagName('*')].filter((c) => c.localName === name);
}
const cellEsc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

// ---------- docx ----------
function docxParagraph(p) {
  let text = '';
  const walk = (el) => {
    for (const c of el.children) {
      const n = c.localName;
      if (n === 't') text += c.textContent;
      else if (n === 'tab') text += '\t';
      else if (n === 'br' || n === 'cr') text += '\n';
      else if (n === 'pPr' || n === 'rPr' || n === 'delText' || n === 'instrText') continue;
      else walk(c);
    }
  };
  walk(p);
  const pPr = kid(p, 'pPr');
  const style = pPr && kid(pPr, 'pStyle');
  const sv = style ? (style.getAttribute('w:val') || [...style.attributes].find((a) => a.localName === 'val')?.value || '') : '';
  const hm = sv.match(/^(?:heading|标题)\s*(\d)$/i);
  if (text.trim() && hm) return `${'#'.repeat(Math.min(6, Number(hm[1])))} ${text.trim()}`;
  if (text.trim() && /^title$/i.test(sv)) return `# ${text.trim()}`;
  if (text.trim() && pPr && kid(pPr, 'numPr')) return `- ${text.trim()}`;
  return text;
}

function docxTable(tbl) {
  const rows = kids(tbl, 'tr').map((tr) => kids(tr, 'tc').map((tc) => cellEsc(kids(tc, 'p').map(docxParagraph).join(' '))));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
  return [
    `| ${norm[0].join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...norm.slice(1).map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function docxBlocks(el, out) {
  for (const c of el.children) {
    if (c.localName === 'p') out.push(docxParagraph(c));
    else if (c.localName === 'tbl') out.push('', docxTable(c), '');
    else if (c.localName === 'sdt') { const content = kid(c, 'sdtContent'); if (content) docxBlocks(content, out); }
  }
}

export async function docxToText(bytes) {
  const zip = openZip(bytes);
  const doc = parseXml(await zip.text('word/document.xml'));
  const body = descendants(doc.documentElement, 'body')[0];
  if (!body) return '';
  const out = [];
  docxBlocks(body, out);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- xlsx ----------
function colIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i)?.[0].toUpperCase() || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const attr = (el, local) => el.getAttribute(local) ?? [...el.attributes].find((a) => a.localName === local)?.value ?? null;

/**
 * @param {Uint8Array} bytes
 * @param {{ sheet?: string, maxRows?: number, maxCols?: number }} opts
 */
export async function xlsxToText(bytes, { sheet, maxRows = 200, maxCols = 40 } = {}) {
  const zip = openZip(bytes);
  const wb = parseXml(await zip.text('xl/workbook.xml'));
  const rels = zip.has('xl/_rels/workbook.xml.rels') ? parseXml(await zip.text('xl/_rels/workbook.xml.rels')) : null;
  const relMap = new Map();
  if (rels) for (const r of descendants(rels.documentElement, 'Relationship')) relMap.set(attr(r, 'Id'), attr(r, 'Target'));
  const shared = [];
  if (zip.has('xl/sharedStrings.xml')) {
    const ss = parseXml(await zip.text('xl/sharedStrings.xml'));
    for (const si of kids(ss.documentElement, 'si')) {
      // 拼接全部 <t>，跳过注音 <rPh>
      shared.push(descendants(si, 't').filter((t) => t.parentElement?.localName !== 'rPh').map((t) => t.textContent).join(''));
    }
  }
  const sheets = descendants(wb.documentElement, 'sheet').map((s, i) => {
    let target = relMap.get(attr(s, 'id')) || `worksheets/sheet${i + 1}.xml`;
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    return { name: attr(s, 'name') || `Sheet${i + 1}`, path: target };
  });
  const names = sheets.map((s) => s.name);
  let chosen = sheets;
  if (sheet) {
    chosen = sheets.filter((s) => s.name === sheet);
    if (!chosen.length) throw new Error(`没有名为「${sheet}」的工作表，可选：${names.join('、')}`);
  }
  const parts = [`工作表：${names.join('、')}`];
  for (const s of chosen) {
    if (!zip.has(s.path)) continue;
    const doc = parseXml(await zip.text(s.path));
    const rows = [];
    let maxCol = 0;
    let totalRows = 0;
    for (const row of descendants(doc.documentElement, 'row')) {
      totalRows++;
      if (rows.length >= maxRows) continue;
      const cells = [];
      for (const c of kids(row, 'c')) {
        const ci = colIndex(attr(c, 'r') || 'A');
        if (ci >= maxCols) continue;
        const t = attr(c, 't');
        const v = kid(c, 'v')?.textContent ?? '';
        let val = v;
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = descendants(c, 't').map((x) => x.textContent).join('');
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        cells[ci] = val;
        maxCol = Math.max(maxCol, ci + 1);
      }
      rows.push(cells);
    }
    parts.push('', `## 工作表「${s.name}」（共 ${totalRows} 行${totalRows > maxRows ? `，显示前 ${maxRows} 行` : ''}）`);
    if (!rows.length || !maxCol) { parts.push('（空表）'); continue; }
    const grid = rows.map((r) => Array.from({ length: maxCol }, (_, i) => cellEsc(r[i] ?? '')));
    parts.push(`| ${grid[0].join(' | ')} |`, `| ${Array(maxCol).fill('---').join(' | ')} |`, ...grid.slice(1).map((r) => `| ${r.join(' | ')} |`));
  }
  return parts.join('\n');
}

// ---------- pptx ----------
export async function pptxToText(bytes) {
  const zip = openZip(bytes);
  const slides = zip.names
    .map((n) => [n, n.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]])
    .filter(([, i]) => i)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const out = [];
  for (const [name, i] of slides) {
    const doc = parseXml(await zip.text(name));
    const lines = descendants(doc.documentElement, 'p')
      .map((p) => descendants(p, 't').map((t) => t.textContent).join(''))
      .filter((s) => s.trim());
    out.push(`## 第 ${i} 页`, ...lines, '');
  }
  return out.join('\n').trim();
}
