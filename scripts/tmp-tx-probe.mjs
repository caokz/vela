// 临时探针：复现 tmp-screenshots 的翻译场景，dump 块收录 / 回填落点 / 批请求形态，定位截图异常。
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, waitFor, connect, seedStorage } from './lib/cdp.mjs';
import { startMockLlm } from './lib/mock-llm.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const PARAS = [
  ['Streaming pipelines', '流式管道把数据从生产者持续搬运到消费者，理想状态下两边速率一致。'],
  ['Reality rarely cooperates.', '现实很少配合：消费者的处理速度会随负载波动，生产者却往往只顾自己的节奏往前推。'],
  ['Backpressure is the answer', '背压（backpressure）就是把这种速率差显式管理起来：让快的一端感知慢的一端。'],
  ['Two strategies dominate.', '两种策略占主导：响应式拉取让消费者按容量逐批请求数据；有界队列则在缓冲写满时让上游降速。'],
];
// 翻译协议要求 JSON 字符串数组回复；按块内文本精确路由到中文
const TX = new Map(PARAS.map(([en, zh]) => [en, zh]));
TX.set('Backpressure in Streaming Systems', '流式系统中的背压');
TX.set('What backpressure means', '背压是什么');
const article = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Backpressure</title>
<style>body{font:17px/1.7 Georgia,serif;max-width:700px;margin:40px auto;padding:0 20px}p{margin:0 0 16px}</style></head><body>
<h1>Backpressure in Streaming Systems</h1>
<p>${PARAS[0][0]} move data from producers to consumers continuously. In the ideal case both sides run at the same rate.</p>
<p>${PARAS[1][0]} Consumer throughput fluctuates with load, while producers are often happy to push at their own pace.</p>
<h2>What backpressure means</h2>
<p>${PARAS[2][0]} Backpressure is about managing that rate mismatch explicitly: the fast end should feel the slow end.</p>
<p>${PARAS[3][0]} Two strategies dominate. Reactive pull has consumers request batches by capacity; bounded queues ask the upstream to slow down.</p>
</body></html>`;

const web = createServer((req, res) => {
  if (req.url === '/article') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(article); }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${web.address().port}/article`;

const mock = await startMockLlm({
  respond: (req) => {
    const u = [...req.messages].reverse().find((m) => m.role === 'user' && m.text)?.text || '';
    // 复刻旧脚本：纯文本回复（无 JSON 数组）
    for (const [en, zh] of PARAS) if (u.includes(en)) return { text: zh, chunkDelayMs: 4 };
    return { text: '（mock 默认回答）', chunkDelayMs: 4 };
  },
});

const b = await launch({ port: 9373, url: 'about:blank' });
try {
  const sw = await b.sw();
  await seedStorage(sw, {
    llmSettings: {
      providers: [{ id: 'p', name: 'Mock', kind: 'anthropic', baseUrl: mock.url('c'), apiKey: 'k', models: ['mock-model'] }],
      activeProviderId: 'p',
      chat: { defaultEngine: 'llm' },
      translation: { targetLang: 'zh-CN', mode: 'bilingual', maxBlocks: 100, maxChars: 100000, batchBlocks: 1 },
      agentBridge: { url: 'ws://127.0.0.1:1', token: '', defaultAgentId: '', baseDir: '', permissionMode: 'default', model: '' },
    },
    conversations: [],
  });
  sw.close();

  const page = await b.openTab(PAGE_URL, { wait: 2000 });
  await waitFor(() => page.evaluate(`!!document.getElementById('om-widget-host')?.shadowRoot?.querySelector('.pill')`), { timeout: 15000 });
  await page.evaluate(`document.getElementById('om-widget-host').shadowRoot.querySelector('[data-act="translate-page"]').click()`);

  // 等 12s 让全部批次走完，然后 dump 状态
  await sleep(12000);
  const dump = await page.evaluate(`(() => {
    const blocks = [...document.querySelectorAll('[data-om-tx]')].map((n) => ({
      id: n.getAttribute('data-om-tx'),
      tag: n.tagName,
      text: (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 50),
      wait: n.classList.contains('om-tx-wait'),
    }));
    const dsts = [...document.querySelectorAll('.om-tx-dst,[data-om-tx-dst]')].map((n) => ({
      forId: n.getAttribute('data-om-tx-dst'),
      parentTag: n.parentElement?.tagName,
      parentText: (n.parentElement?.innerText || '').replace(/\\s+/g, ' ').slice(0, 50),
      prevTag: n.previousElementSibling?.tagName,
      text: (n.textContent || '').slice(0, 50),
    }));
    return JSON.stringify({ blocks, dsts, inline: [...document.querySelectorAll('p > *, h1 > *, h2 > *')].map((n) => n.outerHTML.slice(0, 120)) }, null, 1);
  })()`);
  console.log('=== DOM 状态 ===');
  console.log(dump);
  console.log('=== mock 收到的请求 ===');
  for (const r of mock.requests.slice(0, 2)) {
    const u = [...r.messages].reverse().find((m) => m.role === 'user' && m.text)?.text || '';
    console.log('---FULL---');
    console.log(u);
  }
} catch (e) {
  console.error('FAIL', e.stack || e.message);
} finally {
  await b.close();
  await mock.close();
  web.close();
  process.exit(0);
}
