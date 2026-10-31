// e2e：扩展被「重新加载」后，页面里还开着的旧聊天卡不再往扩展「错误」页刷 "Extension context invalidated"，
// 且会自动刷新成新版本继续可用。复现用户报障：改代码后在 chrome://extensions 点重新加载，
// 打开着聊天卡的网页（nightlies.apache.org）里，旧卡的 bridge 重连定时器每次重试都抛未捕获异常。
// 断言以 Chrome 自己记录的扩展运行时错误（developerPrivate）为准，而不是页面日志。
// 用法：node scripts/verify-ctx-invalid.mjs（自起一个独立端口的 bridge，不动本机 39217）
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, waitFor, connect, createChecker, seedStorage } from './lib/cdp.mjs';

const { check, summary } = createChecker();
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BPORT = 39291;
const startBridge = () => spawn(process.execPath, ['index.js', '--port', String(BPORT)], { cwd: join(ROOT, 'bridge'), stdio: 'ignore', env: { ...process.env, VELA_NO_PROTOCOL_REGISTER: '1' } });
let bridge = startBridge();
const web = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end('<!doctype html><title>宿主页</title><article><h1>宿主页</h1><p>' + '内容填充'.repeat(30) + '</p></article>'); });
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${web.address().port}`;

const b = await launch({ port: 9383 });
try {
  await sleep(1500);
  const sw = await b.sw();
  await seedStorage(sw, { llmSettings: { agentBridge: { url: `ws://127.0.0.1:${BPORT}`, token: '' }, chat: { defaultEngine: 'agent' } }, conversations: [] });
  const page = await b.openTab(BASE + '/', { wait: 2200 });
  await page.send('Page.bringToFront');
  await sw.evaluate(`chrome.tabs.query({}).then((ts) => chrome.tabs.sendMessage(ts.find((x) => (x.url || '').startsWith('${BASE}')).id, { type: 'om:open-card' })).then(() => 1)`);
  sw.close();
  const frame = async () => (await b.targets()).find((x) => x.type === 'iframe' && x.url.includes('/src/sidepanel/sidepanel.html'));
  const t = await waitFor(frame, { timeout: 12000 });
  const card = await connect(t.webSocketDebuggerUrl);
  await card.send('Runtime.enable');
  await waitFor(() => card.evaluate(`!!document.getElementById('om-engine')`));
  // 旧卡先连上 bridge（之后 bridge 一掉就会触发它的重连定时器）
  const connected = await waitFor(() => card.evaluate(`import('/src/agent/client.js').then((m) => m.getAgentClient({}).status)`).then((s) => s === 'ready'), { timeout: 10000 });
  check('重载前：卡片已连上 bridge', !!connected);
  card.evaluate(`window.__oldDoc = 1`);

  // ---- 重新加载扩展（chrome://extensions 的「重新加载」同款接口） ----
  const ext = await b.openTab('chrome://extensions/', { wait: 1500 });
  await ext.evaluate(`new Promise((res) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => res(1)))`);
  await ext.evaluate(`new Promise((res) => chrome.developerPrivate.reload('${b.extId}', { failQuietly: true }, () => res(1)))`);
  await waitFor(async () => {
    const op = await b.openTab(`chrome-extension://${b.extId}/src/options/options.html`, { wait: 1000 });
    const id = await op.evaluate('chrome.runtime.id').catch(() => '');
    op.close();
    return id === b.extId;
  }, { timeout: 20000, interval: 800 });
  await sleep(1000);

  // ---- 旧卡此时 chrome.* 已失效；掉线 bridge 触发旧卡的重连定时器 ----
  bridge.kill();
  await sleep(500);
  bridge = startBridge();
  // 重连退避从 1s 起翻倍：等足够多次重试（旧版每次都会抛未捕获异常）
  await sleep(14000);

  // ---- 1. Chrome 记录的扩展运行时错误 ----
  const errs = JSON.parse(await ext.evaluate(`new Promise((res) => chrome.developerPrivate.getExtensionInfo('${b.extId}', (i) => res(JSON.stringify((i.runtimeErrors || []).map((e) => e.message)))))`));
  // 不能只匹配「context invalidated」：上下文拆除到不同阶段，同一根因会报成 `Cannot read properties of undefined (reading 'local')`
  check('Chrome 的扩展错误页里没有任何运行时错误（旧版每次重连都记一条）', errs.length === 0, errs);

  // ---- 2. 旧卡已自动刷新成新版：新文档、chrome.* 可用、能连上 bridge ----
  const t2 = await frame();
  const card2 = await connect(t2.webSocketDebuggerUrl);
  await card2.send('Runtime.enable');
  const fresh = await waitFor(() => card2.evaluate(`typeof window.__oldDoc === 'undefined' && !!chrome.runtime?.id && !!document.getElementById('om-engine')`), { timeout: 15000 });
  check('旧卡自动刷新成新版（新文档，chrome.* 可用）', !!fresh);
  const alive = await waitFor(() => card2.evaluate(`import('/src/agent/client.js').then((m) => m.getAgentClient({}).ensureReady().then(() => 'ok', (e) => 'err ' + e.message))`).then((r) => r === 'ok'), { timeout: 15000 });
  check('新卡能重新连上 bridge', !!alive);
  card2.close();
  ext.close();
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await b.close();
  bridge.kill();
  web.close();
}
process.exit(summary());
