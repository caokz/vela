// 一次性验证：设置页本地 Agent 启停按钮的真实链路 + 截图。
// 前提：bridge 正在跑（ws://127.0.0.1:39217）、~/.vela-bridge/token.json 存在。
// 结束后 bridge 会被停止——脚本末尾重新拉起（detached）。
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE_DIR = join(EXT_ROOT, 'bridge');
const CHROME = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe');
const PORT = 9333;
const OUT_SHOTS = join(EXT_ROOT, 'dist');

const token = JSON.parse(readFileSync(join(homedir(), '.vela-bridge', 'token.json'), 'utf8')).token;

const profile = mkdtempSync(join(tmpdir(), 'vela-buttons-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT_ROOT}`,
  `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let msgId = 0;
function fail(msg) { console.log('FAIL', msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS', msg); }

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}
async function evalInPage(sess, expr) {
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
}
async function screenshot(sess, name) {
  const r = await sess.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(OUT_SHOTS, name), Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
}

try {
  // SW 就绪 → 拿扩展 ID → 预写 token 进 storage
  let swTarget = null;
  for (let i = 0; i < 40 && !swTarget; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      swTarget = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js'));
    } catch { /* retry */ }
  }
  if (!swTarget) throw new Error('SW 未注册');
  const extId = new URL(swTarget.url).host;
  const swSess = await connect(swTarget.webSocketDebuggerUrl);
  await swSess.send('Runtime.enable');
  await evalInPage(swSess, `(async () => {
    await chrome.storage.local.set({ llmSettings: { agentBridge: { url: 'ws://127.0.0.1:39217', token: '${token}', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' } } });
    return 'ok';
  })()`);

  // 开设置页，等自动探测
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/src/options/options.html`, { method: 'PUT' })).json();
  await sleep(500);
  const sess = await connect(t.webSocketDebuggerUrl);
  await sess.send('Runtime.enable');
  await sess.send('Page.enable');
  await sess.send('Page.reload');
  await sleep(2500); // 等自动探测握手

  const state1 = await evalInPage(sess, `JSON.stringify({
    conn: document.querySelector('#om-agent-conn')?.textContent,
    btnW: [...document.querySelectorAll('.agent-actions button')].map(b => b.textContent + ':' + Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height)),
    stopBorder: getComputedStyle(document.querySelector('#om-agent-stop')).borderTopWidth,
  })`);
  console.log('state1 =', state1);
  const s1 = JSON.parse(state1);
  pass('进页自动探测亮灯: ' + s1.conn) || 0;
  if (!s1.conn.includes('已连接')) fail('自动探测未亮「已连接」: ' + s1.conn);
  else pass('进页自动探测 → 已连接');
  if (s1.btnW.length !== 3) fail('按钮数不对: ' + s1.btnW.join(','));
  else pass('三个按钮: ' + s1.btnW.join(' | '));
  if (s1.stopBorder === '0px') fail('停止按钮无边框');
  else pass('停止按钮有边框 ' + s1.stopBorder);
  await screenshot(sess, 'verify-agent-1-connected.png');

  // 点停止 → 等 disconnected 确认
  await evalInPage(sess, `document.querySelector('#om-agent-stop').click()`);
  await sleep(3000);
  const state2 = JSON.parse(await evalInPage(sess, `JSON.stringify({
    conn: document.querySelector('#om-agent-conn')?.textContent,
    result: document.querySelector('#om-agent-result')?.textContent,
  })`));
  console.log('state2 =', JSON.stringify(state2));
  if (!state2.result.includes('✓ bridge 已停止')) fail('停止反馈不对: ' + state2.result);
  else pass('停止反馈: ' + state2.result);
  await screenshot(sess, 'verify-agent-2-stopped.png');

  // 端口应已释放
  let portFree = false;
  try { execSync('netstat -ano | findstr :39217 | findstr LISTENING', { stdio: 'pipe', shell: 'cmd.exe' }); } catch { portFree = true; }
  if (portFree) pass('端口 39217 已释放（进程退出）');
  else fail('端口仍被占用');

  sess.close(); swSess.close();
} catch (err) {
  fail(err.message);
} finally {
  chrome.kill();
  await sleep(800);
  rmSync(profile, { recursive: true, force: true });
  // 恢复 bridge（detached，隐藏窗口：shell:true 会留一个不关的 cmd 控制台）
  spawn('powershell', ['-Command',
    `Start-Process -FilePath 'node' -ArgumentList 'index.js' -WorkingDirectory '${BRIDGE_DIR}' -WindowStyle Hidden -RedirectStandardOutput 'bridge-detached.log' -RedirectStandardError 'bridge-detached.err.log'`],
  { detached: true, stdio: 'ignore' }).unref();
  await sleep(3500);
  try {
    execSync('netstat -ano | findstr :39217 | findstr LISTENING', { stdio: 'pipe', shell: 'cmd.exe' });
    console.log('bridge 已恢复运行');
  } catch { console.log('警告: bridge 未能自动恢复，需手动启动'); }
}
