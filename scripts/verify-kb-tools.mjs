// e2e：本机知识库（浏览器授权文件夹 / 文件）+ LLM 任务的文件工具，全程本地 mock LLM。
// 本机目录用 OPFS（navigator.storage.getDirectory）模拟：与 showDirectoryPicker 返回的是同一种
// FileSystemDirectoryHandle，可存 IndexedDB、可读写；把文件选择框打桩成返回 OPFS 句柄，走真实按钮流程。
// 覆盖：知识库弹层「授权文件夹 / 授权文件」、句柄持久化（刷新后仍可用）、list / search / read（java、
// docx、xlsx、pptx、PDF 附件）、说明型 skill（系统提示列出 + load_skill）、edit_file 审批卡 diff →
// 允许后真实落盘、write_file 拒绝后不落盘、LLM 问答模式附带单个文件内容。
// 用法：node scripts/verify-kb-tools.mjs
import { launch, sleep, waitFor, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';
import { sampleDocx, sampleXlsx, samplePptx } from './lib/test-zip.mjs';

const { check, summary } = createChecker();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const txt = (s) => b64(Buffer.from(s, 'utf8'));
// 「本机项目」：OPFS demo-proj/
const PROJECT = {
  'README.md': txt('# 订单服务\nREADME-MARKER：负责下单与退款。\n'),
  'src/Main.java': txt('package demo;\n\npublic class Main {\n  // JAVA-MARKER\n  OrderService s = new OrderService();\n}\n'),
  'src/OrderService.java': txt('package demo;\n\npublic class OrderService {\n  // TODO: 退款逻辑\n}\n'),
  'docs/spec.docx': b64(sampleDocx()),
  'data/orders.xlsx': b64(sampleXlsx()),
  'slides.pptx': b64(samplePptx()),
  'report.pdf': b64(Buffer.from('%PDF-1.4\n% PDF-MARKER\n%%EOF\n')),
  'node_modules/dep/index.js': txt('OrderService IGNORED'),
  '.vela/skills/review/SKILL.md': txt('---\nname: code-review\ndescription: 按团队规范审查 Java 代码\n---\n# 审查清单\nSKILL-MARKER 检查空指针\n'),
};

// 按本轮已拿到的工具结果数推进脚本
const results = (req) => req.messages.filter((m) => m.role === 'tool').flatMap((m) => m.toolResults);
const userText = (req) => [...req.messages].reverse().find((m) => m.role === 'user' && m.text)?.text || '';
const ANALYZE = [
  ['list_files', {}],
  ['search_files', { query: 'OrderService' }],
  ['read_file', { path: 'demo-proj/src/Main.java' }],
  ['read_file', { path: 'demo-proj/docs/spec.docx' }],
  ['read_file', { path: 'demo-proj/data/orders.xlsx', sheet: '订单' }],
  ['read_file', { path: 'demo-proj/slides.pptx' }],
  ['read_file', { path: 'demo-proj/report.pdf' }],
];
const turnResults = (req) => {
  // 只取最后一条真实用户消息之后的工具结果
  let i = req.messages.length - 1;
  while (i >= 0 && !(req.messages[i].role === 'user' && req.messages[i].text)) i--;
  return req.messages.slice(i + 1).filter((m) => m.role === 'tool').flatMap((m) => m.toolResults);
};
const mock = await startMockLlm({
  respond: (req) => {
    const u = userText(req);
    const got = turnResults(req);
    const call = (name, args) => ({ toolCalls: [{ id: `t${req.messages.length}_${name}`, name, arguments: args }] });
    if (/分析项目/.test(u)) {
      if (got.length < ANALYZE.length) return call(...ANALYZE[got.length]);
      return { text: `分析结果：\n${got.map((r, i) => `[${ANALYZE[i][0]}] ${String(r.content).replace(/\n/g, ' ⏎ ')}`).join('\n')}` };
    }
    if (/用规范审查/.test(u)) {
      if (!got.length) return call('load_skill', { name: 'code-review' });
      return { text: `skill 内容：${got[0].content.replace(/\n/g, ' ')}` };
    }
    if (/修改代码/.test(u)) {
      if (got.length === 0) return call('edit_file', { path: 'demo-proj/src/OrderService.java', old_string: '  // TODO: 退款逻辑', new_string: '  void refund() { /* EDITED */ }' });
      if (got.length === 1) return call('write_file', { path: 'demo-proj/docs/new.md', content: 'should not exist' });
      return { text: `修改结果：${got.map((r) => r.content).join(' | ')}` };
    }
    if (/再读说明/.test(u)) {
      if (!got.length) return call('read_file', { path: 'demo-proj/README.md' });
      return { text: `README：${got[0].content}` };
    }
    return { text: `问答回答（system=${req.messages.filter((m) => m.role === 'system').map((m) => m.text).join('§').replace(/\n/g, ' ')}）` };
  },
});

const b = await launch({ port: 9373 });
const exceptions = [];
try {
  const sw = await b.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [
        { id: 'p-c', name: 'Claude', kind: 'anthropic', baseUrl: mock.url('c'), apiKey: 'kc', models: ['claude-mock'] },
        { id: 'p-a', name: 'GPT', kind: 'openai', baseUrl: mock.url('a') + '/v1', apiKey: 'ka', models: ['gpt-mock'] },
      ],
      activeProviderId: 'p-c',
      agentBridge: { url: 'ws://127.0.0.1:39299' },
      chat: { defaultEngine: 'llm-tools', toolMaxSteps: 12 },
    },
    conversations: [],
  });
  sw.close();

  const open = async () => {
    const s = await b.openTab(`chrome-extension://${b.extId}/src/chatpage/chat.html`, { wait: 1800 });
    s.on((m) => { if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
    await waitFor(() => s.evaluate(`!!document.getElementById('om-kb')`));
    return s;
  };
  let chat = await open();
  const E = (x) => chat.evaluate(x);
  // 写入 OPFS 项目（只在首次）并给文件选择框打桩
  await E(`(async (files) => {
    const root = await navigator.storage.getDirectory();
    const proj = await root.getDirectoryHandle('demo-proj', { create: true });
    for (const [path, data] of Object.entries(files)) {
      const segs = path.split('/');
      let d = proj;
      for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true });
      const fh = await d.getFileHandle(segs.at(-1), { create: true });
      const w = await fh.createWritable();
      await w.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      await w.close();
    }
    return 1;
  })(${JSON.stringify(PROJECT)})`);
  const stubPickers = () => E(`(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('demo-proj');
    window.showOpenFilePicker = async () => [await (await (await navigator.storage.getDirectory()).getDirectoryHandle('demo-proj')).getFileHandle('README.md')];
    return 1;
  })()`);
  await stubPickers();
  const store = async () => JSON.parse(await E(`chrome.storage.local.get('conversations').then((o) => JSON.stringify(o.conversations))`));
  const send = (t) => E(`(() => { const i = document.getElementById('om-input'); i.value = ${JSON.stringify(t)}; document.getElementById('om-send').click(); return 1; })()`);
  // 断言读存储里的原始 Markdown（渲染后的 innerText 会改写换行与符号）：当前会话的回答
  const answers = async () => {
    const id = await E(`document.querySelector('.om-conv-item.om-active, .om-conv-item.active, [aria-current="true"]')?.dataset.convId || ''`);
    const list = await store();
    const conv = list.find((c) => c.id === id) || list.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return (conv?.items || []).filter((i) => i.type === 'answer');
  };
  const lastAnswer = async () => { const a = (await answers()).at(-1); return a ? (a.content || '') + (a.error ? `【错误】${a.error}` : '') : ''; };
  const count = async () => (await answers()).length;
  const idle = () => E(`!document.getElementById('om-send').classList.contains('om-streaming')`);
  const waitAnswer = async (re, n) => (await waitFor(async () => (await count()) >= n && (await idle()) && re.test(await lastAnswer()), { timeout: 20000 })) ? await lastAnswer() : `（超时）${await lastAnswer()}`;
  const grant = async (act) => {
    await E(`(() => { const p = document.querySelector('.om-kb-pop'); if (p.hidden) document.getElementById('om-kb').click(); return 1; })()`);
    await waitFor(() => E(`!!document.querySelector('[data-kb-act="${act}"]')`));
    await E(`document.querySelector('[data-kb-act="${act}"]').click()`);
    await sleep(600);
  };

  // ---- 1. 授权文件夹 ----
  check('新对话默认 LLM 任务引擎', (await E(`document.getElementById('om-engine').value`)) === 'llm-tools');
  await grant('grant-dir');
  let conv = (await store())[0];
  const kbEntry = conv?.knowledge?.[0];
  check('授权文件夹写入知识库（kind=handle，含工作区落点）', kbEntry?.kind === 'handle' && kbEntry.name === 'demo-proj' && kbEntry.handleKind === 'dir' && kbEntry.wsPath === 'knowledge/demo-proj', kbEntry);
  check('知识库弹层显示「本机授权」标签', (await E(`document.querySelector('.om-kb-item .om-kb-tag')?.textContent`)) === '本机授权');
  await E(`document.getElementById('om-kb').click()`); // 收起弹层

  // ---- 2. 分析项目：list / search / read（java、docx、xlsx、pptx、pdf） ----
  const n0 = mock.requests.length;
  await send('分析项目');
  const ans = await waitAnswer(/分析结果/, 1);
  const first = mock.requests[n0];
  check('任务模式带上文件工具与 load_skill', ['list_files', 'search_files', 'read_file', 'write_file', 'edit_file', 'load_skill'].every((t) => first?.tools.includes(t)), first?.tools);
  check('系统提示列出知识库与 skill 简介', /demo-proj\/（文件夹）/.test(first?.raw.system || '') && /code-review：按团队规范审查 Java 代码/.test(first?.raw.system || ''), (first?.raw.system || '').slice(-300));
  const lines = ans.split('\n');
  check('list_files 列出结构且跳过 node_modules', /src\//.test(lines[1]) && /spec\.docx/.test(lines[1]) && !/node_modules/.test(lines[1]), lines[1]);
  check('search_files 命中 Main.java 行号，不搜依赖目录', /demo-proj\/src\/Main\.java:5:/.test(lines[2]) && !/IGNORED/.test(lines[2]), lines[2]);
  check('read_file 读 java（带行号）', /4│  \/\/ JAVA-MARKER/.test(lines[3]), lines[3]);
  check('read_file 读 docx → Markdown（标题、段落、列表、表格）', /# 需求文档/.test(lines[4]) && /退款需在 7 天内完成。DOCX-MARKER/.test(lines[4]) && /- 支持部分退款/.test(lines[4]) && /\| amount \| 金额 \|/.test(lines[4]), lines[4]);
  check('read_file 读 xlsx 指定工作表（共享串 / 内联串 / 布尔）', /工作表：订单、汇总/.test(lines[5]) && /\| 订单号 \| 金额 \|/.test(lines[5]) && /XLSX-MARKER \| 99\.5/.test(lines[5]) && /A-003 \|  \| TRUE/.test(lines[5]) && !/汇总」/.test(lines[5]), lines[5]);
  check('read_file 读 pptx 按页序（1 → 2 → 10）', /第 1 页.*封面标题.*第 2 页.*PPTX-MARKER.*第 10 页/.test(lines[6]), lines[6]);
  check('read_file 读 PDF 返回附件提示', /PDF 文档原文件附在本条工具结果中/.test(lines[7]), lines[7]);
  const pdfReq = mock.requests.slice(n0).find((r) => r.raw.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => Array.isArray(c.content) && c.content.some((x) => x.type === 'document'))));
  const doc = pdfReq?.raw.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).flatMap((c) => (Array.isArray(c.content) ? c.content : [])).find((x) => x.type === 'document');
  check('PDF 以 document 块交给 Anthropic 模型', !!doc && Buffer.from(doc.source.data, 'base64').toString().includes('PDF-MARKER'), doc ? doc.source.media_type : '无');
  const steps = await E(`[...document.querySelectorAll('.om-msg-answer:last-of-type .om-agent-step-title, .om-msg-answer:last-of-type .om-agent-step-burst summary .om-agent-step-title')].map((x) => x.textContent).join(' | ')`);
  check('工具步骤渲染', /list_files|search_files|读取/.test(steps), steps);

  // ---- 3. skill ----
  await send('用规范审查');
  const sk = await waitAnswer(/skill 内容/, 2);
  check('load_skill 读取 SKILL.md 全文（去掉 frontmatter）', /SKILL-MARKER 检查空指针/.test(sk) && !/description:/.test(sk), sk.slice(0, 200));

  // ---- 4. 写文件：edit 允许（diff 预览）→ 落盘；write 拒绝 → 不落盘 ----
  await send('修改代码');
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm .om-diff .is-add')`), { timeout: 10000 });
  const diff = JSON.parse(await E(`JSON.stringify({ title: document.querySelector('.om-llm-perm .om-perm-title').textContent, add: [...document.querySelectorAll('.om-llm-perm .om-diff .is-add')].map((x) => x.textContent), del: [...document.querySelectorAll('.om-llm-perm .om-diff .is-del')].map((x) => x.textContent) })`));
  check('edit_file 审批卡显示 diff（+1 −1）', /编辑文件 demo-proj\/src\/OrderService\.java（\+1 −1）/.test(diff.title) && diff.add[0]?.includes('EDITED') && diff.del[0]?.includes('TODO'), diff);
  await E(`document.querySelector('.om-llm-perm .om-perm-allow').click()`);
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm .om-diff')`), { timeout: 10000 });
  const newTitle = await E(`document.querySelector('.om-llm-perm .om-perm-title').textContent`);
  check('write_file 审批卡标明新建文件', /新建文件 demo-proj\/docs\/new\.md/.test(newTitle), newTitle);
  await E(`document.querySelector('.om-llm-perm .om-perm-deny').click()`);
  const mod = await waitAnswer(/修改结果/, 3);
  const disk = JSON.parse(await E(`(async () => {
    const p = await (await navigator.storage.getDirectory()).getDirectoryHandle('demo-proj');
    const svc = await (await (await p.getDirectoryHandle('src')).getFileHandle('OrderService.java')).getFile().then((f) => f.text());
    let created = true;
    try { await (await p.getDirectoryHandle('docs')).getFileHandle('new.md'); } catch { created = false; }
    return JSON.stringify({ svc, created });
  })()`));
  check('允许后 edit_file 真实写入本机文件', disk.svc.includes('void refund() { /* EDITED */ }') && !disk.svc.includes('TODO'), disk.svc);
  check('拒绝后 write_file 未创建文件，模型收到拒绝', !disk.created && /已修改 demo-proj\/src\/OrderService\.java/.test(mod) && /拒绝/.test(mod), mod);

  // ---- 5. 刷新后句柄仍可用（IndexedDB 持久化） ----
  chat.close();
  chat = await open();
  await stubPickers();
  await send('再读说明');
  const rd = await waitAnswer(/README：/, 4);
  check('刷新页面后知识库句柄仍可读', /README-MARKER/.test(rd), rd.slice(0, 150));

  // ---- 6. LLM 问答：授权单个文件 → 内容附进上下文；文件夹提示切任务模式 ----
  await E(`(() => { const s = document.getElementById('om-engine'); s.value = 'llm'; s.dispatchEvent(new Event('change')); return 1; })()`);
  await sleep(500);
  await grant('grant-file');
  conv = (await store())[0];
  check('授权文件写入新对话知识库', conv.knowledge?.[0]?.handleKind === 'file' && conv.knowledge[0].name === 'README.md', conv.knowledge);
  const n1 = mock.requests.length;
  await send('总结一下');
  const qa = await waitAnswer(/问答回答/, 1);
  check('问答模式把文件内容附进 system 且不带工具', /README-MARKER/.test(qa) && mock.requests[n1]?.tools.length === 0, qa.slice(0, 200));

  check('页面无未捕获异常', exceptions.length === 0, exceptions);
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await b.close();
  await mock.close();
}
process.exit(summary());
