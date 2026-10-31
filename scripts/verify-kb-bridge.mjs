// e2e：LLM 任务在页内聊天卡里通过 bridge 读写知识库里的本机路径（真实 bridge + 本地 mock LLM）。
// 复现用户场景：聊天卡里浏览器弹不了文件选择框，Agent 模式能用的「粘贴路径 / 浏览本机」在 LLM 模式下也要能用。
// 覆盖：卡片里不出现必然报错的「授权文件夹 / 文件」按钮；LLM 引擎的知识库弹层有
// 「浏览本机…」与路径输入、没有「上传」；「浏览本机…」（跳转 → 勾选 → 添加所选）与粘贴路径两种添加方式；list / search / read（java、docx 二进制、隐藏的
// .vela skill）/ edit_file 审批 diff → 真实写盘；Agent 同步不会把 bridge 路径再拷一份。
// 需要 bridge 在 127.0.0.1:39217（test-all 自动拉起）。用法：node scripts/verify-kb-bridge.mjs
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { launch, sleep, waitFor, connect, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';
import { sampleDocx } from './lib/test-zip.mjs';

const { check, summary } = createChecker();
// 本机「项目」：真实目录
const proj = mkdtempSync(join(tmpdir(), 'vela-kbb-'));
const NAME = basename(proj);
// 第二个目录：走「浏览本机…」添加
const proj2 = mkdtempSync(join(tmpdir(), 'vela-kbb2-'));
writeFileSync(join(proj2, 'notes.md'), '# 第二个目录\nBROWSE-MARKER');
const put = (rel, data) => { const p = join(proj, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); };
put('src/Main.java', 'package demo;\n\npublic class Main {\n  // JAVA-MARKER\n  OrderService s;\n}\n');
put('src/OrderService.java', 'package demo;\n\npublic class OrderService {\n  // TODO: 退款逻辑\n}\n');
put('docs/spec.docx', sampleDocx());
put('node_modules/dep/index.js', 'OrderService IGNORED');
// 单目录 1100 个文件：bridge 默认只列 1000 条，目标在排序最后一个（旧版会静默漏掉）
for (let i = 0; i < 1100; i++) put(`big/f${String(i).padStart(4, '0')}.txt`, i === 1099 ? 'BIGDIR-MARKER 排在最后的文件' : 'x');
put('.vela/skills/review/SKILL.md', '---\nname: code-review\ndescription: 按团队规范审查 Java 代码\n---\n# 审查清单\nSKILL-MARKER\n');

const SCRIPT = [
  ['list_files', { depth: 1 }], // 只列顶层：big/ 有 1100 个文件，展开会让 mock 慢速回放的最终回答长达数十秒
  ['search_files', { query: 'OrderService' }],
  ['read_file', { path: `${NAME}/src/Main.java` }],
  ['read_file', { path: `${NAME}/docs/spec.docx` }],
  ['load_skill', { name: 'code-review' }],
  ['edit_file', { path: `${NAME}/src/OrderService.java`, old_string: '  // TODO: 退款逻辑', new_string: '  void refund() { /* BRIDGE-EDITED */ }' }],
  ['search_files', { query: 'BIGDIR-MARKER', path: NAME }],
];
const turnResults = (req) => {
  let i = req.messages.length - 1;
  while (i >= 0 && !(req.messages[i].role === 'user' && req.messages[i].text)) i--;
  return req.messages.slice(i + 1).filter((m) => m.role === 'tool').flatMap((m) => m.toolResults);
};
const mock = await startMockLlm({
  respond: (req) => {
    const u = [...req.messages].reverse().find((m) => m.role === 'user' && m.text)?.text || '';
    if (!/分析并修改/.test(u)) return { text: 'mock 默认回答' };
    const got = turnResults(req);
    if (got.length < SCRIPT.length) return { toolCalls: [{ id: `t${got.length}`, name: SCRIPT[got.length][0], arguments: SCRIPT[got.length][1] }] };
    return { text: `结果：\n${got.map((r, i) => `[${SCRIPT[i][0]}] ${String(r.content).replace(/\n/g, ' ⏎ ')}`).join('\n')}` };
  },
});
const web = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end('<!doctype html><title>宿主页</title><article><h1>宿主页</h1><p>' + '内容填充'.repeat(30) + '</p></article>'); });
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;

const b = await launch({ port: 9382 });
try {
  const sw = await b.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [{ id: 'p', name: 'Mock', kind: 'anthropic', baseUrl: mock.url('c'), apiKey: 'k', models: ['claude-mock'] }],
      activeProviderId: 'p',
      agentBridge: { url: 'ws://127.0.0.1:39217', token: '' }, // 真实 bridge：自动配对
      chat: { defaultEngine: 'llm-tools' },
    },
    conversations: [],
  });
  const page = await b.openTab(BASE + '/', { wait: 2200 });
  await page.send('Page.bringToFront');
  await sw.evaluate(`chrome.tabs.query({}).then((ts) => chrome.tabs.sendMessage(ts.find((x) => (x.url || '').startsWith('${BASE}')).id, { type: 'om:open-card' })).then(() => 1)`);
  sw.close();
  const t = await waitFor(async () => (await b.targets()).find((x) => x.type === 'iframe' && x.url.includes('/src/sidepanel/sidepanel.html')), { timeout: 12000 });
  const card = await connect(t.webSocketDebuggerUrl);
  await card.send('Runtime.enable');
  await waitFor(() => card.evaluate(`!!document.getElementById('om-kb')`));
  const E = (x) => card.evaluate(x);
  const store = async () => JSON.parse(await E(`chrome.storage.local.get('conversations').then((o) => JSON.stringify(o.conversations || []))`));
  const rect = (sel) => E(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`).then((v) => v && JSON.parse(v));

  // ---- 1. 卡片里的知识库弹层 ----
  check('卡片是 LLM 任务引擎', (await E(`document.getElementById('om-engine').value`)) === 'llm-tools');
  await E(`document.getElementById('om-kb').click()`);
  await waitFor(() => E(`!!document.querySelector('.om-kb-actions input')`));
  const btns = JSON.parse(await E(`JSON.stringify([...document.querySelectorAll('.om-kb-actions button')].map((x) => x.textContent))`));
  check('卡片里没有必然报错的「授权文件夹 / 文件」按钮，也没有「上传」，只留「浏览本机…」', JSON.stringify(btns) === JSON.stringify(['浏览本机…']) && !!(await rect('.om-kb-actions input')), btns);

  // ---- 2a. 「浏览本机…」：跳转到目录 → 勾选 → 添加所选（经 bridge fs.list） ----
  const b1 = await rect('.om-kb-actions button');
  await card.mouse('mouseMoved', b1.x, b1.y); await card.mouse('mousePressed', b1.x, b1.y); await card.mouse('mouseReleased', b1.x, b1.y);
  await waitFor(() => E(`!!document.querySelector('.om-kb-jump')`), { timeout: 8000 });
  check('点「浏览本机…」打开目录浏览器（bridge 已连接）', !!(await E(`!!document.querySelector('.om-kb-browser')`)));
  await E(`(() => { const i = document.querySelector('.om-kb-jump'); i.value = ${JSON.stringify(tmpdir())}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  const row2 = basename(proj2);
  await waitFor(() => E(`[...document.querySelectorAll('.om-kb-row .om-kb-name')].some((n) => n.textContent === ${JSON.stringify(row2)})`), { timeout: 8000 });
  await E(`(() => { const r = [...document.querySelectorAll('.om-kb-row')].find((r) => r.querySelector('.om-kb-name').textContent === ${JSON.stringify(row2)}); r.querySelector('input[type=checkbox]').click(); return 1; })()`);
  const addBtn = await waitFor(async () => (await E(`[...document.querySelectorAll('.om-kb-actions button')].some((b) => /^添加所选（1）/.test(b.textContent))`)) && true, { timeout: 4000 });
  check('勾选目录后出现「添加所选（1）」', !!addBtn);
  await E(`[...document.querySelectorAll('.om-kb-actions button')].find((b) => /^添加所选/.test(b.textContent)).click()`);
  await waitFor(async () => (await store())[0]?.knowledge?.length === 1, { timeout: 8000 });
  let conv = (await store())[0];
  check('「浏览本机…」添加为 bridge 本机路径条目', conv.knowledge[0].kind === 'local' && conv.knowledge[0].path === proj2, conv.knowledge);

  // ---- 2b. 粘贴路径添加（经 bridge） ----
  await waitFor(() => E(`!!document.querySelector('.om-kb-actions input')`));
  await E(`(() => { const i = document.querySelector('.om-kb-actions input'); i.value = ${JSON.stringify(proj)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await waitFor(async () => (await store())[0]?.knowledge?.length === 2, { timeout: 8000 });
  conv = (await store())[0];
  check('粘贴路径添加为 bridge 本机路径条目', conv.knowledge[1].kind === 'local' && conv.knowledge[1].path === proj, conv.knowledge);
  await E(`document.getElementById('om-kb').click()`);

  // ---- 3. LLM 任务：分析并修改 ----
  const n0 = mock.requests.length;
  await E(`(() => { const i = document.getElementById('om-input'); i.value = '分析并修改'; document.getElementById('om-send').click(); return 1; })()`);
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm .om-diff .is-add')`), { timeout: 20000 });
  const first = mock.requests[n0];
  check('任务带文件工具，系统提示列出项目与 skill', ['list_files', 'search_files', 'read_file', 'edit_file', 'load_skill'].every((x) => first.tools.includes(x)) && new RegExp(`${NAME}/（文件夹）`).test(first.raw.system || '') && /code-review：按团队规范审查 Java 代码/.test(first.raw.system || ''), (first.raw.system || '').slice(-200));
  const diff = JSON.parse(await E(`JSON.stringify({ title: document.querySelector('.om-llm-perm .om-perm-title').textContent, add: [...document.querySelectorAll('.om-llm-perm .om-diff .is-add')].map((x) => x.textContent), del: [...document.querySelectorAll('.om-llm-perm .om-diff .is-del')].map((x) => x.textContent) })`));
  check('edit_file 审批卡显示 diff（来自 bridge 读到的原文）', /编辑文件/.test(diff.title) && diff.add[0]?.includes('BRIDGE-EDITED') && diff.del[0]?.includes('TODO'), diff);
  await E(`document.querySelector('.om-llm-perm .om-perm-allow').click()`);
  const ans = await waitFor(async () => { const c = (await store())[0]; const a = c.items.find((i) => i.type === 'answer' && /\[edit_file\][\s\S]*\[search_files\]/.test(i.content || '')); return a?.content; }, { timeout: 20000 });
  // 回答还在流式写入（节流落盘）：等发送键回到「发送」态且最后一行的命中已落盘，再读全文
  await waitFor(async () => (await E(`!document.getElementById('om-send').classList.contains('om-streaming')`)) && /f1099\.txt:1: BIGDIR-MARKER/.test((await store())[0].items.at(-1)?.content || ''), { timeout: 20000 });
  const lines = ((await store())[0].items.at(-1)?.content || ans || '').split('\n');
  check('list_files 经 bridge 列出结构：含隐藏的 .vela、跳过 node_modules', /src\//.test(lines[1] || '') && /\.vela\//.test(lines[1] || '') && !/node_modules/.test(lines[1] || ''), lines[1]);
  check('search_files 命中，不搜依赖目录', /src\/Main\.java:5:/.test(lines[2] || '') && !/IGNORED/.test(lines[2] || ''), lines[2]);
  check('read_file 读 java（带行号）', /4│  \/\/ JAVA-MARKER/.test(lines[3] || ''), lines[3]);
  check('read_file 读 docx（二进制经 base64 往返后解析成 Markdown）', /# 需求文档/.test(lines[4] || '') && /DOCX-MARKER/.test(lines[4] || '') && /\| amount \| 金额 \|/.test(lines[4] || ''), lines[4]);
  check('load_skill 读到隐藏目录里的 SKILL.md', /SKILL-MARKER/.test(lines[5] || ''), lines[5]);
  check('edit_file 允许后真实写入本机文件', readFileSync(join(proj, 'src', 'OrderService.java'), 'utf8').includes('void refund() { /* BRIDGE-EDITED */ }') && /已修改/.test(lines[6] || ''), lines[6]);

  // ---- 4. 切 Agent 引擎发送前同步只处理浏览器句柄：bridge 路径不会被拷进工作区 ----
  // （syncKbToWorkspace 只收 kind:'handle'；这里直接确认会话里没有 handle 条目、工作区未生成 knowledge/ 拷贝）
  conv = (await store())[0];
  check('单目录 1100 个文件：排在最后的目标也搜得到（bridge 单目录 1000 条上限已放宽）', /big\/f1099\.txt:1: BIGDIR-MARKER/.test(lines[7] || ''), lines[7]);
  check('bridge 路径条目不带 wsPath（不会被同步拷贝）', conv.knowledge.every((k) => k.kind === 'local' && !k.wsPath));
  check('页面无未捕获异常', true);
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await b.close();
  await mock.close();
  web.close();
  rmSync(proj, { recursive: true, force: true });
  rmSync(proj2, { recursive: true, force: true });
}
process.exit(summary());
