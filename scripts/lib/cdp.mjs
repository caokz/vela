// e2e 共用 CDP 工具：拉起加载了未打包扩展的 Chromium、连 target、在页面求值、真实鼠标输入。
// 零依赖（Node 22+ 内置 WebSocket / fetch）。新写的 e2e 脚本统一用它，旧脚本保持自带实现。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';

export const EXT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 结果收集：PASS/FAIL 逐条打印，结束时 summary() 给退出码
export function createChecker() {
  const failures = [];
  const check = (name, ok, detail = '') => {
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${d ? ' — ' + d.slice(0, 400) : ''}`);
    if (!ok) failures.push(name);
    return ok;
  };
  return { check, failures, summary: () => (failures.length ? 1 : 0) };
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败 ' + wsUrl)); });
  let msgId = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method) for (const l of listeners) l(m);
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, (m) => res(m.result ?? { error: m.error }));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr, { contextId } = {}) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
    if (r?.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 600));
    return r?.result?.value;
  };
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: 'left',
    buttons: type === 'mousePressed' ? 1 : 0, pointerType: 'mouse', clickCount: 1, ...extra,
  });
  const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
  return { ws, send, evaluate, mouse, click, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

// 轮询直到 fn() 返回真值（异常视为未就绪）
export async function waitFor(fn, { timeout = 10000, interval = 200 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch { /* 未就绪 */ }
    await sleep(interval);
  }
  return last;
}

/**
 * 拉起 Chromium：加载 extDir（默认仓库根）的扩展，返回 { port, extId, targets(), openTab(url), sw(), close() }
 */
export async function launch({ port, extDir = EXT_ROOT, url = 'about:blank', args = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'vela-e2e-'));
  const chrome = spawn(findChrome(), [
    `--user-data-dir=${profile}`, `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
    `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--window-size=1280,900', ...args, url,
  ], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const targets = async () => (await fetch(`${base}/json`)).json();
  const swTarget = await waitFor(async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js')), { timeout: 20000, interval: 500 });
  if (!swTarget) { chrome.kill(); throw new Error('CDP 未就绪或扩展 SW 未注册'); }
  const extId = new URL(swTarget.url).host;
  const sw = async () => {
    const t = (await targets()).find((x) => x.type === 'service_worker' && x.url.includes(extId));
    const s = await connect(t.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    return s;
  };
  // 新开标签并连上（等 load 事件或超时）
  const openTab = async (u, { wait = 1500 } = {}) => {
    const t = await (await fetch(`${base}/json/new?${u}`, { method: 'PUT' })).json();
    const s = await connect(t.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    await s.send('Page.enable');
    await sleep(wait);
    s.targetId = t.id;
    return s;
  };
  const activate = (targetId) => fetch(`${base}/json/activate/${targetId}`);
  const close = async () => {
    chrome.kill();
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 句柄未释放时忽略 */ }
  };
  return { port, extId, base, targets, sw, openTab, activate, close, profile };
}

// 扩展存储预置（经 SW 执行）。SW 刚注册时 chrome.storage 可能还没挂上，先等就绪
export async function seedStorage(swSess, obj) {
  await waitFor(() => swSess.evaluate(`typeof chrome !== 'undefined' && !!chrome.storage?.local`), { timeout: 10000 });
  return swSess.evaluate(`(async () => { await chrome.storage.local.set(${JSON.stringify(obj)}); return 'ok'; })()`);
}
