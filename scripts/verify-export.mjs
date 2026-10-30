// 一次性 e2e：种子 3 轮问答的 agent 会话 → chatpage 点导出（默认工作区 docs/）
// → 断言落盘文件包含全部问题与回答原文（旧实现只覆盖最后一轮）。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, rmSync as rm } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe');
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'vela-exp-'));
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

const Q = ['第一问：如何配置数据库连接池', '第二问：解释一下事件循环', '第三问：写一个防抖函数'];
const A = ['答案一：设置 max 与 idleTimeout。', '答案二：事件循环按 phase 依次执行。', '答案三：`function debounce(f, ms) {}`'];

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
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/src/chatpage/chat.html`, { method: 'PUT' })).json();
  await sleep(500);
  const sess = await connect(t.webSocketDebuggerUrl);
  await sess.send('Runtime.enable');
  await sess.send('Page.enable');
  await sleep(1500); // 等页面首载完成（含默认会话初始化），再覆盖种子数据

  // 种子写在页面上下文（与 smoke-test 同款时序）：先开页再写，避免首载的
  // 默认会话初始化把种子覆盖掉
  const seeded = await evalInPage(sess, `(async () => {
    await chrome.storage.local.set({ llmSettings: { agentBridge: { url: 'ws://127.0.0.1:39217', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' } } });
    const now = Date.now();
    const items = [];
    for (let i = 0; i < 3; i++) {
      items.push({ id: 'msg:q' + i, conversationId: 'conv:export-test', type: 'question', parentItemId: '', content: ${JSON.stringify(Q)}[i], createdAt: now - 6000 + i * 1000 });
      items.push({ id: 'msg:a' + i, conversationId: 'conv:export-test', type: 'answer', parentItemId: 'msg:q' + i, content: ${JSON.stringify(A)}[i], model: 'agent · claude-code', createdAt: now - 5000 + i * 1000, stopped: false, error: '' });
    }
    await chrome.storage.local.set({ conversations: [{ id: 'conv:export-test', title: '导出验证会话', engine: 'agent', createdAt: now - 7000, updatedAt: now, items }] });
    return 'ok';
  })()`);
  if (seeded !== 'ok') throw new Error('种子写入失败: ' + seeded);
  await sess.send('Page.reload');
  await sleep(2500); // 等会话加载 + bridge 自动配对

  // 选中种子会话并点导出
  const picked = await evalInPage(sess, `(async () => {
    const item = [...document.querySelectorAll('.om-conv-item')]
      .find((e) => e.querySelector('.om-conv-title')?.textContent === '导出验证会话');
    if (!item) return 'no-item:' + [...document.querySelectorAll('.om-conv-item .om-conv-title')].map((e) => e.textContent).join(',') + '|' + document.querySelectorAll('.om-conv-item').length;
    item.click();
    await new Promise((r) => setTimeout(r, 300));
    const btn = document.getElementById('om-export');
    if (!btn || btn.disabled) return 'btn-disabled:items=' + document.querySelectorAll('.om-msg, .om-message').length + '|active=' + document.querySelector('.om-conv-item.active, .om-conv-item[data-active], .om-conv-item.selected')?.textContent;
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    return document.querySelector('.om-export-name')?.value || 'no-name';
  })()`);
  if (typeof picked !== 'string' || picked === 'no-item' || picked === 'btn-disabled') throw new Error('导出前置失败: ' + picked);
  const filename = picked;
  check('导出弹层预填文件名', filename.includes('导出验证会话'), filename);

  // 点「导出」→ 等 toast 已导出
  const toast = await evalInPage(sess, `(async () => {
    const go = [...document.querySelectorAll('.om-export-pop button')].find((b) => b.textContent === '导出');
    if (!go) return 'no-go';
    go.click();
    const t0 = Date.now();
    for (;;) {
      const el = document.querySelector('.om-toast, .om-toast-msg, [class*=toast]');
      const text = el ? el.textContent : '';
      if (text.includes('已导出')) return text;
      if (Date.now() - t0 > 10000) return text || 'timeout';
      await new Promise((r) => setTimeout(r, 300));
    }
  })()`);
  check('导出完成 toast', String(toast).includes('已导出'), String(toast));

  // 读工作区 docs/ 落盘文件，断言全部轮次都在
  const wsDir = join(homedir(), '.vela-bridge', 'workspaces', 'conv-export-test');
  let md = '';
  try { md = readFileSync(join(wsDir, 'docs', filename), 'utf8'); } catch (e) { md = ''; }
  check('文件已落盘工作区 docs/', !!md, join(wsDir, 'docs', filename));
  for (let i = 0; i < 3; i++) {
    check(`包含第 ${i + 1} 问原文`, md.includes(Q[i]), Q[i]);
    check(`包含第 ${i + 1} 答原文`, md.includes(A[i]), A[i]);
  }
  check('文档标题为会话标题', md.startsWith('# 导出验证会话'), md.split('\n')[0]);

  sess.close();
} catch (e) {
  console.error('FAIL 异常', e.message);
  failed = 1;
} finally {
  chrome.kill();
  await sleep(800);
  rmSync(profile, { recursive: true, force: true });
  try { rm(join(homedir(), '.vela-bridge', 'workspaces', 'conv-export-test'), { recursive: true, force: true }); } catch { /* 不存在就算了 */ }
  process.exit(failed);
}
