// e2e：LLM 直连聊天 + LLM 任务模式（浏览器工具循环），全程走本地 mock LLM（不产生真实调用）。
// 覆盖：顶栏引擎切换与记忆、同名模型按供应商精确路由、刷新后会话引擎/模型恢复、
// OpenAI 与 Anthropic 两种协议的工具调用、读当前网页、下载文件审批（允许 → 文件真实落盘）、
// 联网读取审批（拒绝不发请求 / 勾选不再询问后自动放行）、流式中停止、停止的工具轮轨迹
// 完整性（残缺轨迹会被服务端 400 拒掉，拼装时修复）、页面无未捕获异常。
// 用法：node scripts/verify-llm-chat.mjs
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, waitFor, createChecker, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const { check, summary } = createChecker();
const PAGE_MARKER = 'VELA-PAGE-MARKER-42';
const EXT_MARKER = 'EXT-MARKER-7';

// 被读取的网页 + 外链（计数：验证拒绝时没有发出请求）
let extHits = 0;
const web = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>测试文章</title></head><body><nav>导航</nav><article><h1>测试文章</h1>
<p>这是一段用于验证 LLM 任务模式读取当前网页的正文。${PAGE_MARKER}。</p>
<p>${'填充内容，保证正文长度足够。'.repeat(20)}</p></article></body></html>`);
  } else if (req.url === '/ext') {
    extHits++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>外链</title><script>var x=1</script></head><body><main><p>外链正文 ${EXT_MARKER}</p></main></body></html>`);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const WEB = `http://127.0.0.1:${web.address().port}`;

const lastResult = (req) => req.messages.at(-1)?.role === 'tool' ? req.messages.at(-1).toolResults : null;
const mock = await startMockLlm({
  respond: (req) => {
    const results = lastResult(req);
    const userText = [...req.messages].reverse().find((m) => m.role === 'user')?.text || '';
    if (/路由测试/.test(userText)) return { text: `[${req.prefix}] 路由OK` };
    if (/慢回答/.test(userText)) return { text: '慢'.repeat(1800), chunkDelayMs: 40 };
    if (/总结当前页面/.test(userText)) {
      if (!results) return { text: '我先读取页面。', toolCalls: [{ id: 'tu_page', name: 'get_current_page', arguments: {} }] };
      const m = results[0].content.match(/VELA-PAGE-MARKER-\d+/);
      return { text: `页面标记=${m ? m[0] : '未找到'}` };
    }
    if (/下载报告/.test(userText)) {
      if (!results) return { toolCalls: [{ id: 'tu_dl', name: 'download_file', arguments: { filename: 'vela-report.md', content: '# 报告\nREPORT-BODY' } }] };
      return { text: `下载结果: ${results[0].content}` };
    }
    if (/读外链/.test(userText)) {
      if (!results) return { toolCalls: [{ id: `tu_fetch_${req.messages.length}`, name: 'fetch_url', arguments: { url: `${WEB}/ext` } }] };
      return { text: `外链结果: ${results[0].content.slice(0, 200)}` };
    }
    // 长任务：模型反复调工具直到历史里攒够 8 条工具结果才收尾——天然跨步数上限，验证「继续」接力
    if (req.messages.some((m) => m.role === 'user' && /长任务/.test(m.text || ''))) {
      const done = req.messages.filter((m) => m.role === 'tool').length;
      if (done < 8) return { toolCalls: [{ id: `tu_long_${done}`, name: 'get_current_page', arguments: {} }] };
      return { text: `长任务完成：共 ${done} 条工具结果，标记=${PAGE_MARKER}` };
    }
    return { text: 'mock 默认回答' };
  },
});

const downloadDir = mkdtempSync(join(tmpdir(), 'vela-dl-'));
const browser = await launch({ port: 9361, url: `${WEB}/page` });
const exceptions = [];
try {
  const sw = await browser.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [
        { id: 'p-a', name: '供应商A', kind: 'openai', baseUrl: mock.url('a') + '/v1', apiKey: 'ka', models: ['same-model'] },
        { id: 'p-b', name: '供应商B', kind: 'openai', baseUrl: mock.url('b') + '/v1', apiKey: 'kb', models: ['same-model'] },
        { id: 'p-c', name: '供应商C', kind: 'anthropic', baseUrl: mock.url('c'), apiKey: 'kc', models: ['claude-mock'] },
      ],
      activeProviderId: 'p-a',
      // bridge 指向死端口：本测试只走 LLM，不受本机 bridge 状态影响
      agentBridge: { url: 'ws://127.0.0.1:39299', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' },
    },
    conversations: [],
  });
  sw.close();

  const openChat = async () => {
    const s = await browser.openTab(`chrome-extension://${browser.extId}/src/chatpage/chat.html`, { wait: 1800 });
    s.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    });
    await s.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: false });
    await waitFor(() => s.evaluate(`!!document.getElementById('om-engine')`));
    return s;
  };
  let chat = await openChat();
  const E = (expr) => chat.evaluate(expr);
  const store = async () => JSON.parse(await E(`chrome.storage.local.get(['conversations','llmSettings']).then((o) => JSON.stringify(o))`));
  const setSelect = (id, value) => E(`(() => { const s = document.getElementById('${id}'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
  const sendMsg = (text) => E(`(() => { const i = document.getElementById('om-input'); i.value = ${JSON.stringify(text)}; document.getElementById('om-send').click(); return true; })()`);
  const lastAnswer = () => E(`(() => { const a = [...document.querySelectorAll('.om-msg-answer')].at(-1); return a ? a.querySelector('.om-body').innerText : ''; })()`);
  const answerCount = () => E(`document.querySelectorAll('.om-msg-answer').length`);
  const idle = () => E(`!document.getElementById('om-send').classList.contains('om-streaming')`);
  const waitAnswer = async (re, n) => {
    const ok = await waitFor(async () => (await answerCount()) >= n && re.test(await lastAnswer()) && (await idle()), { timeout: 15000 });
    return { ok: !!ok, text: await lastAnswer() };
  };

  // ---- 1. 引擎下拉 ----
  const opts = JSON.parse(await E(`JSON.stringify([...document.getElementById('om-engine').options].map((o) => [o.value, o.disabled]))`));
  check('顶栏引擎下拉含 Agent / LLM 问答 / LLM 任务且 LLM 可选', JSON.stringify(opts) === JSON.stringify([['agent', false], ['llm', false], ['llm-tools', false]]), opts);
  check('新会话默认 Agent 引擎', (await E(`document.getElementById('om-engine').value`)) === 'agent');
  await setSelect('om-engine', 'llm');
  await sleep(400);
  let st = await store();
  check('空会话切 LLM 问答：原地改引擎', st.conversations.length === 1 && st.conversations[0].engine === 'llm' && st.conversations[0].llmMode === 'chat', st.conversations.map((c) => [c.engine, c.llmMode]));
  check('引擎选择记为新会话默认', st.llmSettings.chat?.defaultEngine === 'llm', st.llmSettings.chat);
  check('LLM 引擎下显示模型下拉、隐藏 agent 下拉', await E(`document.getElementById('om-model').style.display === '' && document.getElementById('om-agent').style.display === 'none'`));

  // ---- 2. 同名模型按供应商路由 ----
  await setSelect('om-model', JSON.stringify(['p-b', 'same-model']));
  await sleep(200);
  const before = mock.requests.length;
  await sendMsg('路由测试');
  let a = await waitAnswer(/路由OK/, 1);
  check('LLM 问答流式回答渲染', a.ok, a.text);
  check('选中「供应商B / same-model」请求精确落到 B（不串到激活的 A）', /^\[b\]/.test(a.text) && mock.requests[before]?.prefix === 'b' && mock.requests[before]?.headers.authorization === 'Bearer kb', a.text);
  check('问答模式请求不带工具', mock.requests[before]?.tools.length === 0);
  st = await store();
  check('会话记住供应商与模型', st.conversations[0].llmProviderId === 'p-b' && st.conversations[0].llmModel === 'same-model');

  // ---- 3. 刷新后恢复 ----
  chat.close();
  chat = await openChat();
  check('刷新后会话引擎恢复为 LLM 问答', (await E(`document.getElementById('om-engine').value`)) === 'llm');
  check('刷新后模型下拉恢复为供应商B', (await E(`document.getElementById('om-model').value`)) === JSON.stringify(['p-b', 'same-model']), await E(`document.getElementById('om-model').value`));
  check('历史回答回放', /路由OK/.test(await lastAnswer()));

  // ---- 4. 任务模式（Anthropic 协议）：读当前网页 ----
  await setSelect('om-engine', 'llm-tools');
  await sleep(400);
  st = await store();
  check('有消息的会话切 LLM 任务：新建对话，原会话引擎不变', st.conversations.length === 2 && st.conversations[0].llmMode === 'tools' && st.conversations[1].llmMode === 'chat', st.conversations.map((c) => [c.engine, c.llmMode, c.items.length]));
  await setSelect('om-model', JSON.stringify(['p-c', 'claude-mock']));
  await sleep(200);
  const b2 = mock.requests.length;
  await sendMsg('总结当前页面');
  a = await waitAnswer(/页面标记=/, 1);
  check('任务模式：模型调用 get_current_page 并拿到网页正文（独立聊天页回退到最近网页标签）', a.text.includes(`页面标记=${PAGE_MARKER}`), a.text);
  const toolReq = mock.requests[b2];
  check('任务模式请求带 7 个浏览器工具（Anthropic 协议）', toolReq?.protocol === 'anthropic' && ['get_current_page', 'get_selection', 'list_tabs', 'read_tab', 'fetch_url', 'open_tab', 'download_file'].every((n) => toolReq.tools.includes(n)), toolReq?.tools);
  check('工具结果按 tool_result 回填', mock.requests[b2 + 1]?.raw.messages.at(-1).content[0].type === 'tool_result');
  const stepTitle = await E(`document.querySelector('.om-msg-answer:last-of-type .om-agent-step-title')?.textContent || ''`);
  check('工具步骤渲染在回答里', /get_current_page/.test(stepTitle), stepTitle);
  st = await store();
  const ans = st.conversations[0].items.at(-1);
  check('工具步骤持久化到 meta.tools', ans.meta?.tools?.steps?.length === 1 && ans.meta.tools.steps[0].status === 'completed', ans.meta);

  // ---- 5. 下载文件：审批允许 → 文件落盘（OpenAI 协议） ----
  await setSelect('om-model', JSON.stringify(['p-a', 'same-model']));
  await sleep(200);
  await sendMsg('下载报告');
  const card = await waitFor(() => E(`document.querySelector('.om-llm-perm .om-perm-title')?.textContent || ''`));
  check('下载文件前弹审批卡', /下载文件 vela-report\.md/.test(card || ''), card);
  await E(`document.querySelector('.om-llm-perm .om-perm-allow').click()`);
  a = await waitAnswer(/下载结果/, 2);
  check('允许后执行下载并回填结果', /已开始下载 vela-report\.md/.test(a.text), a.text);
  // CDP 下载行为会把落盘文件名换成 GUID（downloads 记录里也是 GUID）：只断言下载完成且内容正确，
  // 文件名由上一条「已开始下载 vela-report.md」断言覆盖
  const dl = await waitFor(async () => {
    const r = JSON.parse(await E(`chrome.downloads.search({}).then((l) => JSON.stringify(l.map((d) => d.state)))`));
    return r.includes('complete') ? r : null;
  }, { timeout: 8000 });
  const files = readdirSync(downloadDir);
  const body = files.map((f) => readFileSync(join(downloadDir, f), 'utf8')).join('\n');
  check('文件真实落盘且内容正确', !!dl && body.includes('REPORT-BODY'), { dl, files });

  // ---- 6. 联网读取：拒绝不发请求；勾选不再询问后自动放行 ----
  await sendMsg('读外链');
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm')`));
  await E(`document.querySelector('.om-llm-perm .om-perm-deny').click()`);
  a = await waitAnswer(/外链结果/, 3);
  check('拒绝后工具不执行（外链未被请求）且模型收到拒绝结果', extHits === 0 && /拒绝/.test(a.text), `${extHits} ${a.text}`);
  await sendMsg('读外链');
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm')`));
  await E(`(() => { const c = document.querySelector('.om-llm-perm'); c.querySelector('input[type=checkbox]').checked = true; c.querySelector('.om-perm-allow').click(); })()`);
  a = await waitAnswer(new RegExp(EXT_MARKER), 4);
  check('允许后联网读取，HTML 转成正文（脚本被剔除）', extHits === 1 && a.text.includes(EXT_MARKER) && !a.text.includes('var x'), a.text);
  await sendMsg('读外链');
  a = await waitAnswer(/外链结果/, 5);
  const sawCard = await E(`!!document.querySelector('.om-llm-perm')`);
  check('勾选「本对话不再询问」后同类操作自动放行', extHits === 2 && !sawCard, `hits=${extHits}`);

  // ---- 7. 流式中停止 ----
  await setSelect('om-engine', 'llm');
  await sleep(400);
  await sendMsg('慢回答');
  await waitFor(async () => (await lastAnswer()).length > 5);
  await E(`document.getElementById('om-send').click()`); // 流式中发送按钮即停止
  await waitFor(() => idle());
  await sleep(600);
  const stopped = await E(`!![...document.querySelectorAll('.om-msg-answer')].at(-1)?.querySelector('.om-stopped')`);
  const len = (await lastAnswer()).length;
  check('流式中点停止：回答截断并标记已停止', stopped && len > 0 && len < 1800, `stopped=${stopped} len=${len}`);

  // ---- 8. 设置页 ----
  const opt = await browser.openTab(`chrome-extension://${browser.extId}/src/options/options.html`, { wait: 1500 });
  const ov = JSON.parse(await opt.evaluate(`JSON.stringify([document.getElementById('om-chat-engine').value, document.getElementById('om-chat-maxsteps').value])`));
  check('设置页显示顶栏记住的默认引擎与步数上限', ov[0] === 'llm' && ov[1] === '12', ov);
  await opt.evaluate(`(() => { const s = document.getElementById('om-chat-engine'); s.value = 'llm-tools'; s.dispatchEvent(new Event('change')); document.getElementById('om-chat-maxsteps').value = '5'; document.getElementById('om-save').click(); return 1; })()`);
  await sleep(1200);
  st = await store();
  check('设置页保存聊天引擎默认值与步数上限，不丢其他设置', st.llmSettings.chat?.defaultEngine === 'llm-tools' && st.llmSettings.chat?.toolMaxSteps === 5 && st.llmSettings.providers.length === 3, st.llmSettings.chat);
  opt.close();

  // ---- 9. 页内聊天卡（扩展源 iframe 嵌在网页里）：任务模式读宿主页 ----
  {
    const pageT = (await browser.targets()).find((t) => t.type === 'page' && t.url === `${WEB}/page`);
    await browser.activate(pageT.id);
    await sleep(500);
    const sw2 = await browser.sw();
    await sw2.evaluate(`chrome.tabs.query({ url: '${WEB}/page' }).then(([t]) => chrome.tabs.sendMessage(t.id, { type: 'om:open-card' })).then(() => 'ok')`);
    sw2.close();
    const cardT = await waitFor(async () => (await browser.targets()).find((t) => t.type === 'iframe' && t.url.includes('/src/sidepanel/sidepanel.html')), { timeout: 10000 });
    check('页内聊天卡 iframe 打开', !!cardT, cardT?.url);
    if (cardT) {
      const { connect } = await import('./lib/cdp.mjs');
      const card = await connect(cardT.webSocketDebuggerUrl);
      await card.send('Runtime.enable');
      await waitFor(() => card.evaluate(`!!document.getElementById('om-engine')`));
      // 聊天卡打开即续最近活跃的会话（上一步的 LLM 问答会话）：切到任务模式会新建对话
      check('聊天卡续上最近活跃会话（LLM 问答）', (await card.evaluate(`document.getElementById('om-engine').value`)) === 'llm');
      await card.evaluate(`(() => { const s = document.getElementById('om-engine'); s.value = 'llm-tools'; s.dispatchEvent(new Event('change')); return 1; })()`);
      await sleep(500);
      check('聊天卡切到 LLM 任务新建空对话', (await card.evaluate(`document.querySelectorAll('.om-msg').length`)) === 0);
      await card.evaluate(`(() => { const i = document.getElementById('om-input'); i.value = '总结当前页面'; document.getElementById('om-send').click(); return 1; })()`);
      const got = await waitFor(async () => {
        const t = await card.evaluate(`[...document.querySelectorAll('.om-msg-answer')].at(-1)?.querySelector('.om-body').innerText || ''`);
        return /页面标记=/.test(t) && t;
      }, { timeout: 15000 });
      check('聊天卡任务模式读到宿主网页正文', (got || '').includes(`页面标记=${PAGE_MARKER}`), got);
      card.close();
    }
  }

  // ---- 10. 步数上限暂停与「继续」（设置即时生效 + 轨迹回传） ----
  // 本节开始前设置页已把 toolMaxSteps 存为 5（第 8 节），聊天窗在保存前就开着：
  // 暂停提示必须写「最多 5 步」——验证发送时读当前值，而不是初始化时的旧值 12
  await setSelect('om-engine', 'llm-tools'); // 有消息的会话上切任务模式 → 新建对话
  await sleep(400);
  await setSelect('om-model', JSON.stringify(['p-a', 'same-model']));
  await sleep(200);
  const beforeLong = mock.requests.length;
  await sendMsg('长任务');
  a = await waitAnswer(/最多 5 步工具调用/, 1);
  check('步数用尽暂停，提示当前上限（设置页改动对已开聊天窗即时生效）', a.ok, a.text);
  const usedInFirst = mock.requests.slice(beforeLong).filter((r) => r.messages.some((m) => m.role === 'user' && /长任务/.test(m.text || ''))).length;
  check('第一轮正好用满 5 步', usedInFirst === 5, `requests=${usedInFirst}`);
  await sendMsg('继续');
  a = await waitAnswer(/长任务完成/, 2);
  check('「继续」从中断处接着做并完成任务', a.ok && a.text.includes(`标记=${PAGE_MARKER}`), a.text);
  // 继续轮的第一个请求必须带着上一轮全部 5 条工具结果（meta.tools.trail 回传）
  const contReq = mock.requests.find((r) => r.messages.some((m) => m.role === 'user' && m.text === '继续'));
  const carried = contReq?.messages.filter((m) => m.role === 'tool').length ?? -1;
  check('继续轮把上一轮工具结果原样带回模型（不从头再来）', carried === 5, `carried=${carried}`);
  st = await store();
  const trails = st.conversations[0].items.map((i) => i.meta?.tools?.trail?.length ?? 0);
  check('消息轨迹持久化到 meta.tools.trail（两轮各一份）', trails.filter((n) => n >= 2).length === 2, JSON.stringify(trails));

  // ---- 11. 停止的工具轮不毒化会话：落库轨迹完整 + 残缺轨迹拼装时被修复 ----
  // 真实事故：旧版本停止轮存下「assistant 带工具调用却没有结果消息」的轨迹，之后这个
  // 会话的每次请求都被服务端 400 拒掉（An assistant message with 'tool_calls' must be
  // followed by tool messages…），「请继续」永远失败
  await sendMsg('读外链');
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm')`));
  await E(`document.getElementById('om-send').click()`); // 审批卡上直接停止
  await waitFor(() => idle());
  await sleep(600);
  st = await store();
  const stoppedTrail = st.conversations[0].items.at(-1)?.meta?.tools?.trail ?? [];
  const answeredIds = new Set(stoppedTrail.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
  check('审批卡上停止：落库轨迹每个工具调用都有结果消息', stoppedTrail
    .filter((m) => m.role === 'assistant' && m.toolCalls?.length)
    .every((m) => m.toolCalls.every((c) => answeredIds.has(c.id))), JSON.stringify(stoppedTrail));
  // 模拟旧版本毒数据：把停止轮轨迹里的 tool 消息全部删掉，再重发——拼装时必须修复
  await E(`chrome.storage.local.get(['conversations']).then((o) => {
    const convs = o.conversations;
    const it = convs[0].items.at(-1);
    it.meta.tools.trail = (it.meta.tools.trail ?? []).filter((m) => m.role !== 'tool');
    return chrome.storage.local.set({ conversations: convs });
  })`);
  await sleep(800); // 等 storage.onChanged 防抖同步进内存
  const beforeRetry = mock.requests.length;
  await sendMsg('读外链');
  await waitFor(() => E(`!!document.querySelector('.om-llm-perm')`));
  await E(`document.querySelector('.om-llm-perm .om-perm-allow').click()`);
  a = await waitAnswer(/外链结果/, 4);
  check('残缺轨迹修复后请求不再 400，任务继续完成', a.ok, a.text);
  // 重试轮的第一个请求：assistant.tool_calls 必须紧跟覆盖每个 id 的 tool 响应
  const retryReq = mock.requests.slice(beforeRetry).find((r) => r.messages.at(-1)?.role === 'user' && /读外链/.test(r.messages.at(-1).text || ''));
  let wireOk = true;
  if (retryReq) {
    const msgs = retryReq.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
      const need = new Set(m.toolCalls.map((c) => c.id));
      for (let j = i + 1; j < msgs.length && need.size; j++) {
        if (msgs[j].role !== 'tool') break;
        for (const tr of msgs[j].toolResults ?? []) need.delete(tr.id);
      }
      if (need.size) wireOk = false;
    }
  }
  check('重试请求的每个工具调用都有结果消息（残缺轨迹在拼装时修复）', !!retryReq && wireOk, `found=${!!retryReq}`);

  check('聊天页无未捕获异常', exceptions.length === 0, exceptions);
  chat.close();
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await browser.close();
  await mock.close();
  web.close();
  rmSync(downloadDir, { recursive: true, force: true });
}
process.exit(summary());
