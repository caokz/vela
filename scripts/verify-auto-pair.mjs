// 一次性 e2e：扩展 storage 不带 token → 打开设置页 → 自动配对亮「已连接」、token 落 storage。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'vela-pair-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--load-extension=${EXT_ROOT}`, `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
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
const evalInPage = async (sess, expr) => (await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

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
  const swSess = await connect((await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'service_worker').webSocketDebuggerUrl);
  await swSess.send('Runtime.enable');
  // 预置无 token 的 agentBridge 配置
  await evalInPage(swSess, `(async () => {
    await chrome.storage.local.set({ llmSettings: { agentBridge: { url: 'ws://127.0.0.1:39217', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' } } });
    return 'ok';
  })()`);

  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/src/options/options.html`, { method: 'PUT' })).json();
  await sleep(500);
  const sess = await connect(t.webSocketDebuggerUrl);
  await sess.send('Runtime.enable');
  await sess.send('Page.enable');
  await sess.send('Page.reload');
  await sleep(3000); // 等自动探测 + 配对 + 状态回调

  const conn = await evalInPage(sess, `document.querySelector('#om-agent-conn')?.textContent`);
  // 从页面上下文读 storage（SW 上下文可能已休眠）
  const stored = await evalInPage(sess, `(async () => (await chrome.storage.local.get('llmSettings')).llmSettings?.agentBridge?.token?.length)()`);
  const hasTokenInput = await evalInPage(sess, `Boolean(document.querySelector('#om-agent-token'))`);
  const h2 = await evalInPage(sess, `document.querySelector('#om-llm-section')?.textContent`);
  console.log(JSON.stringify({ conn, storedTokenLen: stored, hasTokenInput, h2 }));
  const ok = conn?.includes('已连接') && stored >= 32 && !hasTokenInput && h2 === '模型供应商（API Key）';
  console.log(ok ? 'PASS 自动配对全链路' : 'FAIL ' + JSON.stringify({ conn, stored, hasTokenInput, h2 }));
  process.exitCode = ok ? 0 : 1;
  sess.close(); swSess.close();
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(800);
  rmSync(profile, { recursive: true, force: true });
}
