// 临时脚本：生成 README 截图（4 张，本地 mock LLM / mock bridge，零真实调用）。
//   1) chat-card.png  页内聊天卡（浮窗 + 聊天卡 + 页面上下文追问，LLM 引擎）
//   2) translate.png  整页翻译（英→中，对照模式，浮窗就地启动）
//   3) mindmap.png    划词思维导图查看页（高亮素材生成）
//   4) agent.png      独立聊天页 Agent 引擎（思考 + 工具步骤卡 + 答案，mock bridge）
// 产物写 docs/screenshots/（不在打包白名单，不进扩展 zip）。
// 用法：node scripts/tmp-screenshots.mjs
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launch, sleep, waitFor, connect, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(EXT_ROOT, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
const { WebSocketServer } = require(join(EXT_ROOT, 'bridge', 'node_modules', 'ws'));

// ---- 演示文章（英文技术文，干净排版）----
// 翻译 mock 的路由键 = 每个自然段的首句 / 标题全文；译文走 TX_MAP，编号段落请求按协议回等长 JSON 数组
const P_EN = [
  'Streaming systems move data from producers to consumers continuously. In the ideal case both sides run at the same rate and records flow through the pipe like water.',
  'Reality rarely cooperates. Consumer throughput fluctuates with load, downstream latency, and garbage-collection pauses, while producers are often happy to push at their own pace.',
  'Backpressure is the discipline of managing that rate mismatch explicitly: the fast end should feel the slow end, instead of pushing the conflict into memory.',
  'Two strategies dominate. Reactive pull has consumers request batches by capacity; bounded queues ask the upstream to slow down once the buffer is full.',
  'A bounded buffer is the safety net of last resort: refusing or slowing down when the queue is full beats unbounded growth that ends in OOM.',
  'Water marks tie batch size and prefetch granularity together: too small starves throughput, too large inflates latency — pick per workload.',
];
// 块文本 → 译文（覆盖 h1 / byline / h2 / 全部正文段 / li；pre 代码块按设计跳过不译）
const TX_MAP = [
  ['Backpressure in Streaming Systems', '流式系统中的背压'],
  ['Engineering Notes · Streaming Series · Part 3', '工程笔记 · 流式系列 · 第 3 篇'],
  ['What backpressure means', '背压是什么'],
  ['Design choices', '设计取舍'],
  ['Prefer pull over push when consumers are heterogeneous.', '消费者能力不一时，拉取优于推送。'],
  ['Keep every buffer bounded — a full queue should apply force, not grow.', '所有缓冲都要有界——队列满了应该施压，而不是变大。'],
  ['Treat batching and water marks as one dial, not two.', '批大小与水位线要当一个旋钮调，不是两个。'],
  [P_EN[0], '流式系统持续把数据从生产者搬运到消费者。理想状态下两端速率一致，数据像水流过管道一样平滑。'],
  [P_EN[1], '现实很少配合：消费者的吞吐随负载、下游延迟与 GC 停顿波动，生产者却往往只顾自己的节奏往前推。'],
  [P_EN[2], '背压就是把速率差显式管理起来的纪律：让快的一端感知慢的一端，而不是把矛盾推给内存。'],
  [P_EN[3], '两种策略占主导：响应式拉取让消费者按容量逐批请求数据；有界队列则在缓冲写满时让上游降速。'],
  [P_EN[4], '有界缓冲是最后的保底：队列满时拒绝或降速，远好过无界堆积最终把进程拖向内存耗尽。'],
  [P_EN[5], '水位线把批大小与预取粒度绑在一起：设小吃不满吞吐，设大则延迟上升，需要按负载权衡。'],
];
// 预期译文块数（h1 + h2×2 + 正文 6 段 + li×3；pre 代码块按设计跳过，byline 是纯 div 不收录）
const TX_EXPECT_DSTS = 12;
const article = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Backpressure in Streaming Systems</title>
<style>
  body { font: 17px/1.75 Georgia, 'Times New Roman', serif; color: #24292f; background: #fff; margin: 0; }
  main { max-width: 720px; margin: 0 auto; padding: 56px 24px 80px; }
  h1 { font-size: 34px; line-height: 1.3; margin: 0 0 8px; font-family: -apple-system, 'Segoe UI', sans-serif; }
  .byline { color: #6e7781; font-family: -apple-system, 'Segoe UI', sans-serif; font-size: 14px; margin-bottom: 40px; }
  h2 { font-size: 24px; margin: 44px 0 12px; font-family: -apple-system, 'Segoe UI', sans-serif; }
  p { margin: 0 0 20px; }
  ul { margin: 0 0 20px; padding-left: 26px; }
  li { margin-bottom: 8px; }
  pre { background: #f6f8fa; border-radius: 8px; padding: 14px 18px; font: 14px/1.6 Consolas, monospace; overflow: auto; }
</style></head><body><main>
<h1>Backpressure in Streaming Systems</h1>
<div class="byline">Engineering Notes · Streaming Series · Part 3</div>
<p>${P_EN[0]}</p>
<p>${P_EN[1]}</p>
<h2>What backpressure means</h2>
<p>${P_EN[2]}</p>
<p>${P_EN[3]}</p>
<h2>Design choices</h2>
<ul>
  <li>Prefer pull over push when consumers are heterogeneous.</li>
  <li>Keep every buffer bounded — a full queue should apply force, not grow.</li>
  <li>Treat batching and water marks as one dial, not two.</li>
</ul>
<p>${P_EN[4]}</p>
<pre>const source = pull(upstream, { highWaterMark: 16 });
for await (const batch of source) await sink.write(batch);</pre>
<p>${P_EN[5]}</p>
</main></body></html>`;

const web = createServer((req, res) => {
  if (req.url === '/article') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(article); }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${web.address().port}/article`;

// ---- mock LLM：按 prompt 内容分流（导图 / 聊天追问 / 逐段翻译） ----
const QUESTION = '这篇文章的核心观点是什么？';
const CHAT_ANSWER = [
  '核心观点一句话：**背压不是异常处理，而是流式系统的正常工作状态**——速率差必须被显式管理。',
  '',
  '## 三个要点',
  '',
  '1. **拉取优于推送**：消费者按自身容量逐批请求数据，生产者不盲目倾倒',
  '2. **有界缓冲是保底**：队列满即降速，无界堆积最终只会 OOM',
  '3. **水位线是一个旋钮**：批大小与预取粒度要一起权衡，不是两个独立参数',
  '',
  '结论：设计管道时先回答「谁服从谁」（以消费者速度为准），背压策略自然就定了。',
].join('\n');
const OUTLINE = [
  '- 为什么需要背压',
  '  - 两端速率天然不匹配〔片段1〕',
  '  - 无界堆积终将拖垮进程〔片段2〕',
  '- 两种经典策略',
  '  - 响应式拉取（Reactive Pull）〔片段1〕',
  '  - 有界队列 + 写满降速〔片段2〕',
  '- 落地权衡',
  '  - 水位线绑定批大小与预取粒度〔片段2〕',
].join('\n');
const mock = await startMockLlm({
  respond: (req) => {
    const u = [...req.messages].reverse().find((m) => m.role === 'user' && m.text)?.text || '';
    if (u.includes('思维导图大纲')) return { text: OUTLINE, chunkDelayMs: 8 };
    if (u.includes(QUESTION)) return { text: CHAT_ANSWER, chunkDelayMs: 6 };
    // 整页翻译：编号段落请求（「n. 原文」），按协议回等长 JSON 字符串数组，命中不了回 null
    if (u.includes('翻译成')) {
      const items = [...u.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1].trim());
      const out = items.map((t) => {
        const hit = TX_MAP.find(([k]) => t === k || t.startsWith(k));
        return hit ? hit[1] : null;
      });
      return { text: JSON.stringify(out), chunkDelayMs: 4 };
    }
    return { text: '（mock 默认回答）' };
  },
});

// ---- mock bridge：hello / agents.list / session.new / prompt + 事件帧（思考 + 工具步骤 + 答案） ----
const BRIDGE_PORT = 39409;
const AGENT_Q = '帮我把这个页面的要点整理成检查清单';
const wss = new WebSocketServer({ port: BRIDGE_PORT });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const reply = (result) => ws.send(JSON.stringify({ id: m.id, ok: true, result }));
    switch (m.op) {
      case 'hello': reply({ token: 'mock-token' }); break;
      case 'agents.list': reply({ agents: [{ id: 'claude-code', name: 'Claude Code', authed: true, version: 'mock' }] }); break;
      case 'models.list': reply({ models: [] }); break;
      case 'session.new': reply({ sessionId: 's-shot', workspacePath: 'C:/tmp/w' }); break;
      case 'session.prompt': {
        reply({});
        const sid = m.params?.sessionId || 's-shot';
        let seq = 0;
        const send = (event) => ws.send(JSON.stringify({ type: 'event', sessionId: sid, seq: ++seq, event }));
        send({ kind: 'session_info', agentSessionId: 'sdk-shot-1' });
        send({ kind: 'thought_chunk', text: '用户要的是检查清单：先读当前页正文，再按要点逐条整理，最后给出可执行的核对项。' });
        send({ kind: 'message_chunk', text: '我先读取当前页面的正文，确认要点没有遗漏。' });
        send({ kind: 'tool_call', id: 't1', title: '读取当前页(read_current_page)', kind: 'read', detail: '' });
        setTimeout(() => {
          send({ kind: 'tool_call_update', id: 't1', status: 'completed', result: '正文 6 段：速率差 / 背压定义 / 拉取与有界队列 / 有界缓冲保底 / 水位线权衡', durationMs: 830 });
          send({ kind: 'message_chunk', text: '要点齐了，整理成清单如下。' });
          const answer = [
            '## 流式系统背压检查清单',
            '',
            '- [ ] **速率差显式管理**：是否有人回答「快端如何感知慢端」',
            '- [ ] **拉取优先**：异构消费者场景是否用 pull 而非 push',
            '- [ ] **缓冲全有界**：任何队列写满时的行为是降速 / 拒绝，而不是增长',
            '- [ ] **水位线权衡**：批大小与预取粒度作为整体调优，而非两个独立参数',
            '',
            '```text',
            '自检命令：压测时观察缓冲占用曲线——只升不降 = 没有背压',
            '```',
            '',
            '按这个清单逐项核对，管道的速率策略就完整了。',
          ].join('\n');
          for (const line of answer.split('\n')) send({ kind: 'message_chunk', text: line + '\n' });
          send({ kind: 'usage', costUSD: 0.042, durationMs: 6300 });
          send({ kind: 'turn_end', stopReason: 'end' });
        }, 700);
        break;
      }
      default: reply({});
    }
  });
});

// ---- 截图助手 ----
const shots = [];
const shot = async (sess, name) => {
  await sess.send('Page.bringToFront');
  await sleep(400);
  const r = await sess.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
  shots.push(name);
  console.log(`SHOT ${name}`);
};

const b = await launch({ port: 9371, url: 'about:blank', args: ['--window-size=1440,900', '--force-device-scale-factor=2'] });
try {
  const sw = await b.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [{ id: 'p', name: 'Mock', kind: 'anthropic', baseUrl: mock.url('c'), apiKey: 'k', models: ['mock-model'] }],
      activeProviderId: 'p',
      chat: { defaultEngine: 'llm' },
      translation: { targetLang: 'zh-CN', mode: 'bilingual', maxBlocks: 100, maxChars: 100000, batchBlocks: 1 },
      agentBridge: { url: `ws://127.0.0.1:${BRIDGE_PORT}`, token: 'mock-token', defaultAgentId: 'claude-code', baseDir: '', permissionMode: 'default', model: '' },
    },
    conversations: [],
  });
  sw.close();

  // ---- 1) 页内聊天卡：浮窗胶囊开卡 + 页面上下文追问 ----
  const page = await b.openTab(PAGE_URL, { wait: 2500 });
  await page.send('Page.bringToFront');
  await waitFor(() => page.evaluate(`!!document.getElementById('om-widget-host')?.shadowRoot?.querySelector('.pill')`), { timeout: 15000 });
  {
    const sw1 = await b.sw();
    await sw1.evaluate(`chrome.tabs.query({ url: '${PAGE_URL}' }).then(([t]) => chrome.storage.session.set({ pendingTask: { kind: 'ask', title: '快速提问', prompt: ${JSON.stringify(QUESTION)}, sourceUrl: '${PAGE_URL}', autoSend: true, ts: Date.now() } })).then(() => 'ok')`);
    sw1.close();
  }
  await page.evaluate(`document.getElementById('om-widget-host').shadowRoot.querySelector('.pill').click()`);
  const cardT = await waitFor(() => (async () => (await b.targets()).find((x) => x.type === 'iframe' && x.url.includes('/src/sidepanel/sidepanel.html')))(), { timeout: 12000 });
  const card = await connect(cardT.webSocketDebuggerUrl);
  await card.send('Runtime.enable');
  await waitFor(() => card.evaluate(`(document.body.textContent || '').includes('谁服从谁')`), { timeout: 20000 });
  await sleep(600); // 流式收尾 + 落盘
  await shot(page, 'chat-card.png');
  await page.evaluate(`document.getElementById('om-widget-host').shadowRoot.querySelector('.pill').click()`); // 收起卡片，还页面干净
  // 等聊天卡 iframe 真正卸载，防它污染后续截图与等待条件
  await waitFor(async () => !(await (async () => (await b.targets()).some((x) => x.type === 'iframe' && x.url.includes('/src/sidepanel/sidepanel.html')))()), { timeout: 8000 });
  await sleep(300);
  card.close();

  // ---- 2) 整页翻译：浮窗就地启动，英→中对照 ----
  await page.evaluate(`document.getElementById('om-widget-host').shadowRoot.querySelector('[data-act="translate-page"]').click()`);
  // 完成条件只看页面自身 DOM：译文块数达标且无「翻译中」标记（不受任何 iframe 文本影响）
  const txDone = await waitFor(() => page.evaluate(`(() => {
    const dsts = document.querySelectorAll('[data-om-tx-dst]').length;
    const waiting = document.querySelectorAll('[data-om-tx].om-tx-wait').length;
    return dsts >= ${TX_EXPECT_DSTS} && waiting === 0 ? dsts : '';
  })()`), { timeout: 30000 });
  console.log(`TX dsts=${txDone || '(超时)'}`, await page.evaluate(`(() => ({
    dsts: document.querySelectorAll('[data-om-tx-dst]').length,
    waiting: document.querySelectorAll('[data-om-tx].om-tx-wait').length,
    failed: document.querySelectorAll('[data-om-tx].om-tx-failed').length,
    blocks: document.querySelectorAll('[data-om-tx]').length,
  }))()`));
  await sleep(600);
  await shot(page, 'translate.png');

  // ---- 3) 划词思维导图：两段高亮 → 查看页显式生成 ----
  const selAct = async (act) => {
    for (let i = 0; i < 3; i++) {
      await b.activate(page.targetId);
      await sleep(250);
      const r = await page.evaluate(`(() => {
        const ps = [...document.querySelectorAll('main p')].filter((p) => !p.closest('.om-tx-zh') && p.textContent.trim());
        const p = ps[1]; // 第二段（正文段，跳过 byline）
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !node.textContent.trim()) node = walker.nextNode();
        const r = document.createRange();
        r.setStart(node, 0); r.setEnd(node, node.textContent.length);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return 'ok';
      })()`);
      if (r === 'ok') {
        const clicked = await page.evaluate(`(() => {
          const btn = document.getElementById('om-sel-host')?.shadowRoot?.querySelector('button[data-act="${act === 'highlight' ? 'highlight' : 'mindmap'}"]');
          if (!btn) return '';
          btn.click();
          return 'ok';
        })()`);
        if (clicked === 'ok') return true;
      }
      await sleep(400);
    }
    return false;
  };
  await selAct('highlight');
  await sleep(500);
  await selAct('mindmap');
  const mmT = await waitFor(() => (async () => (await b.targets()).find((t) => t.type === 'page' && t.url.includes('/src/mindmap/mindmap.html')))(), { timeout: 10000 });
  const mm = await connect(mmT.webSocketDebuggerUrl);
  await mm.send('Runtime.enable');
  await waitFor(() => mm.evaluate(`!document.getElementById('om-mm-input').hidden`), { timeout: 8000 });
  await mm.evaluate(`document.getElementById('om-mm-mat-run').click()`);
  await waitFor(() => mm.evaluate(`(document.getElementById('om-mm-status').textContent || '').includes('完成')`), { timeout: 20000 });
  await sleep(700);
  await shot(mm, 'mindmap.png');
  mm.close();
  await fetch(`${b.base}/json/close/${mmT.id}`);

  // ---- 4) Agent 引擎：独立聊天页，思考 + 工具步骤卡 + 答案 ----
  {
    const sw2 = await b.sw();
    await sw2.evaluate(`chrome.storage.local.get('llmSettings').then((o) => { o.llmSettings.chat = { ...(o.llmSettings.chat || {}), defaultEngine: 'agent' }; return chrome.storage.local.set({ llmSettings: o.llmSettings }); }).then(() => 'ok')`);
    sw2.close();
  }
  const chat = await b.openTab(`chrome-extension://${b.extId}/src/chatpage/chat.html`, { wait: 2000 });
  await waitFor(() => chat.evaluate(`!!document.getElementById('om-input')`), { timeout: 10000 });
  await chat.evaluate(`document.getElementById('om-input').value = ${JSON.stringify(AGENT_Q)}; document.getElementById('om-send').click()`);
  await waitFor(() => chat.evaluate(`(document.body.textContent || '').includes('只升不降')`), { timeout: 30000 });
  await sleep(800); // 步骤耗时 / usage 落定
  await shot(chat, 'agent.png');
  chat.close();

  console.log(`\nDONE ${shots.length} 张 → docs/screenshots/`);
} catch (e) {
  console.error('FAIL', e.stack || e.message);
} finally {
  await b.close();
  await mock.close();
  await new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); });
  web.close();
  process.exit(shots.length === 4 ? 0 : 1);
}
