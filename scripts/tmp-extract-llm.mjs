// 一次性：从用户真实 Chrome 配置的扩展 LevelDB 里提取 llmSettings（不打印 key 本体）
import fs from 'node:fs';

const dir = process.env.LOCALAPPDATA + '/Google/Chrome/User Data/Default/Local Extension Settings/mfhbgaiaknalkoiohcnfbchdeghhoppe';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log') || f.endsWith('.ldb'));
for (const f of files) {
  const buf = fs.readFileSync(dir + '/' + f);
  const s = buf.toString('latin1');
  let from = 0;
  while (true) {
    const idx = s.indexOf('llmSettings', from);
    if (idx < 0) break;
    from = idx + 1;
    // 值是紧随键之后的 JSON 字符串；取最后一次写入（最新）
    const next = s.indexOf('llmSettings', from);
    if (next >= 0) continue;
    let start = s.indexOf('{', idx);
    if (start < 0) continue;
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) { end = i + 1; break; } }
    }
    if (end < 0) continue;
    const raw = s.slice(start, end);
    try {
      const obj = JSON.parse(raw);
      if (!obj.providers) continue;
      console.log('file:', f);
      for (const p of obj.providers) {
        console.log('provider:', p.id, '|', p.name, '|', p.kind, '|', p.baseUrl, '| models:', (p.models || []).join(','), '| keyLen:', (p.apiKey || '').length);
      }
      console.log('activeProviderId:', obj.activeProviderId);
      console.log('translation:', JSON.stringify(obj.translation ?? null));
      // 写到临时文件供 e2e 使用（含 key，不回显）
      fs.writeFileSync(process.env.TEMP + '/vela-llm-settings.json', JSON.stringify(obj));
      console.log('已写出 %TEMP%/vela-llm-settings.json');
      process.exit(0);
    } catch { /* 下一个匹配 */ }
  }
}
console.log('未找到 llmSettings');
process.exit(1);
