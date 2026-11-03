// 一次性 e2e：复现用户的操作序列 检测→启动→再检测→再启动，
// 每步后断言结果栏与连接灯。bridge 全程在跑（不停止）。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, killTree } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = findChrome();
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'vela-seq-'));
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

let failed = 0;
function pass(name) { console.log('PASS', name); }
function fail(name, detail) { console.log('FAIL', name, detail ?? ''); failed = 1; }

async function readState(sess) {
  return JSON.parse(await evalInPage(sess, `JSON.stringify({
    conn: document.querySelector('#om-agent-conn')?.textContent,
    result: document.querySelector('#om-agent-result')?.textContent,
  })`));
}
async function clickAndWait(sess, sel, wantSub, timeoutMs = 20000) {
  await evalInPage(sess, `document.querySelector('${sel}').click()`);
  const t0 = Date.now();
  for (;;) {
    const st = await readState(sess);
    if (st.result && st.result.includes(wantSub)) return st;
    if (Date.now() - t0 > timeoutMs) return st;
    await sleep(500);
  }
}

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
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/src/options/options.html`, { method: 'PUT' })).json();
  await sleep(500);
  const sess = await connect(t.webSocketDebuggerUrl);
  await sess.send('Runtime.enable');
  await sess.send('Page.enable');
  await sess.send('Page.reload');
  await sleep(3000);

  let st = await readState(sess);
  if (st.conn.includes('已连接')) pass('进页自动探测 → ' + st.conn);
  else fail('进页自动探测', st.conn + ' / ' + st.result);

  // 检测 ①
  st = await clickAndWait(sess, '#om-agent-test', '✓');
  if (st.result.startsWith('✓')) pass('检测① → ' + st.result.slice(0, 40));
  else fail('检测①', st.result);

  // 启动 ①（bridge 已在跑，应立即连上）
  st = await clickAndWait(sess, '#om-agent-start', '✓');
  if (st.result.includes('✓') && st.conn.includes('已连接')) pass('启动① → ' + st.result + ' / ' + st.conn);
  else fail('启动①', st.result + ' / ' + st.conn);

  // 检测 ②——用户复现的失败点
  st = await clickAndWait(sess, '#om-agent-test', '✓');
  if (st.result.startsWith('✓')) pass('检测②（复现点）→ ' + st.result.slice(0, 40));
  else fail('检测②（复现点）', st.result);

  // 再来一轮：启动② + 检测③，确认稳定
  st = await clickAndWait(sess, '#om-agent-start', '✓');
  if (st.result.includes('✓')) pass('启动② → ' + st.result);
  else fail('启动②', st.result);
  st = await clickAndWait(sess, '#om-agent-test', '✓');
  if (st.result.startsWith('✓')) pass('检测③ → ' + st.result.slice(0, 40));
  else fail('检测③', st.result);

  st = await readState(sess);
  if (st.conn.includes('已连接')) pass('全程连接灯保持 → ' + st.conn);
  else fail('连接灯', st.conn);

  sess.close();
} catch (e) {
  fail('异常', e.message);
} finally {
  await killTree(chrome);
  await sleep(800);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  process.exit(failed);
}
