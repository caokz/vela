// e2e：agent 模型下拉跟随所选 agent（v0.9.0 修复回归）+ Agent 引导卡（v1.0.0）。
// 模型下拉：旧版把 models.list 结果缓存成全局单值，且不监听 agent 切换：切到 codex 后
// 模型下拉仍是 claude 网关的列表。mock bridge 按 agentId 回不同列表，断言：
// 切换后下拉重建为新 agent 的模型、默认项文字带新 agent 的探测默认模型、
// 切回 claude 复原；codex 系网关回空列表时只留「默认模型」（codex 家族无静态别名）。
// 引导卡：新会话默认引擎是 agent，没装 bridge 的首启用户此前只能靠发送后的 toast
// 猜原因。断言：有已登录 agent 不显卡；bridge 在但全未登录 → 「还没有已登录的 agent」
// 形态；bridge 进程消失 → 「Agent 引擎需要本机 bridge」形态；bridge 恢复后经
// 后台重连（handleAgentStatus ready → refreshAgents）卡片自动消失，无需重载。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, killTree } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9347;
const BRIDGE_PORT = 39403;

const require = createRequire(import.meta.url);
const { WebSocketServer } = require(join(EXT_ROOT, 'bridge', 'node_modules', 'ws'));

// ---- mock bridge：hello / agents.list（三个 agent）/ models.list 按 agentId 分流 ----
const modelsCalls = []; // models.list 收到的 agentId 序列
let authedAll = true; // 引导卡场景：置 false 后 agents.list 全部 authed:false
const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', authed: true, version: 'mock', defaultModel: 'claude-def' },
  { id: 'codex', name: 'Codex CLI', authed: true, version: 'mock', defaultModel: 'codex-def' },
  { id: 'codex-nomodel', name: 'Codex CLI 空列表', authed: true, version: 'mock', defaultModel: 'codex-x-def' },
];
const MODEL_LISTS = {
  'claude-code': ['claude-m-a', 'claude-m-b'],
  codex: ['codex-m-a', 'codex-m-b'],
  'codex-nomodel': [], // 空列表 → 前端回退 codex 家族别名（无）= 只留默认项
};
// 同端口可重建：bridge「恢复」场景需要关掉再原样起一个
const makeBridge = () => {
  const s = new WebSocketServer({ port: BRIDGE_PORT });
  s.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const reply = (result) => ws.send(JSON.stringify({ id: m.id, ok: true, result }));
      switch (m.op) {
        case 'hello':
          reply({ token: 'mock-token' });
          break;
        case 'agents.list':
          reply({ agents: AGENTS.map((a) => ({ ...a, authed: authedAll })) });
          break;
        case 'models.list':
          modelsCalls.push(String(m.params?.agentId || ''));
          reply({ models: MODEL_LISTS[m.params?.agentId] ?? [] });
          break;
        default:
          reply({});
      }
    });
  });
  return s;
};
let wss = makeBridge();

const profile = mkdtempSync(join(tmpdir(), 'vela-am-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  'about:blank',
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

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = 1;
};

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

  // 先落种子再开聊天页：无供应商（引擎落 agent）+ mock bridge 地址 + 默认 claude-code
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
    return 'ok';
  })()`);
  if (seed !== 'ok') throw new Error('种子未落 storage: ' + seed);
  optSess.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${optTarget.id}`);
  await sleep(300);

  const chatTarget = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/src/chatpage/chat.html`, { method: 'PUT' })).json();
  await sleep(600);
  const chat = await connect(chatTarget.webSocketDebuggerUrl);
  await chat.send('Runtime.enable');

  // 模型下拉当前选项（value|label 拼串，便于整体断言）
  const modelOptions = () => evalIn(chat, `[...document.querySelectorAll('#om-agent-model-sel option')].map((o) => o.value + '|' + o.textContent)`);
  async function waitOptions(pred, label) {
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      const opts = await modelOptions();
      if (pred(opts)) return opts;
    }
    return null;
  }
  const switchAgent = (id) => evalIn(chat, `(() => {
    const sel = document.getElementById('om-agent');
    sel.value = ${JSON.stringify(id)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`);

  // 1) agent 下拉就绪：三个 agent，默认选 claude-code
  let agentsReady = '';
  for (let i = 0; i < 30 && !agentsReady; i++) {
    await sleep(300);
    agentsReady = await evalIn(chat, `(() => {
      const sel = document.getElementById('om-agent');
      return sel && sel.options.length >= 3 && sel.value === 'claude-code' ? 'ok' : '';
    })()`);
  }
  check('agent 下拉列出三个 agent 且默认 claude-code', agentsReady === 'ok');

  // 2) 初始模型列表来自 claude-code 网关，默认项文字带 claude 探测默认模型
  const init = await waitOptions((o) => o.some((s) => s.startsWith('claude-m-a|')), '初始 claude 列表');
  check('初始模型列表 = claude 网关模型', init && init.length === 3 && init[0].startsWith('|默认模型（claude-def）'), JSON.stringify(init));

  // 3) 切到 codex：下拉重建为 codex 模型，无 claude 残留；默认项带 codex 探测默认模型
  check('切换到 codex', (await switchAgent('codex')) === 'codex');
  const codexOpts = await waitOptions((o) => o.some((s) => s.startsWith('codex-m-a|')), 'codex 列表');
  check('codex 模型下拉无 claude 残留', codexOpts && codexOpts.length === 3 && codexOpts.every((s) => !s.includes('claude-')), JSON.stringify(codexOpts));
  check('codex 默认项文字带 codex 探测模型', codexOpts && codexOpts[0].startsWith('|默认模型（codex-def）'), JSON.stringify(codexOpts?.[0]));
  check('bridge 收到 agentId=codex 的 models.list', modelsCalls.includes('codex'), JSON.stringify(modelsCalls));

  // 4) 切回 claude-code：列表复原（缓存已按 agent 重拉）
  await switchAgent('claude-code');
  const backOpts = await waitOptions((o) => o.some((s) => s.startsWith('claude-m-a|')) && !o.some((s) => s.startsWith('codex-m-')), '切回 claude');
  check('切回 claude-code 列表复原', backOpts && backOpts.some((s) => s.startsWith('claude-m-b|')), JSON.stringify(backOpts));

  // 5) codex 系网关回空列表：只留「默认模型」（codex 家族无静态别名可回退）
  await switchAgent('codex-nomodel');
  const emptyOpts = await waitOptions((o) => o.length === 1, '空列表回退');
  check('codex 空列表时只留默认项', emptyOpts && emptyOpts.length === 1 && emptyOpts[0].startsWith('|默认模型（codex-x-def）'), JSON.stringify(emptyOpts));

  // ---- Agent 引导卡 ----
  const cardText = () => evalIn(chat, `(() => { const c = document.querySelector('.om-empty-card'); return c ? c.textContent : ''; })()`);
  async function waitCard(pred, label) {
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      const t = await cardText();
      if (t && pred(t)) return t;
    }
    return '';
  }

  // 6) 有已登录 agent：不显卡
  check('有已登录 agent 时不显示引导卡', (await cardText()) === '');

  // 7) bridge 在但全未登录 → 「还没有已登录的 agent」形态，两条路都写明
  authedAll = false;
  await evalIn(chat, 'location.reload()');
  await sleep(1500);
  const cardB = await waitCard((t) => t.includes('还没有已登录的 agent'), '已连无登录');
  check('bridge 在但无已登录 agent → 引导卡（已连形态）', !!cardB, cardB.slice(0, 60));
  check('已连形态写明两条路（终端登录 / 切 LLM）', cardB.includes('登录') && cardB.includes('LLM'), cardB.slice(0, 120));
  check('引导卡带「打开设置」按钮', await evalIn(chat, '!!document.getElementById("om-empty-agent-settings")') === true);

  // 8) bridge 进程消失 → 「Agent 引擎需要本机 bridge」形态，带启动指引
  // ws 的 close() 只停接新连接、不踢存量连接：页面侧 WS 挂着时回调永不触发，
  // 必须先 terminate 再 close，另加 2s 兜底防再挂
  await new Promise((r) => {
    for (const c of wss.clients) c.terminate();
    const t = setTimeout(r, 2000);
    wss.close(() => { clearTimeout(t); r(); });
  });
  authedAll = true; // 恢复数据供恢复场景用
  await evalIn(chat, 'location.reload()');
  await sleep(1500);
  const cardA = await waitCard((t) => t.includes('Agent 引擎需要本机 bridge'), '未连形态');
  check('bridge 未连接 → 引导卡（未连形态）', !!cardA, cardA.slice(0, 60));
  check('未连形态含启动指引与「不消耗 API Key」', cardA.includes('start.bat') && cardA.includes('不消耗 API Key'), cardA.slice(0, 140));

  // 9) bridge 原端口恢复：后台重连成功 → 卡片自动消失（不重载页面）
  wss = makeBridge();
  let cardGone = false;
  for (let i = 0; i < 50 && !cardGone; i++) {
    await sleep(500);
    cardGone = (await cardText()) === '';
  }
  check('bridge 恢复后引导卡自动消失（后台重连触发）', cardGone);

  chat.close();
} catch (e) {
  console.error('FAIL 异常', e.message);
  failed = 1;
} finally {
  await killTree(chrome);
  wss.close();
  await sleep(800);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  process.exit(failed);
}
