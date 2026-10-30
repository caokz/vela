// 极简 Markdown 渲染：先整体 HTML 转义再转换，天然防注入。
// 支持：围栏代码块、行内代码、标题、引用、无序/有序列表、粗体、斜体、链接、GFM 管道表。
// 不支持图片（聊天场景第一版不需要），遇到按普通文本处理。

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeUrl(u) {
  return /^(https?:|mailto:)/i.test(u) ? u : '#';
}

function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  return out;
}

// 管道表单元格：剥首尾竖线，按未转义的 | 切分，\| 还原为字面竖线
function tableCells(row) {
  return row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

// 分隔行（| --- |:---:|---: |）→ 每列对齐方式；不是分隔行返回 null
function tableAligns(row) {
  if (!row.includes('|') || !row.includes('-')) return null;
  const cells = tableCells(row);
  if (!cells.length) return null;
  const aligns = cells.map((c) => {
    const m = /^(:?)(-+)(:?)$/.exec(c);
    if (!m) return null;
    if (m[1] && m[3]) return 'center';
    if (m[3]) return 'right';
    return 'left';
  });
  return aligns.every(Boolean) ? aligns : null;
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').split(/\r?\n/);
  const html = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];
  let listMode = ''; // 'ul' | 'ol' | ''

  const closeList = () => {
    if (listMode) {
      html.push(`</${listMode}>`);
      listMode = '';
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (inCode) {
        html.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        inCode = false;
        codeBuf = [];
      } else {
        closeList();
        inCode = true;
        codeLang = fence[1];
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    // 管道表：当前行含 | 且下一行是分隔行 → 表头 + 对齐 + 后续含 | 的行做表体
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = tableAligns(lines[i + 1]);
      if (aligns) {
        closeList();
        const heads = tableCells(line);
        const tag = (align) => (align === 'center' || align === 'right' ? ` style="text-align:${align}"` : '');
        html.push('<table class="om-md-table"><thead><tr>');
        heads.forEach((cell, j) => { html.push(`<th${tag(aligns[j])}>${inline(cell)}</th>`); });
        html.push('</tr></thead><tbody>');
        i += 2;
        while (i < lines.length && lines[i].includes('|')) {
          const cells = tableCells(lines[i]);
          html.push('<tr>');
          heads.forEach((_, j) => { html.push(`<td${tag(aligns[j])}>${inline(cells[j] ?? '')}</td>`); });
          html.push('</tr>');
          i++;
        }
        i--; // 外层 for 会再 +1
        html.push('</tbody></table>');
        continue;
      }
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      html.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (listMode !== want) {
        closeList();
        html.push(`<${want}>`);
        listMode = want;
      }
      html.push(`<li>${inline((ul ?? ol)[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === '') {
      html.push('');
    } else {
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inCode) html.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  closeList();
  return html.filter((s) => s !== '').join('\n');
}
