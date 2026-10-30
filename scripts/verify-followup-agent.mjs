// 面板追问自动发送的 agent 竞态 e2e（v0.7.5 修复回归）：
// 聊天卡刚打开时 refreshAgents（bridge 连接 + agents.list）尚未完成，
// 旧版 consumePendingTask 同步 ensureEngine 会误报「没有可用的 agent」。
// mock bridge 把 agents.list 人为延迟 2.5s 复现竞态，断言自动发送仍能等到
// agent 就绪并完成整轮（session.new → prompt → 事件帧 → 答案渲染）。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe');
const PORT = 9346;
const WEB = 39325;
const BRIDGE_PORT = 39402;
const AGENT_DELAY_MS = 2500; // 复现竞态：agent 列表晚于聊天卡初始化到达

const require = createRequire(import.meta.url);
const { WebSocketServer } = require(join(EXT_ROOT, 'bridge', 'node_modules', 'ws'));

const PAGE = '<!doctype html><html><body><p id="txt">The quick brown fox jumps over the lazy dog.</p></body></html>';
const server = createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(WEB, '127.0.0.1', r));

// ---- mock bridge：hello / agents.list（延迟）/ session.new / prompt + 事件帧 ----
const prompts = []; // session.prompt 收到的正文
const bridgeSessions = new Set();
const wss = new WebSocketServer({ port: BRIDGE_PORT });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const reply = (result) => ws.send(JSON.stringify({ id: m.id, ok: true, result }));
    switch (m.op) {
      case 'hello':
        reply({ token: 'mock-token' });
        break;
      case 'agents.list':
        // 每次都延迟：聊天卡初始化与 consumePendingTask 都拿不到立即可用的 agent
        setTimeout(() => reply({ agents: [{ id: 'claude-code', name: 'Claude Code', authed: true, version: 'mock' }] }), AGENT_DELAY_MS);
        break;
      case 'models.list':
        reply({ models: [] });
        break;
      case 'session.new':
        reply({ sessionId: 's-mock1', workspacePath: 'C:/tmp/w' });
        break;
      case 'session.prompt': {
        prompts.push(String(m.params?.text || ''));
        reply({});
        const sid = m.params?.sessionId || 's-mock1';
        let seq = 0;
        const send = (event) => ws.send(JSON.stringify({ type: 'event', sessionId: sid, seq: ++seq, event }));
        send({ kind: 'session_info', agentSessionId: 'sdk-mock-1' });
        send({ kind: 'message_chunk', text: 'mock 回答：译文准确。' });
        send({ kind: 'turn_end', stopReason: 'end' });
        break;
      }
      default:
        reply({});
    }
  });
});

const profile = mkdtempSync(join(tmpdir(), 'vela-fu-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  `http://127.0.0.1:${WEB}/page`,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { send, close: () => ws.close() };
}
const evalIn = async (sess, expr) => {
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r?.result?.value;
};
async function waitTarget(urlPart) {
  for (let i = 0; i < 24; i++) {
    await sleep(400);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const t = targets.find((x) => ['page', 'iframe'].includes(x.type) && x.url.includes(urlPart) && x.webSocketDebuggerUrl);
    if (t) {
      try {
        const s = await connect(t.webSocketDebuggerUrl);
        await s.send('Runtime.enable');
        return s;
      } catch { continue; }
    }
  }
  return null;
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = 1;
};

const QUESTION = '这个翻译准确吗？';

try {
  let extId = '';
  for (let i = 0; i < 40 && !extId; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const sw = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js'));
      if (sw) extId = new URL(sw.url).host;
    } catch { /* retry */ }
  }
  if (!extId) throw new Error('SW 未注册');

  const pageTarget = await (async () => {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const t = targets.find((x) => x.type === 'page' && x.url.startsWith(`http://127.0.0.1:${WEB}/page`));
      if (t) return t;
    }
    return null;
  })();
  if (!pageTarget) throw new Error('测试页未打开');

  // 种子：无供应商（引擎走 agent）+ mock bridge 地址；再预写追问 pendingTask，
  // 卡片打开即 consumePendingTask —— 与「面板追问回车 → SW 开卡 + 写任务」同路径
  const optTarget = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/src/options/options.html`, { method: 'PUT' })).json();
  await sleep(800);
  const optSess = await connect(optTarget.webSocketDebuggerUrl);
  await optSess.send('Runtime.enable');
  const seed = await evalIn(optSess, `(async () => {
    await chrome.storage.local.set({
      llmSettings: {
        providers: [],
        activeProviderId: '',
        agentBridge: { url: 'ws://127.0.0.1:${BRIDGE_PORT}', token: 'mock-token', defaultAgentId: 'claude-code', baseDir: '', permissionMode: 'default', model: '' },
      },
      conversations: [],
    });
    await chrome.storage.session.set({
      pendingTask: { kind: 'ask', title: '快速提问', prompt: ${JSON.stringify(QUESTION)}, sourceUrl: 'http://127.0.0.1:${WEB}/page', autoSend: true, ts: Date.now() },
    });
    return 'ok';
  })()`);
  if (seed !== 'ok') throw new Error('种子未落 storage: ' + seed);
  optSess.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${optTarget.id}`);
  await sleep(300);

  const sess = await connect(pageTarget.webSocketDebuggerUrl);
  await sess.send('Runtime.enable');
  await sess.send('Page.enable');
  await sess.send('Page.bringToFront');
  await sleep(300);
  if (!await evalIn(sess, `Boolean(document.getElementById('om-widget-host'))`)) throw new Error('浮窗未注入');

  // 打开聊天卡：卡片加载即消费 pendingTask（agent 列表还在延迟途中 = 竞态窗口）
  const t0 = Date.now();
  await evalIn(sess, `document.getElementById('om-widget-host')?.shadowRoot.querySelector('.pill').click()`);
  const card = await waitTarget('src/sidepanel/sidepanel.html');
  if (!card) throw new Error('聊天卡 target 未出现');

  // 等答案渲染（含 agent 延迟 2.5s + 等待循环，8s 守卫预算内）
  let answered = '';
  for (let i = 0; i < 40 && !answered; i++) {
    await sleep(500);
    answered = await evalIn(card, `(() => {
      const t = document.body.textContent || '';
      return t.includes('mock 回答：译文准确。') ? 'answer' : '';
    })()`);
  }
  const elapsed = Date.now() - t0;
  check('追问自动发送等到了延迟就绪的 agent（整轮完成）', answered === 'answer', `耗时 ${elapsed}ms`);
  const askedShown = await evalIn(card, `(document.body.textContent || '').includes(${JSON.stringify(QUESTION)})`);
  check('追问原文已作为消息渲染', askedShown);
  check('mock bridge 收到追问正文', prompts.some((p) => p.includes(QUESTION)), JSON.stringify(prompts.map((p) => p.slice(0, 40))));
  check('耗时在等待预算内（未走 8s 失败路径）', elapsed < 8000, `${elapsed}ms`);

  card.close();
  sess.close();
} catch (e) {
  console.error('FAIL 异常', e.message);
  failed = 1;
} finally {
  chrome.kill();
  wss.close();
  server.close();
  await sleep(800);
  rmSync(profile, { recursive: true, force: true });
  process.exit(failed);
}
