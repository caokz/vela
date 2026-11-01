// 设置页：供应商增删改、测试连接、设默认、全局参数、网页翻译、快捷动作编辑。
// manifest 已声明 host_permissions <all_urls>，供应商 origin 授权 contains 即过；
// 保留 request 流程以便日后回退 optional 授权上架。

import {
  loadSettings, saveSettings, getAdapter, normalizeBaseUrl, originPattern, DEFAULT_QUICK_ACTIONS,
} from '../llm/store.js';
import { ProviderHttpError, httpErrorMessage } from '../llm/sse.js';

const $ = (sel) => document.querySelector(sel);
const tpl = $('#om-provider-tpl');
const statusEl = $('#om-status');

let settings = await loadSettings();
let activeId = settings.activeProviderId;

function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = `status ${cls}`;
}

async function ensureOriginPermission(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) throw new Error('Base URL 无法解析');
  if (pattern.startsWith('chrome')) return;
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  if (granted) return;
  // 必须在用户手势（保存/测试按钮回调）内调用
  const ok = await chrome.permissions.request({ origins: [pattern] });
  if (!ok) throw new Error(`未授权访问 ${pattern}，无法请求该供应商`);
}

function readCard(card) {
  return {
    id: card.dataset.id,
    name: card.querySelector('.p-name').value.trim() || '未命名',
    kind: card.querySelector('.p-kind').value,
    baseUrl: normalizeBaseUrl(card.querySelector('.p-url').value),
    apiKey: card.querySelector('.p-key').value.trim(),
    models: card.querySelector('.p-models').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
  };
}

async function testProvider(card, provider) {
  const resultEl = card.querySelector('.p-test-result');
  resultEl.textContent = '测试中…';
  const t0 = performance.now();
  try {
    await ensureOriginPermission(provider.baseUrl);
    const adapter = getAdapter(provider.kind);
    let models;
    try {
      models = await adapter.listModels(provider.baseUrl, provider.apiKey);
    } catch (err) {
      // /models 不存在（部分网关）：Anthropic 协议退回最小补全请求测试
      if (!(err instanceof ProviderHttpError && err.status === 404)) throw err;
      await adapter.streamChat(provider.baseUrl, provider.apiKey, {
        messages: [{ role: 'user', content: 'hi' }],
        model: provider.models[0] || '',
        onDelta: () => {},
        params: { maxTokens: 1 },
      });
      models = provider.models;
    }
    const ms = Math.round(performance.now() - t0);
    resultEl.textContent = `✓ 连通（${ms}ms，${models.length} 个模型）`;
    // 把拉到的模型列表回填到输入框（合并去重）
    if (models.length) {
      const merged = [...new Set([...provider.models, ...models])];
      card.querySelector('.p-models').value = merged.join(', ');
    }
  } catch (err) {
    resultEl.textContent = `✗ ${httpErrorMessage(err) || err.message}`;
  }
}

function addCard(provider = { id: crypto.randomUUID(), name: '', kind: 'openai', baseUrl: '', apiKey: '', models: [] }) {
  const card = tpl.content.firstElementChild.cloneNode(true);
  card.dataset.id = provider.id;
  card.querySelector('.p-name').value = provider.name;
  card.querySelector('.p-kind').value = provider.kind;
  card.querySelector('.p-url').value = provider.baseUrl;
  card.querySelector('.p-key').value = provider.apiKey;
  card.querySelector('.p-models').value = provider.models.join(', ');
  card.querySelector('.p-default').checked = provider.id === activeId;

  card.querySelector('.p-default').addEventListener('change', () => {
    activeId = provider.id;
    document.querySelectorAll('.provider').forEach((c) => {
      c.classList.toggle('active', c.dataset.id === activeId);
      c.querySelector('.p-default').checked = c.dataset.id === activeId;
    });
  });
  card.querySelector('.p-kind').addEventListener('change', () => {
    const url = card.querySelector('.p-url');
    if (!url.value.trim()) {
      url.placeholder = card.querySelector('.p-kind').value === 'anthropic'
        ? 'https://api.anthropic.com'
        : 'https://api.openai.com/v1';
    }
  });
  card.querySelector('.p-test').addEventListener('click', () => testProvider(card, readCard(card)));
  card.querySelector('.p-del').addEventListener('click', () => {
    if (!confirm(`删除供应商「${card.querySelector('.p-name').value || '未命名'}」？`)) return;
    card.remove();
    if (activeId === provider.id) activeId = '';
  });

  $('#om-providers').appendChild(card);
  return card;
}

$('#om-add').addEventListener('click', () => addCard());

// 翻译目标语言/模式可被浮窗齿轮就地改写；保存时未动过的下拉沿用 storage 现值，
// 不拿进页快照覆盖（与 agentBridge 现取现读同一原因）
let txLangTouched = false;
let txModeTouched = false;
$('#om-tx-lang').addEventListener('change', () => { txLangTouched = true; });
$('#om-tx-mode').addEventListener('change', () => { txModeTouched = true; });
let chatEngineTouched = false;
$('#om-chat-engine').addEventListener('change', () => { chatEngineTouched = true; });

// ---- 本地 Agent bridge ----
const agentResult = $('#om-agent-result');

// token 不在界面配置：bridge 首次握手自动配对（client.js 写回 storage），
// 这里只读界面上的其余字段，保存时与已存 agentBridge 合并、不动 token
function readAgentBridge() {
  return {
    url: $('#om-agent-url').value.trim() || 'ws://127.0.0.1:39217',
    defaultAgentId: $('#om-agent-default').value,
    baseDir: $('#om-agent-basedir').value.trim() || '~/.vela-bridge/workspaces',
    permissionMode: $('#om-agent-perm').value,
    model: $('#om-agent-model').value.trim(),
  };
}

// 连接就绪后重建「默认 agent」下拉 + 模型预设 datalist，返回 agents 供检测结果文案。
// 检测按钮、启动成功、进页自动连上（connListener 的 ready 沿）都会调；
// 重建时保留已选值（agent 已卸装则回「未设置」），datalist 重建避免重复检测越积越多
async function refreshAgentOptions(client) {
  await client.ensureReady();
  const { agents } = await client.listAgents();
  const sel = $('#om-agent-default');
  const prev = sel.value;
  sel.innerHTML = '<option value="">（未设置）</option>';
  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    sel.appendChild(opt);
  }
  sel.value = agents.some((a) => a.id === prev) ? prev : '';
  await refreshAgentModelPresets(client, sel.value || agents.find((a) => a.authed)?.id);
  return agents;
}

// 模型预设 datalist 动态化：经 bridge 拉 agent 背后 LLM 网关的模型列表。
// 静态别名按 agent 家族区分：claude 系认 opus/sonnet/haiku；codex 系模型名迭代快，
// 离线时不硬编码错误名字（拉不到就留空 datalist，手填不受影响）
async function refreshAgentModelPresets(client, agentId) {
  const dl = $('#om-agent-model-presets');
  const aliases = agentId && String(agentId).startsWith('codex') ? [] : ['opus', 'sonnet', 'haiku'];
  dl.innerHTML = aliases.map((v) => `<option value="${v}"></option>`).join('');
  if (!agentId) return;
  try {
    const { models } = await client.listModels(agentId);
    for (const id of models.slice(0, 50)) {
      const opt = document.createElement('option');
      opt.value = id;
      dl.appendChild(opt);
    }
  } catch { /* 网关不支持 /v1/models 时静默回退别名 */ }
}

// 切换「默认 agent」：模型预设同步换列表，避免 codex 下还提示 claude 的模型
$('#om-agent-default').addEventListener('change', async () => {
  try {
    const { getAgentClient } = await import('../agent/client.js');
    const client = getAgentClient({ onStatus: connListener });
    await client.ensureReady();
    await refreshAgentModelPresets(client, $('#om-agent-default').value);
  } catch { /* bridge 未连接时保留静态别名 */ }
});

$('#om-agent-test').addEventListener('click', () => withButton($('#om-agent-test'), '检测中…', async () => {
  agentResult.textContent = '连接中…';
  // 与启动/停止共用页面单例：检测完不能 close——close 关的是共享 socket，
  // 会把别的按钮刚建立的连接杀掉，且 _closedByUs 不复位会让后续重连错乱
  const { getAgentClient } = await import('../agent/client.js');
  const settings = await loadSettings();
  // 先按输入框暂存，检测的是用户正在编辑的配置
  await saveSettings({ ...settings, agentBridge: { ...settings.agentBridge, ...readAgentBridge() } });
  const client = getAgentClient({ onStatus: connListener });
  const agents = await refreshAgentOptions(client);
  if (!agents.length) {
    agentResult.textContent = '✓ bridge 已连接，但没有装任何 agent';
  } else {
    agentResult.textContent = agents
      .map((a) => `${a.authed ? '✓' : '✗'} ${a.name}${a.version ? ` ${a.version}` : ''}${a.authed ? '' : `（先运行 ${a.loginCommand?.join(' ') || '登录命令'}）`}`)
      .join('；');
  }
}));

// 启动/停止 bridge：启动走 vela-bridge:// 协议（bridge 首次运行时注册到系统，
// Chrome 弹「打开 Vela Bridge？」确认框，勾选记住后以后免确认），
// 随后轮询连接确认；停止走 bridge.shutdown op，服务端回 ok 后进程退出，
// 状态灯随 onStatus 实时反映（ready 时断开会先报一次 disconnected，拿它确认退出）
const agentConn = $('#om-agent-conn');
const statusWaiters = [];
// ready 沿自动刷新 agent 下拉与模型预设：进页自动连上、启动按钮拉起、bridge 重启
// 重连都不用再手点「检测」；10s 防抖挡重连风暴反复拉
let agentInfoRefreshedAt = 0;
const connListener = (s) => {
  agentConn.textContent = s === 'ready' ? '● 已连接' : s === 'connecting' ? '◐ 连接中' : '○ 未连接';
  agentConn.classList.toggle('om-conn-on', s === 'ready');
  if (s === 'ready' && Date.now() - agentInfoRefreshedAt > 10_000) {
    agentInfoRefreshedAt = Date.now();
    import('../agent/client.js')
      .then(({ getAgentClient }) => refreshAgentOptions(getAgentClient({ onStatus: connListener })))
      .catch(() => { /* 刷新失败保持现状，「检测」按钮可手动重试 */ });
  }
  for (const fn of [...statusWaiters]) {
    try { fn(s); } catch { /* 等待方自己的异常不影响状态分发 */ }
  }
};
function waitStatus(pred, timeoutMs) {
  return new Promise((resolve) => {
    const finish = (v) => {
      clearTimeout(timer);
      const i = statusWaiters.indexOf(cb);
      if (i >= 0) statusWaiters.splice(i, 1);
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const cb = (s) => { if (pred(s)) finish(true); };
    statusWaiters.push(cb);
  });
}
async function withButton(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await fn(); }
  catch (err) { agentResult.textContent = `✗ ${err.message}`; }
  finally { btn.disabled = false; btn.textContent = old; }
}

$('#om-agent-start').addEventListener('click', () => withButton($('#om-agent-start'), '启动中…', async () => {
  agentResult.textContent = '正在拉起 bridge…（Chrome 首次会弹「打开 Vela Bridge？」确认框，请允许）';
  const settings = await loadSettings();
  // 先按输入框暂存，连接用的是用户正在编辑的 url（token 走自动配对）
  await saveSettings({ ...settings, agentBridge: { ...settings.agentBridge, ...readAgentBridge() } });
  const { getAgentClient } = await import('../agent/client.js');
  const client = getAgentClient({ onStatus: connListener });
  // 未注册协议时 Chrome 静默忽略本次导航，走下面的轮询超时兜底提示
  location.href = 'vela-bridge://launch';
  const t0 = Date.now();
  let lastErr = '';
  for (;;) {
    try {
      await client.ensureReady();
      agentResult.textContent = '✓ bridge 已启动并连接';
      return;
    } catch (e) { lastErr = e.message; /* 还没起来或配置不对，继续轮询 */ }
    if (Date.now() - t0 > 15000) break;
    await new Promise((r) => setTimeout(r, 1500));
    agentResult.textContent = `等待 bridge 启动…（${Math.round((Date.now() - t0) / 1000)}s / 15s）`;
  }
  // token 走自动配对不会失败，超时只剩连接类原因，提示转手动启动
  agentResult.textContent = `✗ 15 秒内未连上（${lastErr}）：先在 bridge 目录运行一次 node index.js（注册启动协议），或用 start.bat 手动启动`;
}));

$('#om-agent-stop').addEventListener('click', () => withButton($('#om-agent-stop'), '停止中…', async () => {
  agentResult.textContent = '正在连接 bridge…';
  const { getAgentClient } = await import('../agent/client.js');
  const client = getAgentClient({ onStatus: connListener });
  await client.ensureReady();
  await client.shutdownBridge();
  // ready 状态的连接被服务端关闭会先报一次 disconnected，5 秒内等到即确认进程退出
  const exited = await waitStatus((s) => s === 'disconnected', 5000);
  agentResult.textContent = exited ? '✓ bridge 已停止' : '停止指令已发送（未确认退出，可点「检测」核实）';
}));

$('#om-save').addEventListener('click', async () => {
  const cards = [...document.querySelectorAll('.provider')];
  const providers = [];
  for (const card of cards) {
    const p = readCard(card);
    if (!p.baseUrl && !p.apiKey) continue; // 全空卡片跳过
    if (!p.baseUrl || !p.apiKey || !p.models.length) {
      setStatus(`「${p.name}」缺少 Base URL / Key / 模型，未保存`, 'err');
      return;
    }
    providers.push(p);
  }
  // 逐个请求 host 权限；拒绝则中止保存（没有权限扩展页 fetch 会被 CORS 拦）
  try {
    for (const p of providers) await ensureOriginPermission(p.baseUrl);
  } catch (err) {
    setStatus(err.message, 'err');
    return;
  }
  // agentBridge 现取现读：页面打开期间自动配对可能已把 token 写进 storage，
  // 用启动时的快照合并会把 token 冲掉
  const curSettings = await loadSettings();
  const next = {
    providers,
    activeProviderId: providers.find((p) => p.id === activeId) ? activeId : (providers[0]?.id ?? ''),
    defaults: {
      temperature: $('#om-temp').value === '' ? null : Number($('#om-temp').value),
      maxTokens: Number($('#om-maxtok').value || 0),
      systemPrompt: $('#om-system').value,
    },
    agentBridge: { ...curSettings.agentBridge, ...readAgentBridge() },
    chat: {
      ...curSettings.chat,
      // 聊天顶栏切引擎也会写 defaultEngine：本页没动过就保留存储里的最新值
      defaultEngine: chatEngineTouched ? $('#om-chat-engine').value : curSettings.chat.defaultEngine,
      toolMaxSteps: Math.min(50, Math.max(1, Number($('#om-chat-maxsteps').value || 12))),
    },
    translation: {
      targetLang: txLangTouched ? $('#om-tx-lang').value : curSettings.translation.targetLang,
      mode: txModeTouched ? $('#om-tx-mode').value : curSettings.translation.mode,
      maxBlocks: Number($('#om-tx-maxblocks').value || 1500),
      maxChars: Number($('#om-tx-maxchars').value || 300000),
      batchBlocks: Number($('#om-tx-batchblocks').value || 6),
    },
    quickActions: readQuickActions(),
  };
  await saveSettings(next);
  try {
    await chrome.runtime.sendMessage({ type: 'om:refresh-menus' });
  } catch { /* SW 未拉起时 onInstalled 已建好默认菜单 */ }
  setStatus(`已保存 ${providers.length} 个供应商`, 'ok');
});

// ---- 快捷动作编辑器 ----
const qaList = $('#om-qa-list');

function qaRow(qa = { id: crypto.randomUUID(), title: '', prompt: '' }) {
  const row = document.createElement('div');
  row.className = 'qa-row';
  row.dataset.id = qa.id;
  row.innerHTML = `
    <input class="qa-title" type="text" placeholder="菜单标题，如：翻译成中文" />
    <input class="qa-prompt" type="text" placeholder="prompt 模板，{text} 为选中文本" />`;
  row.querySelector('.qa-title').value = qa.title;
  row.querySelector('.qa-prompt').value = qa.prompt;
  const del = document.createElement('button');
  del.className = 'qa-del danger';
  del.textContent = '删除';
  del.addEventListener('click', () => row.remove());
  row.appendChild(del);
  return row;
}

function readQuickActions() {
  return [...qaList.querySelectorAll('.qa-row')]
    .map((row) => ({
      id: row.dataset.id,
      title: row.querySelector('.qa-title').value.trim(),
      prompt: row.querySelector('.qa-prompt').value,
    }))
    .filter((qa) => qa.title && qa.prompt);
}

$('#om-qa-add').addEventListener('click', () => qaList.appendChild(qaRow()));
$('#om-qa-reset').addEventListener('click', () => {
  qaList.innerHTML = '';
  for (const qa of DEFAULT_QUICK_ACTIONS) qaList.appendChild(qaRow(structuredClone(qa)));
});

// ---- 初始化 ----
// 连接状态实时刷新：注册监听即建单例，进页自动探测一次——
// bridge 在跑且 token 已配对则直接亮「已连接」，用户不用点任何按钮确认状态
{
  const { getAgentClient } = await import('../agent/client.js');
  getAgentClient({ onStatus: connListener }).ensureReady().catch(() => { /* 未启动/未配对，状态灯保持未连接 */ });
}
for (const p of settings.providers) addCard(p);
if (!settings.providers.length) addCard();
$('#om-temp').value = settings.defaults.temperature ?? '';
$('#om-maxtok').value = settings.defaults.maxTokens || '';
$('#om-system').value = settings.defaults.systemPrompt || '';
$('#om-agent-url').value = settings.agentBridge.url;
$('#om-agent-basedir').value = settings.agentBridge.baseDir;
$('#om-agent-perm').value = settings.agentBridge.permissionMode || 'default';
$('#om-agent-model').value = settings.agentBridge.model || '';
if (settings.agentBridge.defaultAgentId) {
  const opt = document.createElement('option');
  opt.value = settings.agentBridge.defaultAgentId;
  opt.textContent = settings.agentBridge.defaultAgentId;
  $('#om-agent-default').appendChild(opt);
  $('#om-agent-default').value = settings.agentBridge.defaultAgentId;
}
$('#om-tx-lang').value = settings.translation.targetLang;
$('#om-tx-mode').value = settings.translation.mode;
$('#om-tx-maxblocks').value = settings.translation.maxBlocks;
$('#om-tx-maxchars').value = settings.translation.maxChars;
$('#om-tx-batchblocks').value = settings.translation.batchBlocks;
$('#om-chat-engine').value = settings.chat.defaultEngine;
$('#om-chat-maxsteps').value = settings.chat.toolMaxSteps;
for (const qa of settings.quickActions) qaList.appendChild(qaRow(structuredClone(qa)));
