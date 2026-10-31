// 测试用 zip 构造（单元测试 / e2e 生成 docx、xlsx、pptx 样本）：可选按条目 deflate，
// 覆盖 kb/zip.js 的 store 与 deflate 两条解压路径。零依赖（node:zlib）。
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './zip.mjs';

/**
 * @param {Record<string, string|Uint8Array>} files 条目名 → 内容
 * @param {{ deflate?: string[]|true }} opts 需要 deflate 压缩的条目（true = 全部）
 * @returns {Uint8Array}
 */
export function buildTestZip(files, { deflate = [] } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
    const zip = deflate === true || deflate.includes(name);
    const data = zip ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(zip ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(zip ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

// 最小可用的 Office 样本（各取解析器用到的结构）
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
export function sampleDocx() {
  return buildTestZip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>需求文档</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">退款需在 </w:t></w:r><w:r><w:t>7 天内完成。DOCX-MARKER</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>支持部分退款</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>字段</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>说明</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>amount</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`,
  }, { deflate: ['word/document.xml'] });
}

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
export function sampleXlsx() {
  return buildTestZip({
    'xl/workbook.xml': `<workbook ${S} ${RNS}><sheets><sheet name="订单" sheetId="1" r:id="rId1"/><sheet name="汇总" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst ${S}><si><t>订单号</t></si><si><t>金额</t></si><si><r><t>XLSX-</t></r><r><t>MARKER</t></r></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet ${S}><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>99.5</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>A-003</t></is></c><c r="C3" t="b"><v>1</v></c></row>
</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet ${S}><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>`,
  }, { deflate: true });
}

export function samplePptx() {
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const slide = (t) => `<p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return buildTestZip({
    'ppt/slides/slide2.xml': slide('第二页 PPTX-MARKER'),
    'ppt/slides/slide1.xml': slide('封面标题'),
    'ppt/slides/slide10.xml': slide('第十页'),
  }, { deflate: true });
}
