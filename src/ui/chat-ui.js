// 共享聊天视图：侧边栏面板和独立聊天页共用。
// 职责：会话列表（侧栏+过滤）、消息渲染（气泡/来源 chip/Markdown）、流式接收与节流持久化、
// 页面功能（总结/翻译）接线、pendingTask 消费。DOM 骨架由 shell.js 提供。

import { renderMarkdown } from './markdown.js';
import { streamChat, loadSettings } from '../llm/store.js';
import {
  loadConversations, saveConversations, newConversation,
  newUserItem, newAssistantItem, updateConversation, deleteConversation, makeTitle,
} from '../storage/conversations.js';
import { buildShell, showToast, ICONS } from './shell.js';
import { summarizeCurrentTab, translateCurrentTab, cancelTranslate } from '../page/page-actions.js';
import { getAgentClient } from '../agent/client.js';
import { buildAgentPrompt, buildConversationMarkdown, knowledgeLocalDirs } from '../agent/compose.js';
import { createTurnState, applyEvent, markRendered, turnStateToMeta, stateFromMeta } from '../agent/render.js';

const PERSIST_THROTTLE_MS = 500;
const AGENTS_CACHE_MS = 30000;
const AGENT_NAMES = { 'claude-code': 'Claude Code' };
// 流式正文的 Markdown 重渲染节流：每帧全量重解析是 O(n²)，长回答后期会卡
const BODY_RENDER_MS = 250;

// 步骤/轮耗时展示：<60s 显示「12s」，更长显示「1m03s」
function formatDur(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function svgIcon(name, size = 14) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[name];
  return svg;
}

// 上传相对路径清洗（扩展侧第一道，bridge sanitizeRelPath 第二道）：
// 保留 / 作段分隔，段内 Windows 非法字符与控制字符替换 _，段尾点/空格剥掉
function sanitizeName(name) {
  return String(name || '')
    .replace(/\\/g, '/')
    .replace(/[:*?"<>|\u0000-\u001f]/g, '_')
    .split('/')
    .map((seg) => seg.replace(/[. ]+$/, '') || '_')
    .join('/');
}

export async function createChatView() {
  const variant = location.pathname.includes('chatpage') ? 'wide' : 'panel';
  const R = buildShell({ variant });

  // 知识库按钮数量角标（syncEngineUi 维护）
  const kbBadge = document.createElement('span');
  kbBadge.className = 'om-kb-badge';
  kbBadge.hidden = true;
  R.kbBtn.appendChild(kbBadge);

  let conversations = await loadConversations();
  // 初始会话：聊天卡带 ?conv=<id>（宿主 widget 按标签页记的上次会话）则恢复它，
  // 否则恢复最近活跃的会话（最后一条消息时间从新到旧），对齐 Monica 的打开即续聊
  let currentId = '';
  const wantedConv = window.parent !== window ? new URLSearchParams(location.search).get('conv') : '';
  if (wantedConv && conversations.some((c) => c.id === wantedConv)) currentId = wantedConv;
  if (!currentId) currentId = conversations.slice().sort((a, b) => lastActive(b) - lastActive(a))[0]?.id ?? '';
  let streaming = null; // {kind:'llm', abort, flushNow, persistStopped} | {kind:'agent', sessionId}
  // agent 轮运行中用户仍可发消息：入队（userItem 已落盘，关页不丢），本轮结束自动逐条发出
  const agentQueue = [];
  let translating = false;
  let exporting = false; // LLM 引擎一次性总结导出进行中（agent 引擎直接写盘，瞬时完成）
  let providersEmpty = false;

  // ---- agent 引擎：bridge 客户端（每页单例） + 当前 turn + 探测缓存 ----
  let agentTurn = null; // {sessionId, state, answer, conv, done, lastSeq, liveEl, interrupt}
  let turnLossTimer = 0; // 断线宽限定时器：超时未重连则本地收尾当前 agent 轮
  let agentsCache = [];
  let agentsCacheAt = 0;
  const agentClient = getAgentClient({
    onEvent: handleAgentEvent,
    onStatus: handleAgentStatus,
  });

  function currentEngine() {
    const eng = conversations.find((c) => c.id === currentId)?.engine || 'llm';
    // 未配供应商时 LLM 选项不出现，引擎一律按 agent 处理
    return providersEmpty && eng === 'llm' ? 'agent' : eng;
  }

  function selectedAgent() {
    return R.agentSelect.value || '';
  }

  // 新会话一律 agent 引擎（顶栏已无切换入口）；历史 LLM 会话保留原引擎继续可用
  function newConv(title) {
    const conv = newConversation(title);
    conv.engine = 'agent';
    return conv;
  }

  let agentsError = '';

  async function refreshAgents(force = false) {
    if (!force && agentsCache.length && Date.now() - agentsCacheAt < AGENTS_CACHE_MS) return agentsCache;
    try {
      await agentClient.ensureReady();
      const { agents } = await agentClient.listAgents();
      agentsCache = agents;
      agentsCacheAt = Date.now();
      agentsError = '';
    } catch (e) {
      agentsCache = [];
      agentsCacheAt = 0;
      agentsError = e.message || String(e);
    }
    R.agentSelect.innerHTML = '';
    const authed = agentsCache.filter((a) => a.authed);
    if (!authed.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = agentsCache.length
        ? '没有已登录的 agent'
        : `bridge 未连接：${agentsError}`;
      opt.disabled = true;
      opt.selected = true;
      R.agentSelect.appendChild(opt);
      syncAgentModelOptions(conversations.find((c) => c.id === currentId));
      return agentsCache;
    }
    for (const a of authed) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.name}${a.version ? ` · ${a.version}` : ''}`;
      R.agentSelect.appendChild(opt);
    }
    const settings = await loadSettings();
    const preferred = settings.agentBridge.defaultAgentId;
    if (authed.some((a) => a.id === preferred)) R.agentSelect.value = preferred;
    // 默认项文字依赖探测回传的 CLI 默认模型，缓存刷新后重同步
    syncAgentModelOptions(conversations.find((c) => c.id === currentId));
    return agentsCache;
  }

  // 引擎是会话级属性，顶栏不再放切换框（默认本地 Agent 模式）：
  // 这里只按当前引擎同步模型/agent 选择器、输入框下方的权限模式与 agent 模型选择器、知识库按钮状态
  let permDefault = 'default'; // 设置页全局默认；renderModelOptions 时刷新
  let modelDefault = ''; // 设置页默认模型；留空=用 SDK/CLI 默认
  const PERM_LABELS = { default: '每步审批', acceptEdits: '自动接受编辑', bypassPermissions: '自动放行' };
  // 模型下拉选项经 bridge 的 models.list 动态拉取（agent 背后的 LLM 网关 /v1/models，
  // 与 Orca 同思路）；拉不到时回退这三个别名，选项仍可手填覆盖
  const MODEL_FALLBACKS = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
  let agentModels = null; // null=未拉到（bridge 离线/网关不支持），用回退别名
  let agentModelsAt = 0; // 上次尝试时间；失败 60s 内不重试，避免每次引擎同步都打 bridge

  async function refreshAgentModels() {
    if (agentModels || Date.now() - agentModelsAt < 60000) return;
    agentModelsAt = Date.now();
    try {
      await agentClient.ensureReady();
      const agentId = R.agentSelect.value || (await loadSettings()).agentBridge.defaultAgentId;
      if (!agentId) { agentModelsAt = 0; return; }
      const { models } = await agentClient.listModels(agentId);
      if (Array.isArray(models) && models.length) {
        agentModels = models.slice(0, 50);
        syncAgentModelOptions(conversations.find((c) => c.id === currentId));
      }
    } catch { /* 回退预设，等下次引擎同步再试 */ }
  }

  // agent 模型下拉：动态模型列表 + 会话已存的自定义值；默认项文字带出真实落点
  // （设置页默认 > CLI 默认，即 env ANTHROPIC_MODEL——probe 探测回传）
  function syncAgentModelOptions(conv) {
    const cur = conv?.model || '';
    const list = agentModels ? agentModels.map((id) => [id, id]) : MODEL_FALLBACKS;
    const cliDefault = agentsCache.find((a) => a.id === R.agentSelect.value && a.authed)?.defaultModel || '';
    const eff = modelDefault || cliDefault;
    const opts = [['', eff ? `默认模型（${eff}）` : '默认模型'], ...list];
    if (cur && !list.some(([v]) => v === cur)) opts.push([cur, cur]);
    R.agentModel.innerHTML = '';
    for (const [v, t] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      // [1M] 后缀 = 网关 1M 上下文变体，长任务生成明显更慢；点名提示显式选网关模型
      if (!v && eff.includes('[1M]')) {
        o.title = '当前默认是 1M 上下文变体（[1M] 后缀），长任务可能明显更慢；建议从列表显式选择模型';
      }
      R.agentModel.appendChild(o);
    }
    R.agentModel.value = cur;
  }

  function syncEngineUi() {
    const engine = currentEngine();
    const conv = conversations.find((c) => c.id === currentId);
    R.model.style.display = engine === 'llm' ? '' : 'none';
    R.agentSelect.style.display = engine === 'agent' ? '' : 'none';
    if (engine === 'agent') {
      R.permSelect.style.display = '';
      R.permSelect.value = conv?.permissionMode || permDefault;
      R.agentModel.style.display = '';
      syncAgentModelOptions(conv);
    } else {
      R.permSelect.style.display = 'none';
      R.agentModel.style.display = 'none';
    }
    const kbCount = conv?.knowledge?.length || 0;
    R.kbBtn.classList.toggle('om-active', kbCount > 0);
    kbBadge.textContent = kbCount > 99 ? '99+' : String(kbCount);
    kbBadge.hidden = kbCount === 0;
    R.kbBtn.title = conv?.projectDir
      ? `知识库；工作目录已绑定 ${conv.projectDir}`
      : '知识库';
    R.exportBtn.disabled = !!streaming || translating || exporting || !hasExportableItems();
    if (engine === 'agent') { refreshAgents(); refreshAgentModels(); }
    renderMessages();
  }

  // 会话级权限模式：写回会话记录，session.new/resume 每轮带上，无需新会话
  R.permSelect.addEventListener('change', async () => {
    const conv = conversations.find((c) => c.id === currentId);
    if (!conv) return;
    const v = R.permSelect.value;
    conv.permissionMode = v;
    await updateConversation(conv.id, (c) => { c.permissionMode = v; });
    showToast(R.toast, `权限模式：${PERM_LABELS[v] || v}（下一轮生效）`);
  });

  // 会话级 agent 模型：空=用设置页默认；写回会话记录，下一轮生效
  R.agentModel.addEventListener('change', async () => {
    const conv = conversations.find((c) => c.id === currentId);
    if (!conv) return;
    const v = R.agentModel.value;
    if (v) conv.model = v; else delete conv.model;
    await updateConversation(conv.id, (c) => {
      if (v) c.model = v; else delete c.model;
    });
    showToast(R.toast, v ? `模型：${v}（下一轮生效）` : '模型：回到默认（下一轮生效）');
  });

  // agent 事件帧 → 当前 turn；断线重连后补帧
  function handleAgentEvent(frame) {
    if (!agentTurn || frame.sessionId !== agentTurn.sessionId) return;
    agentTurn.lastSeq = frame.seq;
    applyEvent(agentTurn.state, frame.event);
    // 审批卡在消息流里，滚出视口就看不见——30 分钟无人应答按拒绝收场，
    // 看起来就是「卡死」。toast 提醒用户去看审批卡
    if (frame.event.kind === 'permission_request') {
      showToast(R.toast, `等待权限审批：${frame.event.title || ''}`, 'info');
    }
    if (frame.event.kind === 'turn_end') agentTurn.done?.();
    else scheduleAgentFlush();
  }

  // bridge 状态变化：主动提示 + 有轮次在等时限时中断。
  // 断线只在「曾连上过」时 toast（启动时 bridge 未开不刷屏）；重连成功补一条恢复提示。
  // 轮次等待给 5 秒重连窗口（重连退避 1s→2s→4s，瞬时抖动能接上），
  // 超时仍未连上或重连后 replay 失败（bridge 重启后 session 已丢），本地收尾当前轮，
  // 否则 turn_end 永不到达，UI 卡在「停止」态点不动
  let lastAgentStatus = '';
  let warnedDisconnect = false;
  function handleAgentStatus(s) {
    const wasReady = lastAgentStatus === 'ready';
    lastAgentStatus = s;
    if (s === 'ready') {
      clearTimeout(turnLossTimer);
      catchUpAgentTurn();
      if (warnedDisconnect) {
        warnedDisconnect = false;
        showToast(R.toast, 'bridge 已重连');
      }
      return;
    }
    if (wasReady) {
      warnedDisconnect = true;
      showToast(R.toast, 'bridge 连接断开，正在自动重连…', 'error', true);
    }
    if (!agentTurn?.interrupt) return;
    clearTimeout(turnLossTimer);
    turnLossTimer = setTimeout(() => {
      if (agentClient.status !== 'ready' && agentTurn?.interrupt) {
        agentTurn.interrupt('bridge 连接中断，本轮未完成；恢复后可重新生成');
        showToast(R.toast, 'bridge 连接未恢复，已中断本轮等待', 'error');
        warnedDisconnect = false; // 结论已给，不再重复刷恢复提示
      }
    }, 5000);
  }

  async function catchUpAgentTurn() {
    if (!agentTurn) return;
    try {
      const { events } = await agentClient.replay(agentTurn.sessionId, agentTurn.lastSeq);
      for (const e of events) {
        agentTurn.lastSeq = e.seq;
        applyEvent(agentTurn.state, e.event);
        if (e.event.kind === 'turn_end') agentTurn.done?.();
      }
      scheduleAgentFlush();
    } catch {
      // 已 ready 还 replay 失败，基本是 bridge 重启丢了会话：本地收尾，不再死等
      agentTurn.interrupt?.('bridge 已重启，本轮上下文丢失；请重新发送');
    }
  }

  // ---- 设置页（顶栏齿轮 + 侧栏底部，双入口） ----
  const openSettings = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
  };
  R.topSettingsBtn.addEventListener('click', openSettings);
  R.settingsBtn.addEventListener('click', openSettings);

  // ---- 侧栏抽屉（panel 变体） ----
  const closeDrawer = () => document.body.classList.remove('om-side-open');
  R.menuBtn.addEventListener('click', () => document.body.classList.toggle('om-side-open'));
  R.scrim.addEventListener('click', closeDrawer);

  // ---- 会话列表：按活跃时间（最后一条消息时间）从新到旧 ----
  function lastActive(c) {
    return c.items?.[c.items.length - 1]?.createdAt ?? c.createdAt ?? 0;
  }

  // 标题行内编辑：铅笔按钮或双击进入；Enter/blur 提交（空值回退原标题），Esc 取消
  function startConvRename(item, conv) {
    const title = item.querySelector('.om-conv-title');
    if (!title) return;
    const input = document.createElement('input');
    input.className = 'om-conv-title-input';
    input.value = conv.title;
    input.addEventListener('click', (e) => e.stopPropagation());
    let done = false;
    const commit = async (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== conv.title) {
        conv.title = v;
        await updateConversation(conv.id, (c) => { c.title = v; });
      }
      renderConvList();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
    title.replaceWith(input);
    input.focus();
    input.select();
  }

  function renderConvList() {
    const q = R.filter.value.trim().toLowerCase();
    R.convList.innerHTML = '';
    const list = conversations
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .sort((a, b) => lastActive(b) - lastActive(a));
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'om-conv-empty';
      empty.textContent = q ? '没有匹配的对话' : '暂无对话';
      R.convList.appendChild(empty);
      return;
    }
    for (const c of list) {
      const item = document.createElement('div');
      item.className = `om-conv-item${c.id === currentId ? ' om-active' : ''}`;
      item.dataset.convId = c.id;
      const title = document.createElement('span');
      title.className = 'om-conv-title';
      title.textContent = c.title;
      title.title = c.title;
      title.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startConvRename(item, c);
      });
      const edit = document.createElement('button');
      edit.className = 'om-conv-edit';
      edit.title = '重命名对话';
      edit.appendChild(svgIcon('edit', 12));
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        startConvRename(item, c);
      });
      const del = document.createElement('button');
      del.className = 'om-conv-del';
      del.title = '删除对话';
      del.appendChild(svgIcon('close', 12));
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeConversation(c.id);
      });
      item.append(title, edit, del);
      item.addEventListener('click', () => {
        if (streaming) return;
        currentId = c.id;
        renderConvList();
        renderMessages();
        syncEngineUi();
        closeDrawer();
      });
      R.convList.appendChild(item);
    }
    // 聊天卡模式：当前会话变化即上报宿主页，widget 存 sessionStorage，重开卡时按标签页恢复
    if (window.parent !== window && currentId) {
      try { parent.postMessage({ type: 'om:card-conv', convId: currentId }, '*'); } catch { /* 宿主页不可达时忽略 */ }
    }
  }

  async function removeConversation(id) {
    if (streaming) return;
    if (!confirm('删除该对话？')) return;
    await deleteConversation(id);
    // 同步删掉 baseDir/<会话 id> 工作区（bridge 不在也不阻塞删除；幂等，失败静默）
    loadSettings()
      .then((settings) => agentClient.removeWorkspace({
        cwdBase: settings.agentBridge.baseDir || '',
        workspaceId: id,
      }))
      .catch(() => {});
    conversations = await loadConversations();
    if (currentId === id) currentId = '';
    if (!conversations.length) {
      const conv = newConv('新对话');
      conversations.push(conv);
      currentId = conv.id;
      await saveConversations(conversations);
    }
    if (!currentId) currentId = conversations[0].id;
    renderConvList();
    renderMessages();
    syncEngineUi();
  }

  // ---- 模型选择器 ----
  async function renderModelOptions() {
    const settings = await loadSettings();
    providersEmpty = !settings.providers.length;
    permDefault = settings.agentBridge.permissionMode || 'default';
    modelDefault = settings.agentBridge.model || '';
    R.model.innerHTML = '';
    for (const p of settings.providers) {
      for (const m of p.models) {
        const opt = document.createElement('option');
        opt.value = JSON.stringify([p.id, m]);
        opt.textContent = `${p.name} / ${m}`;
        R.model.appendChild(opt);
      }
    }
    const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
    const activeVal = provider?.models[0] ? JSON.stringify([provider.id, provider.models[0]]) : '';
    if (activeVal && R.model.querySelector(`option[value='${CSS.escape(activeVal)}']`)) {
      R.model.value = activeVal;
    }
    if (!settings.providers.length) {
      const opt = document.createElement('option');
      opt.textContent = '未配置供应商';
      opt.disabled = true;
      opt.selected = true;
      R.model.appendChild(opt);
    }
  }

  function selectedModel() {
    try {
      const [, model] = JSON.parse(R.model.value);
      return model;
    } catch {
      return '';
    }
  }

  // ---- 消息渲染 ----
  function chipEl(meta) {
    const chip = document.createElement('div');
    chip.className = 'om-chip';
    chip.appendChild(svgIcon(meta.kind === 'page-summary' ? 'doc' : 'globe', 13));
    const a = document.createElement('a');
    a.href = meta.url || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = meta.title || meta.url || '来源网页';
    a.title = `${meta.title || ''} ${meta.url || ''}`.trim();
    chip.appendChild(a);
    return chip;
  }

  // 历史消息附件 chips（发送成功后 meta.attachments 回显）；title 放绝对路径
  function attachmentChipsEl(attachments) {
    const row = document.createElement('div');
    row.className = 'om-attach-row';
    for (const a of attachments) {
      const chip = document.createElement('div');
      chip.className = 'om-attach-chip';
      chip.appendChild(svgIcon('file', 12));
      const name = document.createElement('span');
      name.className = 'om-chip-name';
      name.textContent = a.name;
      chip.appendChild(name);
      chip.title = a.path || a.relPath || a.name;
      row.appendChild(chip);
    }
    return row;
  }

  // agent 过程渲染：思考（可折叠）+ 工具步骤行。live 与离线回放共用。
  function agentThoughtEl(thought, open = false) {
    if (!thought) return null;
    const det = document.createElement('details');
    det.className = 'om-agent-thought';
    if (open) det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = '思考过程';
    const body = document.createElement('div');
    body.className = 'om-agent-thought-body';
    body.textContent = thought;
    det.append(sum, body);
    return det;
  }

  // 工具名：title 前缀（适配器格式「ToolName: 摘要」）
  function toolKey(title) {
    return String(title || '').split(':')[0].trim() || '工具';
  }

  const TOOL_ICONS = [
    [/^(read|notebookread)$/i, 'file'],
    [/^(edit|write|multiedit|notebookedit)$/i, 'edit'],
    [/^(bash|bashoutput|powershell)$/i, 'bash'],
    [/^(grep|glob)$/i, 'search'],
    [/^(websearch|webfetch|fetch)$/i, 'globe'],
    [/^(task|agent)$/i, 'bot'],
    [/^(todo|todowrite|todoread|plan)$/i, 'doc'],
  ];

  // 聚合行的中文工具名（对齐 Orca 的「搜索 6 次」「读取 7 文件」）；未命中用原始名
  const TOOL_LABELS = {
    read: '读取', notebookread: '读取',
    edit: '编辑', write: '写入', multiedit: '编辑', notebookedit: '编辑',
    bash: '执行', bashoutput: '执行', powershell: '执行',
    grep: '搜索', glob: '查找', websearch: '联网搜索', webfetch: '网页读取', fetch: '网页读取',
    task: '子任务', agent: '子任务',
    todo: '任务清单', todowrite: '任务清单', todoread: '任务清单', plan: '计划',
  };

  function toolIconEl(title) {
    const key = toolKey(title);
    const hit = TOOL_ICONS.find(([re]) => re.test(key));
    return svgIcon(hit ? hit[1] : 'wrench', 13);
  }

  // 行尾状态标记：完成 ✓ / 失败 ✕ / 运行中 spinner / 取消 –（对齐 Orca 的极简状态）
  function statusMarkEl(status) {
    const m = document.createElement('span');
    m.className = 'om-agent-step-mark';
    if (status === 'failed') { m.textContent = '✕'; m.classList.add('is-failed'); }
    else if (status === 'in_progress') m.classList.add('om-spin');
    else if (status === 'cancelled') m.textContent = '–';
    else m.textContent = '✓';
    return m;
  }

  // 步骤列表：parentId 非空的步骤是子智能体内部的工具调用，折叠到对应的 Task 步骤下；
  // 顶部汇总行显示子智能体数量；连续同名已完成步骤聚合为一行「工具 · N 次」（对齐 Orca）
  function agentStepsEl(steps) {
    if (!steps.length) return null;
    const ids = new Set(steps.map((s) => s.id));
    const groups = new Map(); // 父 id -> 子步骤数组
    for (const s of steps) {
      if (s.parentId && ids.has(s.parentId)) {
        if (!groups.has(s.parentId)) groups.set(s.parentId, []);
        groups.get(s.parentId).push(s);
      }
    }
    const list = document.createElement('div');
    list.className = 'om-agent-steps';
    if (groups.size) {
      const head = document.createElement('div');
      head.className = 'om-agent-subagents';
      head.textContent = `运行了 ${groups.size} 个子智能体`;
      list.appendChild(head);
    }
    // 顶层步骤按顺序聚合：连续 completed 且同名工具并入同一 run；其余各自成 run
    const runs = [];
    for (const s of steps) {
      if (s.parentId && ids.has(s.parentId)) continue; // 子智能体内部步骤：归组渲染
      if (groups.has(s.id)) { runs.push({ group: s }); continue; } // Task 父步骤：整组折叠
      const key = toolKey(s.title);
      const last = runs.at(-1);
      if (s.status === 'completed' && last && !last.group && last.key === key) last.items.push(s);
      else runs.push({ key, items: [s] });
    }
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r.group) { list.appendChild(agentGroupEl(r.group, groups.get(r.group.id))); continue; }
      const allDone = r.items.every((s) => s.status === 'completed');
      // 与前一个 run 同名且都已完成 → 并入（子智能体组或未完成步骤会打断聚合）
      const prev = runs[i - 1];
      if (allDone && prev && !prev.group && prev.key === r.key && prev.merged !== false) {
        prev.items.push(...r.items);
        runs.splice(i, 1);
        i--;
        continue;
      }
      r.merged = allDone;
      list.appendChild(r.items.length > 1 ? agentBurstEl(r) : agentStepEl(r.items[0]));
    }
    return list;
  }

  // 聚合行：「Bash · 3 次」可展开看每步明细（明细行各自可再展开输入/结果）
  function agentBurstEl(run) {
    const det = document.createElement('details');
    det.className = 'om-agent-step om-agent-step-burst';
    const head = document.createElement('summary');
    head.appendChild(toolIconEl(run.items[0].title));
    const label = document.createElement('span');
    label.className = 'om-agent-step-title';
    const zh = TOOL_LABELS[run.key.toLowerCase()] || run.key;
    label.textContent = `${zh} ${run.items.length} 次`;
    head.appendChild(label);
    const total = run.items.reduce((a, s) => a + (s.durationMs || 0), 0);
    if (total > 0) head.appendChild(durBadgeEl(total));
    head.appendChild(statusMarkEl('completed'));
    const body = document.createElement('div');
    body.className = 'om-agent-step-children';
    for (const s of run.items) body.appendChild(agentStepEl(s));
    det.append(head, body);
    return det;
  }

  // 子智能体组：Task 调用行做 summary，内部步骤折叠（可再嵌套）
  function agentGroupEl(parent, children) {
    const det = document.createElement('details');
    det.className = 'om-agent-step om-agent-step-group';
    const head = document.createElement('summary');
    head.appendChild(toolIconEl(parent.title));
    const label = document.createElement('span');
    label.className = 'om-agent-step-title';
    label.textContent = parent.title;
    label.title = parent.title;
    const count = document.createElement('span');
    count.className = 'om-agent-step-count';
    count.textContent = `${children.length} 步`;
    head.append(label, count);
    if (parent.durationMs != null) head.appendChild(durBadgeEl(parent.durationMs));
    head.appendChild(statusMarkEl(parent.status));
    const body = document.createElement('div');
    body.className = 'om-agent-step-children';
    if (parent.detail || parent.result) body.appendChild(agentStepEl(parent));
    const ids = new Set(children.map((c) => c.id));
    const nested = new Map();
    for (const c of children) {
      if (c.parentId && ids.has(c.parentId)) {
        if (!nested.has(c.parentId)) nested.set(c.parentId, []);
        nested.get(c.parentId).push(c);
      }
    }
    for (const c of children) {
      if (nested.has(c.id)) body.appendChild(agentGroupEl(c, nested.get(c.id)));
      else if (!(c.parentId && ids.has(c.parentId))) body.appendChild(agentStepEl(c));
    }
    det.append(head, body);
    return det;
  }

  function durBadgeEl(ms) {
    const b = document.createElement('span');
    b.className = 'om-agent-step-dur';
    b.textContent = formatDur(ms);
    return b;
  }

  // 步骤行：无详情时单行；有输入/结果时包 <details> 可展开（textContent 赋值，防注入）
  function agentStepEl(step) {
    const hasDetail = !!(step.detail || step.result);
    const row = document.createElement(hasDetail ? 'details' : 'div');
    row.className = `om-agent-step is-${step.status || 'pending'}`;
    const head = hasDetail ? document.createElement('summary') : row;
    head.appendChild(toolIconEl(step.title));
    const label = document.createElement('span');
    label.className = 'om-agent-step-title';
    label.textContent = step.title;
    label.title = step.title;
    head.appendChild(label);
    if (step.durationMs != null) head.appendChild(durBadgeEl(step.durationMs));
    head.appendChild(statusMarkEl(step.status));
    if (hasDetail) {
      row.appendChild(head);
      const body = document.createElement('div');
      body.className = 'om-agent-step-body';
      if (step.detail) {
        const input = document.createElement('pre');
        input.className = 'om-agent-step-input';
        input.textContent = step.detail;
        body.appendChild(input);
      }
      if (step.result) {
        const res = document.createElement('div');
        res.className = 'om-agent-step-result';
        const cap = document.createElement('div');
        cap.className = 'om-agent-step-cap';
        cap.textContent = '工具结果';
        const pre = document.createElement('pre');
        pre.textContent = step.result;
        res.append(cap, pre);
        body.appendChild(res);
      }
      row.appendChild(body);
    }
    return row;
  }

  function messageEl(item) {
    const wrap = document.createElement('div');
    wrap.className = `om-msg om-msg-${item.type}`;
    wrap.dataset.itemId = item.id;
    if (item.type === 'question') {
      if (item.meta?.kind) wrap.appendChild(chipEl(item.meta));
      if (item.meta?.attachments?.length) wrap.appendChild(attachmentChipsEl(item.meta.attachments));
      const body = document.createElement('div');
      body.className = 'om-body';
      body.textContent = item.content;
      wrap.appendChild(body);
      return wrap;
    }
    // answer
    const meta = document.createElement('div');
    meta.className = 'om-meta';
    meta.textContent = item.model || '助手';
    const agentMeta = item.meta?.agent;
    if (agentMeta) {
      // 轮级统计：总耗时（result.duration_ms）与费用（total_cost_usd）
      const stats = [];
      const dur = formatDur(agentMeta.durationMs);
      if (dur) stats.push(`已工作 ${dur}`);
      if (typeof agentMeta.costUSD === 'number' && agentMeta.costUSD > 0) {
        stats.push(`$${agentMeta.costUSD < 0.01 ? agentMeta.costUSD.toFixed(4) : agentMeta.costUSD.toFixed(2)}`);
      }
      if (stats.length) {
        const tag = document.createElement('span');
        tag.className = 'om-meta-stats';
        tag.textContent = stats.join(' · ');
        meta.appendChild(document.createTextNode(' · '));
        meta.appendChild(tag);
      }
    }
    wrap.appendChild(meta);
    if (item.meta?.agent) {
      const st = stateFromMeta(item.meta.agent);
      const thought = agentThoughtEl(st.thought);
      const steps = agentStepsEl([...st.steps.values()]);
      if (thought) wrap.appendChild(thought);
      if (steps) wrap.appendChild(steps);
    }
    const body = document.createElement('div');
    body.className = 'om-body markdown';
    body.innerHTML = renderMarkdown(item.content);
    wrap.appendChild(body);
    if (item.error) {
      const err = document.createElement('div');
      err.className = 'om-error';
      err.textContent = `出错：${item.error}`;
      wrap.appendChild(err);
    } else if (item.stopped) {
      const tag = document.createElement('div');
      tag.className = 'om-stopped';
      tag.textContent = '已停止';
      wrap.appendChild(tag);
    }
    // 尾部动作行（对齐 Orca）：复制整条回答的 Markdown 原文；回到本轮提问的位置。
    // 流式期间由 CSS 隐藏（.om-streaming），轮结束 renderMessages 重建后出现
    wrap.appendChild(answerActionsEl(item));
    return wrap;
  }

  // 剪贴板兜底：聊天卡是嵌在宿主页里的扩展源 iframe，宿主页的
  // Permissions-Policy 会挡 Clipboard API（报 permissions policy has blocked），
  // 此时退回 execCommand；独立聊天页/原生侧边栏不受影响
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 走兜底 */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  function answerActionsEl(item) {
    const actions = document.createElement('div');
    actions.className = 'om-msg-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'om-msg-act';
    copyBtn.title = '复制 Markdown';
    copyBtn.setAttribute('aria-label', '复制 Markdown');
    copyBtn.appendChild(svgIcon('copy', 13));
    copyBtn.addEventListener('click', async () => {
      if (await copyText(item.content || '')) showToast(R.toast, '已复制 Markdown');
      else showToast(R.toast, '复制失败：页面限制了剪贴板', 'error');
    });
    const upBtn = document.createElement('button');
    upBtn.className = 'om-msg-act';
    upBtn.title = '回到该问题';
    upBtn.setAttribute('aria-label', '回到该问题');
    upBtn.appendChild(svgIcon('arrowUp', 13));
    upBtn.addEventListener('click', () => {
      const q = item.parentItemId && R.column.querySelector(`[data-item-id='${item.parentItemId}']`);
      if (!q) return;
      // 语义同用户上滚翻历史：暂停贴底跟随、浮出「最新」按钮
      scrollPinned = false;
      R.jump.hidden = false;
      q.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    actions.append(copyBtn, upBtn);
    return actions;
  }

  // 无供应商时的引导卡：只在 LLM 引擎下提示，agent 引擎不需要供应商
  function emptyCardEl() {
    const card = document.createElement('div');
    card.className = 'om-empty-card';
    const title = document.createElement('div');
    title.className = 'om-empty-title';
    title.textContent = 'LLM 引擎需要先配置供应商';
    const desc = document.createElement('div');
    desc.className = 'om-empty-desc';
    desc.textContent = '两条路任选：打开设置，填入任意 OpenAI 或 Anthropic 兼容的 Base URL 和 API Key；或者把顶栏引擎切到 Agent，用本机 Claude Code 等登录态聊天，无需任何 Key。网页总结与翻译仍走 LLM 供应商。';
    const btn = document.createElement('button');
    btn.id = 'om-empty-settings';
    btn.className = 'om-empty-btn';
    btn.textContent = '打开设置';
    btn.addEventListener('click', openSettings);
    card.append(title, desc, btn);
    return card;
  }

  function renderMessages() {
    const conv = conversations.find((c) => c.id === currentId);
    R.column.innerHTML = '';
    if (providersEmpty && currentEngine() === 'llm') R.column.appendChild(emptyCardEl());
    renderCtxRow();
    if (!conv) return;
    for (const item of conv.items) R.column.appendChild(messageEl(item));
    R.messages.scrollTop = R.messages.scrollHeight;
    scrollPinned = true;
    R.jump.hidden = true;
  }

  // 滚动跟随：贴底时流式自动滚，用户上滚翻历史即停（浮出「最新」按钮，点按回底恢复）
  let scrollPinned = true;
  R.messages.addEventListener('scroll', () => {
    const m = R.messages;
    const atBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 40;
    if (atBottom !== scrollPinned) {
      scrollPinned = atBottom;
      R.jump.hidden = atBottom;
    }
  }, { passive: true });
  R.jump.addEventListener('click', () => {
    scrollPinned = true;
    R.jump.hidden = true;
    R.messages.scrollTo({ top: R.messages.scrollHeight, behavior: 'smooth' });
  });

  function setStreamingUi(on) {
    // agent 轮发送按钮保持「发送」：消息进队列轮转发出；停止走独立的 #om-stop。
    // LLM 轮维持「发送 ⇄ 停止」一体按钮
    const agent = on && streaming?.kind === 'agent';
    R.send.classList.toggle('om-streaming', !!on && !agent);
    R.send.querySelector('.om-send-text').textContent = on && !agent ? '停止' : '发送';
    R.stop.hidden = !agent;
  }

  function setBusyUi() {
    const busy = !!streaming || translating;
    R.regenBtn.disabled = busy;
    R.delBtn.disabled = busy;
    R.exportBtn.disabled = busy || exporting || !hasExportableItems();
  }

  // 导出需要会话里已有内容；空会话按钮置灰
  function hasExportableItems() {
    return !!(conversations.find((c) => c.id === currentId)?.items?.length);
  }

  // ---- 流式控制 ----
  // 存储写入串行化 + 节流：增量期间 500ms 一写（内存 localContent 是权威值），
  // 结束/停止/出错强制落盘。并发 updateConversation 会互相覆盖丢字，必须排队。
  async function runAssistantTurn(conv, userItem, model) {
    const history = conv.items
      .filter((i) => i.type === 'question' || (i.content && !i.error))
      .map((i) => ({ role: i.type === 'question' ? 'user' : 'assistant', content: i.content }));
    // 网页上下文：LLM 引擎无状态，每轮请求都注入 system 消息（chip 上可移除）
    if (conv.pageCtx) history.unshift({ role: 'system', content: pageCtxPrompt(conv.pageCtx) });

    const answer = newAssistantItem(conv.id, userItem.id, model);
    conv.items.push(answer);
    await saveConversations(conversations);
    renderMessages();
    setBusyUi();

    let localContent = '';
    let localError = '';
    let lastPersist = 0;
    let writeChain = Promise.resolve();
    const persist = () => {
      writeChain = writeChain.then(() =>
        updateConversation(conv.id, (c) => {
          const it = c.items.find((i) => i.id === answer.id);
          if (!it) return;
          it.content = localContent;
          it.error = localError;
        }),
      );
      return writeChain;
    };
    const persistThrottled = () => {
      const now = Date.now();
      if (now - lastPersist >= PERSIST_THROTTLE_MS) {
        lastPersist = now;
        persist();
      }
    };
    const persistNow = async (patchStopped = false) => {
      if (patchStopped) {
        writeChain = writeChain.then(() =>
          updateConversation(conv.id, (c) => {
            const it = c.items.find((i) => i.id === answer.id);
            if (it) it.stopped = true;
          }),
        );
      }
      lastPersist = 0;
      await persist();
    };

    const bodyEl = () => R.column.querySelector(`[data-item-id='${answer.id}'] .om-body`);
    let raf = 0;
    const flush = () => {
      raf = 0;
      const el = bodyEl();
      if (el) {
        el.innerHTML = renderMarkdown(localContent);
        if (scrollPinned) R.messages.scrollTop = R.messages.scrollHeight;
      }
    };
    const scheduleFlush = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const abort = new AbortController();
    streaming = {
      abort,
      flushNow: flush,
      persistStopped: async () => {
        abort.abort();
        await persistNow(true);
      },
    };
    const answerWrap = R.column.querySelector(`[data-item-id='${answer.id}']`);
    answerWrap?.classList.add('om-streaming');

    let finished = false;
    try {
      await streamChat({
        messages: history,
        model,
        signal: abort.signal,
        onDelta: (d) => {
          if (d.error) {
            localError = d.error.message || JSON.stringify(d.error);
            persistNow();
          } else if (d.text) {
            localContent += d.text;
            persistThrottled();
            scheduleFlush();
          }
          if (d.finished && !finished) finished = true;
        },
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        localError = err.message || String(err);
        await persistNow();
      }
    }
    if (!finished) finished = true; // abort / adapter 提前返回
    await persistNow();
    if (raf) cancelAnimationFrame(raf);
    answerWrap?.classList.remove('om-streaming');
    flush();
    streaming = null;
    setStreamingUi(false);
    setBusyUi();
    conversations = await loadConversations();
    renderConvList();
    renderMessages();
  }

  // ---- agent turn：bridge 会话 + 事件流渲染 + 审批卡 ----
  // 与 runAssistantTurn 同一套持久化纪律：内存权威、写入串行化、500ms 节流、结束强制落盘。
  let agentRaf = 0;
  // 增量渲染：changed 标志在节流窗口内被消费却不渲染时并入 pending，防止丢帧
  const agentPending = { content: false, thought: false, steps: false, meta: false };
  let agentBodyTimer = 0; // 正文节流兜底：模型思考间隙没有新事件也要补渲染
  let agentBodyAt = 0; // 上次正文 Markdown 重渲染时间

  function scheduleAgentFlush() {
    if (!agentRaf) agentRaf = requestAnimationFrame(flushAgentTurn);
  }

  function scheduleBodyCatchup() {
    if (agentBodyTimer) return;
    agentBodyTimer = setTimeout(() => {
      agentBodyTimer = 0;
      agentPending.content = true;
      scheduleAgentFlush();
    }, BODY_RENDER_MS);
  }

  function flushAgentTurn() {
    agentRaf = 0;
    if (!agentTurn) return;
    const { state, liveEl, answer } = agentTurn;
    const wrap = R.column.querySelector(`[data-item-id='${answer.id}']`);
    if (!wrap) return;
    const c = state.changed;
    if (c.content) agentPending.content = true;
    if (c.thought) agentPending.thought = true;
    if (c.steps) agentPending.steps = true;
    if (c.meta) agentPending.meta = true;
    markRendered(state);
    let touched = false;
    // 思考/步骤/审批卡按各自事件到达重建——文本增量帧完全不碰这三块。
    // 步骤整块重建仍是 O(n)，但每轮只发生 ~步骤数次，不再逐 token 触发
    if (agentPending.thought || agentPending.steps || agentPending.meta) {
      liveEl.querySelector('.om-agent-live-top')?.remove();
      const top = document.createElement('div');
      top.className = 'om-agent-live-top';
      const thought = agentThoughtEl(state.thought, true);
      const steps = agentStepsEl([...state.steps.values()]);
      if (thought) top.appendChild(thought);
      if (steps) top.appendChild(steps);
      if (state.permission) top.appendChild(permissionEl(state.permission));
      // 计时头常驻最顶：过程块插在它后面（轮结束 renderMessages 全量重建时一并消失）
      const anchor = liveEl.querySelector('.om-agent-running');
      if (anchor) anchor.after(top); else liveEl.prepend(top);
      agentPending.thought = false;
      agentPending.steps = false;
      agentPending.meta = false;
      touched = true;
    }
    // 正文全量重解析按 250ms 节流；轮结束强制渲染一次
    if (agentPending.content) {
      const now = Date.now();
      if (state.stopReason || now - agentBodyAt >= BODY_RENDER_MS) {
        const bodyEl = wrap.querySelector('.om-body');
        if (bodyEl) bodyEl.innerHTML = renderMarkdown(state.content);
        agentBodyAt = now;
        agentPending.content = false;
        touched = true;
      } else {
        scheduleBodyCatchup();
      }
    }
    if (touched && scrollPinned) R.messages.scrollTop = R.messages.scrollHeight;
  }

  function permissionEl(perm) {
    const card = document.createElement('div');
    card.className = 'om-perm';
    const title = document.createElement('div');
    title.className = 'om-perm-title';
    title.textContent = `请求执行：${perm.title}`;
    const parts = [title];
    if (perm.detail) {
      const detail = document.createElement('div');
      detail.className = 'om-perm-detail';
      detail.textContent = perm.detail;
      parts.push(detail);
    }
    const actions = document.createElement('div');
    actions.className = 'om-perm-actions';
    const allow = document.createElement('button');
    allow.className = 'om-perm-allow';
    allow.textContent = '允许';
    const deny = document.createElement('button');
    deny.className = 'om-perm-deny';
    deny.textContent = '拒绝';
    const respond = (outcome) => {
      applyEvent(agentTurn.state, { kind: 'permission_settled', requestId: perm.requestId });
      agentClient.respondPermission(agentTurn.sessionId, perm.requestId, outcome).catch((e) => {
        showToast(R.toast, `审批发送失败：${e.message}`, 'error');
      });
      card.remove();
    };
    allow.addEventListener('click', () => respond('allow'));
    deny.addEventListener('click', () => respond('deny'));
    actions.append(allow, deny);
    parts.push(actions);
    card.append(...parts);
    return card;
  }

  async function runAgentTurn(conv, userItem, agentId) {
    if (!agentId) {
      showToast(R.toast, '没有可用的 agent：请启动 bridge 并在设置页完成登录', 'error');
      return;
    }
    const label = agentsCache.find((a) => a.id === agentId)?.name || AGENT_NAMES[agentId] || agentId;
    const answer = newAssistantItem(conv.id, userItem.id, `agent · ${label}`);
    conv.items.push(answer);
    await saveConversations(conversations);
    renderMessages();
    setBusyUi();

    let localError = '';
    let lastPersist = 0;
    let writeChain = Promise.resolve();
    const persist = () => {
      writeChain = writeChain.then(() =>
        updateConversation(conv.id, (c) => {
          const it = c.items.find((i) => i.id === answer.id);
          if (!it) return;
          it.content = agentTurn?.state.content ?? it.content;
          it.error = localError;
          const meta = agentTurn ? turnStateToMeta(agentTurn.state, agentId) : it.meta?.agent;
          if (meta) it.meta = { ...(it.meta ?? {}), agent: meta };
        }),
      );
      return writeChain;
    };
    const persistThrottled = () => {
      const now = Date.now();
      if (now - lastPersist >= PERSIST_THROTTLE_MS) {
        lastPersist = now;
        persist();
      }
    };

    streaming = { kind: 'agent' };
    setStreamingUi(true);
    const answerWrap = R.column.querySelector(`[data-item-id='${answer.id}']`);
    answerWrap?.classList.add('om-streaming');
    const liveEl = document.createElement('div');
    liveEl.className = 'om-agent-live';
    const bodyEl = answerWrap?.querySelector('.om-body');
    bodyEl?.before(liveEl);
    // 运行计时头（对齐 Orca 的「已工作 2m 34s」）：每秒独立走字，不参与事件驱动重建
    const running = document.createElement('div');
    running.className = 'om-agent-running';
    const runTime = document.createElement('span');
    runTime.className = 'om-agent-running-time';
    runTime.textContent = '已工作 0s';
    running.append(runTime);
    liveEl.appendChild(running);
    const turnT0 = Date.now();
    const runTimer = setInterval(() => {
      runTime.textContent = `已工作 ${formatDur(Date.now() - turnT0)}`;
    }, 1000);

    try {
      await agentClient.ensureReady();
      // 工作区 = baseDir/<会话 id>（bridge 侧解析并创建，上传/知识库都落这里）；
      // 绑定 projectDir 时它覆盖 cwd，工作区自动加入 additionalDirectories；
      // 知识库本地目录走 additionalDirectories；权限模式会话级覆盖设置页默认
      const settings = await loadSettings();
      const bridgeParams = {
        cwdBase: settings.agentBridge.baseDir || '',
        workspaceId: conv.id,
        contextDirs: knowledgeLocalDirs(conv),
        permissionMode: conv.permissionMode || settings.agentBridge.permissionMode || 'default',
        projectDir: conv.projectDir || '',
        model: conv.model || settings.agentBridge.model || '',
      };
      // conv.agentSessionId 存 SDK 会话 id（session_info 事件给的）；旧版本存过 bridge
      // 会话 id（s: 前缀），那种不能拿去 resume，直接开新会话
      const canResume = conv.agentId === agentId
        && conv.agentSessionId && !conv.agentSessionId.startsWith('s:');
      let sessionId = '';
      let workspacePath = '';
      if (canResume) {
        // bridge 重启后 resume 会返回新的 bridge 会话 id，必须接住再 prompt
        ({ sessionId, workspacePath } = await agentClient.resumeSession({
          agentId, agentSessionId: conv.agentSessionId, ...bridgeParams,
        }));
      } else {
        ({ sessionId, workspacePath } = await agentClient.newSession({ agentId, ...bridgeParams }));
      }
      conv.agentId = agentId;
      agentPending.content = agentPending.thought = agentPending.steps = agentPending.meta = false;
      agentBodyAt = 0;
      agentTurn = {
        sessionId,
        state: createTurnState(),
        answer,
        conv,
        lastSeq: 0,
        liveEl,
        done: null,
      };
      agentTurn.donePromise = new Promise((resolve) => { agentTurn.done = resolve; });
      // 断线/重启兜底：置 localError 后 resolve donePromise，走正常收尾链落盘
      agentTurn.interrupt = (message) => {
        if (agentTurn.settled) return;
        localError = message;
        agentTurn.done();
      };
      await agentClient.prompt(sessionId, buildAgentPrompt(conv, userItem, { workspacePath }));
      await agentTurn.donePromise;
      agentTurn.settled = true; // 收尾中：迟到的 interrupt 不再覆盖结论
      // 网页上下文已并入本条 prompt（compose 检测 pageCtxSent）：agent 会话有记忆，只注入一次
      if (conv.pageCtx && !conv.pageCtxSent) {
        writeChain = writeChain.then(() => updateConversation(conv.id, (c) => { c.pageCtxSent = true; }));
      }
    } catch (err) {
      localError = err.message || String(err);
      // 轮没跑起来（bridge 不在线 / 建会话失败）：除消息条错误外，主动 toast 一次
      showToast(R.toast, `本轮发送失败：${localError}`, 'error');
    }
    await persist();
    if (agentRaf) cancelAnimationFrame(agentRaf);
    agentRaf = 0;
    clearTimeout(agentBodyTimer);
    agentBodyTimer = 0;
    clearInterval(runTimer);
    answerWrap?.classList.remove('om-streaming');
    liveEl.querySelector('.om-perm')?.remove();
    const stopped = agentTurn?.state.stopReason === 'cancelled';
    if (stopped) {
      writeChain = writeChain.then(() =>
        updateConversation(conv.id, (c) => {
          const it = c.items.find((i) => i.id === answer.id);
          if (it) it.stopped = true;
        }),
      );
    }
    // SDK 会话 id 写回会话记录，下一轮才能 resume（agentTurn 置空前取值）
    writeChain = writeChain.then(() =>
      updateConversation(conv.id, (c) => {
        c.agentId = agentId;
        if (agentTurn?.state.agentSessionId) c.agentSessionId = agentTurn.state.agentSessionId;
      }),
    );
    await writeChain;
    bodyEl.innerHTML = renderMarkdown(agentTurn?.state.content || '');
    clearTimeout(turnLossTimer);
    agentTurn = null;
    streaming = null;
    setStreamingUi(false);
    setBusyUi();
    conversations = await loadConversations();
    renderConvList();
    renderMessages();
    drainAgentQueue(agentId);
  }

  // 发队列里的排队消息。loadConversations 刚替换过 conversations 对象，必须重查引用。
  // 用户在轮间切走会话即停止排空（消息已落盘，回原会话可见）
  async function drainAgentQueue(agentId) {
    while (agentQueue.length && currentId === agentQueue[0].convId) {
      const q = agentQueue.shift();
      const conv = conversations.find((c) => c.id === q.convId);
      const item = conv?.items.find((i) => i.id === q.userItem.id);
      if (!conv || !item) continue;
      await runAgentTurn(conv, item, agentId || selectedAgent());
    }
  }

  // 组装一条用户消息并跑回复。meta：{kind,url,title} 附着在消息上渲染来源 chip。
  async function sendPrepared(text, meta = undefined, title = '') {
    let conv = conversations.find((c) => c.id === currentId);
    if (!conv) {
      conv = newConv(title || makeTitle(text));
      conversations.unshift(conv);
      currentId = conv.id;
    }
    if (conv.items.length === 0) conv.title = title || makeTitle(text);
    if (attachPageCtx(conv)) renderCtxRow();
    const userItem = newUserItem(conv.id, text, conv.items.at(-1)?.id ?? '');
    if (meta) userItem.meta = meta;
    conv.items.push(userItem);
    await saveConversations(conversations);
    renderConvList();
    renderMessages();
    syncEngineUi();
    // agent 轮进行中：入队，本轮结束后自动发出（userItem 已落盘，关页不丢）
    if (streaming?.kind === 'agent') {
      agentQueue.push({ convId: conv.id, userItem });
      showToast(R.toast, `已排队（第 ${agentQueue.length} 条），本轮结束后自动发送`);
      return;
    }
    if (currentEngine() === 'agent') await runAgentTurn(conv, userItem, selectedAgent());
    else await runAssistantTurn(conv, userItem, selectedModel());
  }

  // ---- 模型守卫：未配置/未选择供应商必须给出可见提示，不能静默返回 ----
  function ensureModel() {
    if (selectedModel()) return true;
    showToast(R.toast, '请先在设置页配置供应商并保存', 'error');
    return false;
  }

  // 翻译编排可能嵌在页内聊天卡 iframe 中：未开始 / 失败时通知宿主页浮窗复位按钮并提示
  function notifyTxFailed(message) {
    try { if (window.parent !== window) parent.postMessage({ type: 'om:tx-failed', message }, '*'); } catch { /* 跨源受限时忽略 */ }
  }

  // 引擎守卫：LLM 看模型选择，agent 看 bridge 里有没有已登录的 agent
  function ensureEngine() {
    if (currentEngine() === 'llm') return ensureModel();
    if (selectedAgent()) return true;
    showToast(R.toast, '没有可用的 agent：先运行 bridge（node bridge/index.js）并确认 agent 已登录', 'error');
    return false;
  }

  // 自动发送链路（面板追问 / 快捷动作）专用守卫：聊天卡 iframe 可能刚加载，
  // refreshAgents 的 bridge 连接 + listAgents 还没跑完，agentSelect 尚空——
  // 同步 ensureEngine 会把竞态误报成「没有可用的 agent」。先等 agent 就绪再判
  async function ensureEngineAsync(waitMs = 8000) {
    if (currentEngine() === 'agent') {
      const deadline = Date.now() + waitMs;
      while (!selectedAgent() && Date.now() < deadline) {
        await refreshAgents(true);
        if (selectedAgent()) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return ensureEngine();
  }

  async function send() {
    if (streaming && streaming.kind !== 'agent') {
      const s = streaming;
      streaming = null;
      setStreamingUi(false);
      await s.persistStopped();
      conversations = await loadConversations();
      renderConvList();
      renderMessages();
      return;
    }
    const text = R.input.value.trim();
    const pending = [...pendingAttachments];
    if (!text && !pending.length) return;
    if (!ensureEngine()) return;
    if (pending.length && currentEngine() !== 'agent') {
      showToast(R.toast, 'LLM 引擎会话不支持附件，请新建 Agent 引擎对话再发', 'error');
      return;
    }
    if (!pending.length) {
      R.input.value = '';
      autoGrow();
      await sendPrepared(text);
      return;
    }
    // 带附件：先确保会话存在（工作区 id = 会话 id，先建会话再上传）→ 逐个上传 → 成功后才清输入
    R.send.disabled = true;
    try {
      let conv = conversations.find((c) => c.id === currentId);
      if (!conv) {
        conv = newConv(pending.length === 1 ? pending[0].name : '附件消息');
        conversations.unshift(conv);
        currentId = conv.id;
        await saveConversations(conversations);
        renderConvList();
      }
      const settings = await loadSettings();
      const cwdBase = settings.agentBridge.baseDir || '';
      const attachments = [];
      for (const p of pending) {
        showToast(R.toast, `上传 ${p.name}…`, 'info', true);
        const r = await agentClient.uploadFile({
          cwdBase,
          workspaceId: conv.id,
          relPath: 'uploads/' + sanitizeName(p.name),
          file: p.file,
          onProgress: (done, total) => {
            showToast(R.toast, `上传 ${p.name} ${Math.round((done / total) * 100)}%`, 'info', true);
          },
        });
        attachments.push({ name: p.name, path: r.path, relPath: 'uploads/' + r.name });
      }
      pendingAttachments = [];
      renderAttachRow();
      R.input.value = '';
      autoGrow();
      await sendPrepared(
        text,
        { attachments },
        text ? '' : (pending.length === 1 ? pending[0].name : `附件消息（${pending.length} 个文件）`),
      );
    } catch (e) {
      // 上传失败：文本与 chips 原地保留，可重试（bridge 侧重名自动加后缀，不会覆盖）
      showToast(R.toast, `附件上传失败：${e.message}`, 'error');
    } finally {
      R.send.disabled = false;
    }
  }

  // 停止按钮：仅 agent 轮（LLM 轮的停止仍是发送按钮切换）。发送按钮在 agent 轮走正常发送 → 入队
  R.stop.addEventListener('click', () => {
    if (!agentTurn) return;
    // 正常路径：bridge 送达取消，turn_end(cancelled) 事件驱动收尾；
    // bridge 不在线时 cancel 发不出去，turn_end 不会来——本地按「已停止」收尾
    agentClient.cancel(agentTurn.sessionId).catch(() => {
      if (agentTurn?.interrupt) {
        agentTurn.state.stopReason = 'cancelled';
        agentTurn.interrupt(''); // 空错误 + stopReason=cancelled → 按已停止收尾
      }
    });
  });

  async function regenerate() {
    if (streaming) return;
    const conv = conversations.find((c) => c.id === currentId);
    if (!conv) return;
    const lastUserIdx = conv.items.map((i) => i.type).lastIndexOf('question');
    if (lastUserIdx === -1) return;
    // 丢弃最后的助手回复（如有），重发最后一条用户消息
    if (lastUserIdx < conv.items.length - 1) {
      conv.items = conv.items.slice(0, lastUserIdx + 1);
      await saveConversations(conversations);
    }
    renderMessages();
    if (currentEngine() === 'agent') await runAgentTurn(conv, conv.items[lastUserIdx], selectedAgent());
    else await runAssistantTurn(conv, conv.items[lastUserIdx], selectedModel());
  }

  // ---- 附件（本条消息）：回形针 / 拖放 / 粘贴，发送时上传工作区 uploads/ ----
  const MAX_ATTACH_BYTES = 100 * 1024 * 1024;
  let pendingAttachments = []; // {file, name, size}

  function renderAttachRow() {
    R.attachRow.innerHTML = '';
    pendingAttachments.forEach((p, i) => {
      const chip = document.createElement('div');
      chip.className = 'om-attach-chip';
      chip.appendChild(svgIcon('file', 12));
      const name = document.createElement('span');
      name.className = 'om-chip-name';
      name.textContent = p.name;
      chip.appendChild(name);
      chip.title = `${p.name}（${(p.size / 1048576).toFixed(2)} MB）`;
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = '移除';
      del.addEventListener('click', () => {
        pendingAttachments.splice(i, 1);
        renderAttachRow();
      });
      chip.appendChild(del);
      R.attachRow.appendChild(chip);
    });
  }

  function addPendingFiles(files) {
    for (const f of files) {
      if (f.size > MAX_ATTACH_BYTES) {
        showToast(R.toast, `${f.name} 超过 100MB，已跳过`, 'error');
        continue;
      }
      const total = pendingAttachments.reduce((s, p) => s + p.size, 0) + f.size;
      if (total > MAX_ATTACH_BYTES) {
        showToast(R.toast, '附件总量超过 100MB，后面的文件未加入', 'error');
        break;
      }
      if (pendingAttachments.some((p) => p.name === f.name && p.size === f.size)) continue;
      pendingAttachments.push({ file: f, name: f.name, size: f.size });
    }
    renderAttachRow();
  }

  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.multiple = true;
  attachInput.hidden = true;
  R.composer.appendChild(attachInput);
  attachInput.addEventListener('change', () => {
    addPendingFiles(attachInput.files);
    attachInput.value = '';
  });
  R.attachBtn.addEventListener('click', () => attachInput.click());

  // 拖放目标盖整个 composer；带文件的拖拽才拦截（文本拖放不响应）
  const inputCard = R.composer.querySelector('.om-input-card');
  R.composer.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    inputCard.classList.add('om-dragover');
  });
  R.composer.addEventListener('dragleave', () => inputCard.classList.remove('om-dragover'));
  R.composer.addEventListener('drop', (e) => {
    inputCard.classList.remove('om-dragover');
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    addPendingFiles(e.dataTransfer.files);
  });
  R.input.addEventListener('paste', (e) => {
    if (!e.clipboardData?.files?.length) return;
    e.preventDefault();
    addPendingFiles(e.clipboardData.files);
  });

  // ---- 知识库（会话级）：上传件进工作区 knowledge/；本地路径原地引用（additionalDirectories） ----
  const kbPop = document.createElement('div');
  kbPop.className = 'om-kb-pop';
  kbPop.hidden = true;
  R.composer.appendChild(kbPop);

  async function saveKnowledge(conv, knowledge) {
    conv.knowledge = knowledge;
    await updateConversation(conv.id, (c) => { c.knowledge = knowledge; });
    syncEngineUi();
    renderKbPop();
  }

  function kbEntryEl(entry, conv) {
    const row = document.createElement('div');
    row.className = 'om-kb-item';
    row.dataset.kbId = entry.id;
    row.appendChild(svgIcon(entry.kind === 'local' ? 'folder' : 'file', 13));
    const path = document.createElement('span');
    path.className = 'om-kb-path';
    path.textContent = entry.kind === 'local' ? entry.path : `${entry.relPath}（${entry.name}）`;
    path.title = entry.kind === 'local' ? entry.path : entry.relPath;
    row.appendChild(path);
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', () => {
      saveKnowledge(conv, (conv.knowledge || []).filter((k) => k.id !== entry.id));
    });
    row.appendChild(del);
    return row;
  }

  function renderKbPop() {
    if (kbBrowser.open) {
      renderKbBrowser();
      return;
    }
    if (projDirBrowser.open) {
      renderProjDirBrowser();
      return;
    }
    const conv = conversations.find((c) => c.id === currentId);
    kbPop.innerHTML = '';
    const entries = conv?.knowledge ?? [];
    const head = document.createElement('div');
    head.className = 'om-kb-head';
    head.textContent = `知识库（本对话，${entries.length} 项）`;
    kbPop.appendChild(head);
    // 工作目录绑定：agent 的 cwd。未绑定时是 baseDir/<会话 id> 独立工作区
    const dirRow = document.createElement('div');
    dirRow.className = 'om-kb-cwd';
    const dirLabel = document.createElement('span');
    dirLabel.className = 'om-kb-cwd-path';
    dirLabel.textContent = conv?.projectDir ? `工作目录：${conv.projectDir}` : '工作目录：默认独立工作区';
    dirLabel.title = conv?.projectDir || '未绑定项目目录，agent 在会话专属工作区内工作';
    dirRow.appendChild(dirLabel);
    if (conv) {
      const bind = document.createElement('button');
      bind.textContent = conv.projectDir ? '更改' : '绑定';
      bind.title = '把本机项目目录设为 agent 工作目录（cwd），下一轮生效';
      bind.addEventListener('click', () => {
        projDirBrowser.open = true;
        fsBrowse(projDirBrowser, projDirBrowser.path || conv.projectDir || '~', kbPop, renderKbPop);
      });
      dirRow.appendChild(bind);
      if (conv.projectDir) {
        const unbind = document.createElement('button');
        unbind.textContent = '清除';
        unbind.title = '解绑项目目录，恢复独立工作区';
        unbind.addEventListener('click', async () => {
          await updateConversation(conv.id, (c) => { delete c.projectDir; });
          delete conv.projectDir;
          renderKbPop();
          syncEngineUi();
          showToast(R.toast, '已恢复独立工作区（下一轮生效）');
        });
        dirRow.appendChild(unbind);
      }
    }
    kbPop.appendChild(dirRow);
    const list = document.createElement('div');
    list.className = 'om-kb-list';
    if (conv) for (const k of entries) list.appendChild(kbEntryEl(k, conv));
    kbPop.appendChild(list);
    const actions = document.createElement('div');
    actions.className = 'om-kb-actions';
    const browse = document.createElement('button');
    browse.textContent = '浏览本机…';
    browse.title = '在文件系统里勾选真实路径，零拷贝引用';
    browse.addEventListener('click', () => kbBrowse(kbBrowser.path || '~'));
    const pickFiles = document.createElement('button');
    pickFiles.textContent = '上传文件';
    pickFiles.title = '内容拷贝进工作区 knowledge/（浏览器选择器拿不到原始路径）';
    pickFiles.addEventListener('click', () => kbFileInput.click());
    const pickDir = document.createElement('button');
    pickDir.textContent = '上传目录';
    pickDir.title = '目录内容拷贝进工作区 knowledge/（保留层级）';
    pickDir.addEventListener('click', () => kbDirInput.click());
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.placeholder = '本地绝对路径（目录或文件），回车添加';
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const p = pathInput.value.trim();
        if (p) {
          pathInput.value = '';
          addKbLocalPath(p);
        }
      }
    });
    actions.append(browse, pickFiles, pickDir, pathInput);
    kbPop.appendChild(actions);
    // 本地路径存在性复查：不存在的划线提示，不拦截发送
    if (conv) {
      for (const k of entries.filter((x) => x.kind === 'local')) {
        agentClient.fsCheck(k.path)
          .then((r) => {
            if (!r.exists) kbPop.querySelector(`[data-kb-id='${k.id}']`)?.classList.add('is-missing');
          })
          .catch(() => {});
      }
    }
  }

  const kbFileInput = document.createElement('input');
  kbFileInput.type = 'file';
  kbFileInput.multiple = true;
  kbFileInput.hidden = true;
  R.composer.appendChild(kbFileInput);
  kbFileInput.addEventListener('change', () => {
    addKbUploads([...kbFileInput.files].map((f) => ({ f, rel: f.name })));
    kbFileInput.value = '';
  });

  const kbDirInput = document.createElement('input');
  kbDirInput.type = 'file';
  kbDirInput.webkitdirectory = true;
  kbDirInput.multiple = true;
  kbDirInput.hidden = true;
  R.composer.appendChild(kbDirInput);
  kbDirInput.addEventListener('change', () => {
    addKbUploads([...kbDirInput.files].map((f) => ({ f, rel: f.webkitRelativePath || f.name })));
    kbDirInput.value = '';
  });

  async function addKbUploads(files) {
    if (!files.length) return;
    if (files.length > 200) {
      showToast(R.toast, '一次最多上传 200 个文件：大目录请改用「本地路径」引用', 'error');
      return;
    }
    const conv = conversations.find((c) => c.id === currentId);
    if (!conv) return;
    R.send.disabled = true;
    try {
      await agentClient.ensureReady();
      const settings = await loadSettings();
      const cwdBase = settings.agentBridge.baseDir || '';
      const added = [];
      for (const { f, rel } of files) {
        showToast(R.toast, `上传 ${rel}…`, 'info', true);
        const r = await agentClient.uploadFile({
          cwdBase,
          workspaceId: conv.id,
          relPath: 'knowledge/' + sanitizeName(rel),
          file: f,
        });
        added.push({ id: crypto.randomUUID(), kind: 'upload', name: f.name, relPath: 'knowledge/' + r.name });
      }
      await saveKnowledge(conv, [...(conv.knowledge ?? []), ...added]);
      showToast(R.toast, `知识库已添加 ${added.length} 项`);
    } catch (e) {
      showToast(R.toast, `知识库上传失败：${e.message}`, 'error');
    } finally {
      R.send.disabled = false;
    }
  }

  async function addKbLocalPath(path) {
    const conv = conversations.find((c) => c.id === currentId);
    if (!conv) return;
    try {
      await agentClient.ensureReady();
      const r = await agentClient.fsCheck(path);
      if (!r.exists) {
        showToast(R.toast, `路径不存在：${path}`, 'error');
        return;
      }
      await saveKnowledge(conv, [...(conv.knowledge ?? []), { id: crypto.randomUUID(), kind: 'local', path }]);
      showToast(R.toast, '已添加本地路径');
    } catch (e) {
      showToast(R.toast, `无法校验路径（bridge 未连接？）：${e.message}`, 'error');
    }
  }

  // ---- 通用本机目录浏览器（fs.list）：knowledge 模式勾选真实路径零拷贝引用、跨目录累积；
  // pickDir 模式无勾选，确认即返回当前目录。知识库面板与导出弹层各持一个 state 实例 ----
  function createFsBrowserState() {
    return { open: false, path: '', parent: '', entries: [], truncated: false, selected: new Set() };
  }

  async function fsBrowse(state, path, host, rerender) {
    try {
      await agentClient.ensureReady();
      // 异步往返期间给出加载态，避免点击后界面无变化像「没反应」
      if (state.open) {
        const crumb = host.querySelector('.om-kb-crumb');
        if (crumb) crumb.textContent = `${path} …`;
        const list = host.querySelector('.om-kb-list');
        if (list) list.textContent = '加载中…';
      }
      const r = await agentClient.fsList(path || '~');
      Object.assign(state, { open: true, path: r.path, parent: r.parent, entries: r.entries, truncated: r.truncated });
      rerender();
    } catch (e) {
      rerender(); // 恢复原列表（加载态只是替换文本）
      showToast(R.toast, `无法浏览目录（bridge 未连接或路径不可读？）：${e.message}`, 'error');
    }
  }

  function renderFsBrowser(host, state, { mode, navigate, onConfirm, onClose }) {
    const picking = mode === 'pickDir';
    host.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'om-kb-head';
    const crumb = document.createElement('span');
    crumb.className = 'om-kb-crumb';
    crumb.textContent = state.path;
    crumb.title = state.path;
    const up = document.createElement('button');
    up.textContent = '↑ 上级';
    up.title = state.parent;
    up.disabled = !state.parent || state.parent === state.path;
    up.addEventListener('click', () => navigate(state.parent));
    // 路径跳转：粘贴绝对路径（如 E:\code）回车直达，跨盘不用层层上级
    const jump = document.createElement('input');
    jump.type = 'text';
    jump.className = 'om-kb-jump';
    jump.placeholder = '路径跳转';
    jump.title = '输入或粘贴本机绝对路径，回车进入';
    jump.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const p = jump.value.trim();
        if (p) navigate(p);
      }
    });
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = '关闭浏览器';
    close.addEventListener('click', onClose);
    head.append(crumb, jump, up, close);
    host.appendChild(head);
    const list = document.createElement('div');
    list.className = 'om-kb-list om-kb-browser';
    for (const entry of state.entries) {
      const row = document.createElement('div');
      row.className = 'om-kb-row';
      const box = picking ? null : document.createElement('input');
      if (box) {
        box.type = 'checkbox';
        box.checked = state.selected.has(entry.path);
        box.addEventListener('change', () => {
          if (box.checked) state.selected.add(entry.path);
          else state.selected.delete(entry.path);
          updateConfirm();
        });
        row.appendChild(box);
      }
      row.appendChild(svgIcon(entry.isDirectory ? 'folder' : 'file', 13));
      const name = document.createElement('span');
      name.className = 'om-kb-name';
      name.textContent = entry.name;
      name.title = entry.path;
      row.appendChild(name);
      if (entry.isDirectory) {
        const enter = document.createElement('button');
        enter.className = 'om-kb-enter';
        enter.textContent = '进入';
        enter.addEventListener('click', (e) => { e.stopPropagation(); navigate(entry.path); });
        row.appendChild(enter);
      }
      row.addEventListener('click', (e) => {
        if ((box && e.target === box) || e.target.tagName === 'BUTTON') return;
        if (entry.isDirectory) navigate(entry.path);
        else if (box) box.click();
      });
      list.appendChild(row);
    }
    host.appendChild(list);
    const actions = document.createElement('div');
    actions.className = 'om-kb-actions';
    const confirmBtn = document.createElement('button');
    if (picking) confirmBtn.textContent = '选择此目录';
    confirmBtn.addEventListener('click', () => onConfirm(state.path));
    const updateConfirm = () => {
      if (picking) return; // pickDir：目标就是当前目录，恒可确认
      const n = state.selected.size;
      confirmBtn.textContent = n ? `添加所选（${n}）` : '添加所选';
      confirmBtn.disabled = !n;
    };
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.addEventListener('click', onClose);
    actions.append(confirmBtn, cancel);
    if (state.truncated) {
      const note = document.createElement('span');
      note.className = 'om-kb-note';
      note.textContent = '目录超 1000 项已截断，可直接键入路径定位';
      actions.appendChild(note);
    }
    host.appendChild(actions);
    updateConfirm();
  }

  // 知识库实例：多选真实路径加入会话知识库
  const kbBrowser = createFsBrowserState();

  function kbBrowse(path) {
    return fsBrowse(kbBrowser, path, kbPop, renderKbPop);
  }

  function closeKbBrowser() {
    kbBrowser.open = false;
    kbBrowser.selected.clear();
    renderKbPop();
  }

  async function commitKbBrowser() {
    const conv = conversations.find((c) => c.id === currentId);
    if (!conv || !kbBrowser.selected.size) return;
    const added = [...kbBrowser.selected].map((path) => ({ id: crypto.randomUUID(), kind: 'local', path }));
    kbBrowser.open = false;
    kbBrowser.selected.clear();
    await saveKnowledge(conv, [...(conv.knowledge ?? []), ...added]);
    showToast(R.toast, `知识库已添加 ${added.length} 项`);
  }

  function renderKbBrowser() {
    renderFsBrowser(kbPop, kbBrowser, { mode: 'knowledge', navigate: kbBrowse, onConfirm: commitKbBrowser, onClose: closeKbBrowser });
  }

  // 工作目录绑定实例：pickDir 单目录模式，确认即写 conv.projectDir
  const projDirBrowser = createFsBrowserState();

  function closeProjDirBrowser() {
    projDirBrowser.open = false;
    projDirBrowser.selected.clear();
    renderKbPop();
  }

  async function commitProjDirBrowser(path) {
    projDirBrowser.open = false;
    projDirBrowser.selected.clear();
    const conv = conversations.find((c) => c.id === currentId);
    if (conv) {
      await updateConversation(conv.id, (c) => { c.projectDir = path; });
      conv.projectDir = path;
      syncEngineUi();
      showToast(R.toast, `工作目录已绑定 ${path}（下一轮生效）`);
    }
    renderKbPop();
  }

  function renderProjDirBrowser() {
    renderFsBrowser(kbPop, projDirBrowser, {
      mode: 'pickDir',
      navigate: (p) => fsBrowse(projDirBrowser, p, kbPop, renderKbPop),
      onConfirm: commitProjDirBrowser,
      onClose: closeProjDirBrowser,
    });
  }

  R.kbBtn.addEventListener('click', () => {
    if (currentEngine() !== 'agent') {
      showToast(R.toast, 'LLM 引擎会话不支持知识库', 'error');
      return;
    }
    kbPop.hidden = !kbPop.hidden;
    if (!kbPop.hidden) {
      renderKbPop();
      kbPop.querySelector('.om-kb-actions input')?.focus();
    }
  });
  // 点到面板与按钮之外即关闭
  document.addEventListener('click', (e) => {
    if (kbPop.hidden) return;
    if (kbPop.contains(e.target) || R.kbBtn.contains(e.target)) return;
    kbPop.hidden = true;
  });

  // ---- 导出会话为 Markdown：agent 引擎按会话记录拼全文，经 bridge fs.write 落盘
  // （默认工作区 docs/，绑定项目目录时落项目 docs/）；LLM 引擎一次性 streamChat
  // 总结生成后走 chrome.downloads 系统保存对话框 ----
  const exportPop = document.createElement('div');
  exportPop.className = 'om-export-pop';
  exportPop.hidden = true;
  R.topbar.appendChild(exportPop);

  const dirBrowser = createFsBrowserState();
  let exportName = '';
  let exportDir = '';

  // 文件名 YYYYMMDD-HHmm_<主题>.md：本地时间 + 标题清洗（非法字符→_、去尾点/空格、≤60 字）
  function defaultExportName(conv) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    const title = String(conv?.title || '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 60)
      .trim();
    return `${stamp}_${title || '会话总结'}.md`;
  }

  function closeExportPop() {
    dirBrowser.open = false;
    dirBrowser.selected.clear();
    exportPop.hidden = true;
  }

  function renderExportPop() {
    exportPop.innerHTML = '';
    if (dirBrowser.open) {
      renderFsBrowser(exportPop, dirBrowser, {
        mode: 'pickDir',
        navigate: (p) => fsBrowse(dirBrowser, p, exportPop, renderExportPop),
        onConfirm: (path) => {
          dirBrowser.open = false;
          dirBrowser.selected.clear();
          exportDir = path;
          renderExportPop();
        },
        onClose: () => {
          dirBrowser.open = false;
          dirBrowser.selected.clear();
          renderExportPop();
        },
      });
      return;
    }
    const conv = conversations.find((c) => c.id === currentId);
    if (!conv) return;
    const form = document.createElement('div');
    form.className = 'om-export-form';
    const head = document.createElement('div');
    head.className = 'om-kb-head';
    head.textContent = '导出会话为 Markdown（完整内容）';
    form.appendChild(head);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'om-export-name';
    nameInput.value = exportName;
    nameInput.placeholder = '文件名（.md）';
    nameInput.addEventListener('input', () => { exportName = nameInput.value; });
    form.appendChild(nameInput);
    if (currentEngine() === 'agent') {
      const where = document.createElement('div');
      where.className = 'om-export-where';
      const def = document.createElement('label');
      const defRadio = document.createElement('input');
      defRadio.type = 'radio';
      defRadio.name = 'om-export-where';
      defRadio.checked = !exportDir;
      def.append(defRadio, document.createTextNode('当前工作目录 docs/'));
      const custom = document.createElement('label');
      const customRadio = document.createElement('input');
      customRadio.type = 'radio';
      customRadio.name = 'om-export-where';
      customRadio.checked = !!exportDir;
      custom.append(customRadio, document.createTextNode('自定义目录'));
      const dirInput = document.createElement('input');
      dirInput.type = 'text';
      dirInput.className = 'om-export-dirpath';
      dirInput.value = exportDir;
      dirInput.placeholder = '本机绝对路径';
      dirInput.addEventListener('input', () => {
        exportDir = dirInput.value.trim();
        if (exportDir) customRadio.checked = true;
        else defRadio.checked = true;
      });
      const browseBtn = document.createElement('button');
      browseBtn.textContent = '浏览…';
      browseBtn.title = '在文件系统里选择目录';
      browseBtn.addEventListener('click', () => {
        dirBrowser.open = true;
        fsBrowse(dirBrowser, dirBrowser.path || exportDir || '~', exportPop, renderExportPop);
      });
      where.append(def, custom, dirInput, browseBtn);
      form.appendChild(where);
    } else {
      const note = document.createElement('div');
      note.className = 'om-export-note';
      note.textContent = 'LLM 引擎会话：导出时弹出系统保存对话框选择位置';
      form.appendChild(note);
    }
    const actions = document.createElement('div');
    actions.className = 'om-kb-actions';
    const go = document.createElement('button');
    go.textContent = '导出';
    go.addEventListener('click', exportSummary);
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeExportPop);
    actions.append(go, cancel);
    form.appendChild(actions);
    exportPop.appendChild(form);
  }

  async function exportSummary() {
    const conv = conversations.find((c) => c.id === currentId);
    if (!conv || !conv.items.length || exporting || streaming) return;
    const raw = (exportName || '').trim() || defaultExportName(conv);
    const filename = raw.toLowerCase().endsWith('.md') ? raw : `${raw}.md`;
    if (/[\\/:*?"<>|]/.test(filename.slice(0, -3))) {
      showToast(R.toast, '文件名不能包含 \\ / : * ? " < > |', 'error');
      return;
    }
    const dir = exportDir.trim();
    closeExportPop();
    if (currentEngine() === 'agent') {
      // 全量整理导出：文档由扩展按会话记录拼好，经 bridge fs.write 直接落盘。
      // 不再让 agent 凭会话记忆总结——长会话被 agent 侧压缩后记忆只剩尾部，
      // 导出的文档会缺早期内容
      try {
        await agentClient.ensureReady();
        const md = buildConversationMarkdown(conv);
        let write;
        if (dir) {
          const r = await agentClient.fsCheck(dir);
          if (!r.exists || !r.isDirectory) {
            showToast(R.toast, `目录不存在或不是目录：${dir}`, 'error');
            return;
          }
          write = await agentClient.fsWrite({ path: `${dir.replace(/[\\/]+$/, '')}\\${filename}`, content: md });
        } else if (conv.projectDir) {
          // 会话绑定项目目录时 agent 的 cwd 是项目目录，docs/ 跟着落在项目里
          write = await agentClient.fsWrite({ path: `${conv.projectDir.replace(/[\\/]+$/, '')}\\docs\\${filename}`, content: md });
        } else {
          const settings = await loadSettings();
          write = await agentClient.fsWrite({
            cwdBase: settings.agentBridge.baseDir || '',
            workspaceId: conv.id,
            relPath: `docs/${filename}`,
            content: md,
          });
        }
        showToast(R.toast, `已导出：${write.path}`);
      } catch (e) {
        showToast(R.toast, `无法导出：${e.message}`, 'error');
      }
      return;
    }
    // LLM 引擎：不进 transcript，一次性生成后交给浏览器下载
    if (!ensureModel()) return;
    exporting = true;
    setBusyUi();
    showToast(R.toast, '正在生成总结…', 'info', true);
    try {
      const messages = conv.items
        .filter((i) => i.type === 'question' || (i.content && !i.error))
        .map((i) => ({ role: i.type === 'question' ? 'user' : 'assistant', content: i.content }));
      messages.push({
        role: 'user',
        content:
          `请把以上对话总结成一份 Markdown 文档。` +
          `结构：# ${conv.title}（含保存时间）；## 概述；## 关键结论与决定；## 重要代码与命令；## 待办事项。` +
          '只输出 Markdown 正文，不要输出其他说明。',
      });
      let md = '';
      await streamChat({ messages, model: selectedModel(), onDelta: (t) => { md += t; } });
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      await chrome.downloads.download({ url, filename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      showToast(R.toast, '已生成总结，请在保存对话框中选择位置');
    } catch (e) {
      showToast(R.toast, `导出失败：${e.message}`, 'error');
    } finally {
      exporting = false;
      setBusyUi();
    }
  }

  R.exportBtn.addEventListener('click', () => {
    const conv = conversations.find((c) => c.id === currentId);
    if (!conv?.items?.length) return; // 空会话按钮已置灰，这里双保险
    exportName = defaultExportName(conv); // 每次打开重取：时间戳跟随当前时刻
    exportPop.hidden = !exportPop.hidden;
    if (!exportPop.hidden) {
      renderExportPop();
      exportPop.querySelector('.om-export-name')?.select();
    }
  });
  document.addEventListener('click', (e) => {
    if (exportPop.hidden) return;
    if (exportPop.contains(e.target) || R.exportBtn.contains(e.target)) return;
    closeExportPop();
  });

  // ---- 网页上下文（页内聊天卡） ----
  // 卡片打开时向宿主页索取正文提炼（widget.js 提取回传），挂到会话 pageCtx：
  // LLM 轮每轮注入 system 消息、agent 轮并入首条 prompt，提问/翻译不因缺上下文产生幻觉。
  // 首条消息发送前挂上；chip 可一键移除。
  let cardCtx = null;
  const ctxRow = document.createElement('div');
  ctxRow.className = 'om-attach-row';
  R.input.parentElement.insertBefore(ctxRow, R.input);

  function pageCtxPrompt(ctx) {
    return [
      '以下是用户当前浏览网页的正文内容，作为回答后续问题的背景上下文；与问题无关时忽略。',
      `网页标题：${ctx.title || '（无标题）'}`,
      `网页地址：${ctx.url || '（未知）'}`,
      '',
      '网页正文（可能截断）：',
      (ctx.text || '').slice(0, 6000),
    ].join('\n');
  }

  function renderCtxRow() {
    const ctx = conversations.find((c) => c.id === currentId)?.pageCtx;
    ctxRow.innerHTML = '';
    if (!ctx) return;
    const chip = document.createElement('div');
    chip.className = 'om-attach-chip';
    chip.appendChild(svgIcon('doc', 12));
    const name = document.createElement('span');
    name.className = 'om-chip-name';
    name.textContent = `网页上下文：${ctx.title || ctx.url || '当前页面'}`;
    chip.appendChild(name);
    chip.title = `回答将附带该网页正文（${ctx.url || ''}）`;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.title = '移除网页上下文';
    rm.textContent = '×';
    rm.addEventListener('click', async () => {
      const c = conversations.find((x) => x.id === currentId);
      if (!c) return;
      c.pageCtx = null;
      await saveConversations(conversations);
      renderCtxRow();
    });
    chip.appendChild(rm);
    ctxRow.appendChild(chip);
  }

  // 只挂到「还没说过话」的会话：进行中的会话不悄悄换上下文
  function attachPageCtx(conv) {
    if (!cardCtx || !conv || conv.items.length > 0 || conv.pageCtx) return false;
    conv.pageCtx = cardCtx;
    return true;
  }

  if (window.parent !== window) {
    window.addEventListener('message', (ev) => {
      if (ev.source !== window.parent || ev.data?.type !== 'om:card-ctx') return;
      const d = ev.data;
      if (typeof d?.text !== 'string' || d.text.trim().length < 80) return;
      cardCtx = { title: String(d.title || ''), url: String(d.url || ''), text: d.text.trim() };
      const conv = conversations.find((c) => c.id === currentId);
      if (attachPageCtx(conv)) void saveConversations(conversations).then(renderCtxRow);
    });
    try { parent.postMessage({ type: 'om:card-ctx-req' }, '*'); } catch { /* 跨源受限时忽略 */ }
  }

  // ---- 页面功能 ----
  async function summarizePage() {
    if (streaming || translating) return;
    if (!ensureEngine()) return;
    try {
      showToast(R.toast, '正在提取正文…', 'info', true);
      const { prompt, meta } = await summarizeCurrentTab();
      showToast(R.toast, '');
      await sendPrepared(prompt, meta, '网页总结');
    } catch (e) {
      showToast(R.toast, e.message, 'error');
    }
  }

  // 视口驱动翻译：进度由页面浮球呈现，这里不再弹「提取/进度/块数」提示。
  // 可见范围译完（onEvent done）即恢复输入；滚动续译在后台继续，不阻塞聊天。
  function translatePage() {
    if (translating) {
      cancelTranslate();
      showToast(R.toast, '已取消翻译');
      return;
    }
    if (streaming) {
      showToast(R.toast, '请等待当前回复完成', 'error');
      notifyTxFailed('请等待当前回复完成');
      return;
    }
    if (!ensureModel()) {
      notifyTxFailed('请先在设置页配置供应商并保存');
      return;
    }
    translating = true;
    setBusyUi();
    loadSettings().then((settings) => translateCurrentTab(settings, (ev) => {
      if (ev.phase === 'done') {
        translating = false;
        setBusyUi();
      }
    })).catch((e) => {
      translating = false;
      setBusyUi();
      if (e?.name === 'AbortError') showToast(R.toast, '翻译已取消');
      else if (e?.message === '用户关闭翻译') { /* 浮球「关闭」：静默收场 */ }
      else {
        showToast(R.toast, e.message, 'error');
        notifyTxFailed(e.message);
      }
    });
  }

  // ---- 输入框 ----
  function autoGrow() {
    R.input.style.height = 'auto';
    R.input.style.height = Math.min(R.input.scrollHeight, 160) + 'px';
  }
  R.input.addEventListener('input', autoGrow);
  R.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  R.send.addEventListener('click', send);
  R.regenBtn.addEventListener('click', regenerate);

  // ---- 侧栏事件 ----
  R.newBtn.addEventListener('click', async () => {
    if (streaming) return;
    const conv = newConv('新对话');
    attachPageCtx(conv); // 卡内新建对话同样带上当前网页上下文
    conversations.unshift(conv);
    currentId = conv.id;
    await saveConversations(conversations);
    renderConvList();
    renderMessages();
    syncEngineUi();
    closeDrawer();
    R.input.focus();
  });
  R.filter.addEventListener('input', renderConvList);

  // ---- pendingTask 消费（SW 右键菜单/页面浮窗写入 storage.session） ----
  // 未配置供应商时保留任务不消费：配置好后重开面板自动继续
  async function consumePendingTask() {
    try {
      const { pendingTask, pendingPrompt } = await chrome.storage.session.get(['pendingTask', 'pendingPrompt']);
      if (pendingTask) {
        // 翻译不走聊天引擎，只受 translatePage 内的供应商守卫约束；
        // 聊天类任务（快捷动作 / 旧版预填）仍按引擎守卫拦截并保留任务
        if (pendingTask.kind !== 'translate-page' && !(await ensureEngineAsync())) return;
        await chrome.storage.session.remove('pendingTask');
        if (pendingTask.kind === 'quick-action') {
          const meta = pendingTask.sourceUrl
            ? { kind: 'selection', url: pendingTask.sourceUrl, title: pendingTask.title }
            : undefined;
          await sendPrepared(pendingTask.prompt, meta, pendingTask.title);
        } else if (pendingTask.kind === 'ask') {
          if (pendingTask.autoSend) {
            // 面板追问：用户已输入完问题，直接发送（与 quick-action 同管线）
            const meta = pendingTask.sourceUrl
              ? { kind: 'selection', url: pendingTask.sourceUrl, title: pendingTask.title }
              : undefined;
            await sendPrepared(pendingTask.prompt, meta, pendingTask.title);
          } else {
            // 快速提问（划词工具条）：选中内容以引用格式预填输入框并聚焦，不自动发送
            const quote = String(pendingTask.prompt || '')
              .split('\n').map((l) => `> ${l}`).join('\n');
            R.input.value = `${quote}\n\n`;
            autoGrow();
            R.input.focus();
          }
        } else if (pendingTask.kind === 'translate-page') {
          translatePage();
        } else if (pendingTask.kind === 'page-summary') {
          summarizePage();
        }
        return;
      }
      // v1 兼容：旧 pendingPrompt 只预填输入框
      if (pendingPrompt) {
        if (!(await ensureEngineAsync())) return;
        await chrome.storage.session.remove('pendingPrompt');
        R.input.value = pendingPrompt;
        autoGrow();
        send();
      }
    } catch { /* storage.session 不可用时忽略 */ }
  }

  await renderModelOptions();
  // 老数据对齐：从未显式选过引擎（无 engine 字段）且未配供应商的会话，默认切到 agent，
  // 显式选过 llm 的不动；agentSessionId 存过 bridge 会话 id（s: 前缀）的清空——
  // 那不是 SDK 会话 id，拿去 resume 会失败，丢一轮续聊但 transcript 完整保留
  {
    let migrated = false;
    for (const c of conversations) {
      if (providersEmpty && !c.engine) { c.engine = 'agent'; migrated = true; }
      if (typeof c.agentSessionId === 'string' && c.agentSessionId.startsWith('s:')) {
        delete c.agentSessionId;
        migrated = true;
      }
    }
    if (migrated) await saveConversations(conversations);
  }
  if (!conversations.length) {
    const conv = newConv('新对话');
    conversations.push(conv);
    currentId = conv.id;
    await saveConversations(conversations);
  }
  if (!currentId) currentId = conversations[0].id;
  renderConvList();
  renderMessages();
  syncEngineUi();
  setBusyUi();
  R.input.focus();
  consumePendingTask();
  // 面板已打开时，浮窗/右键新写入的任务实时消费（无需重开面板）
  chrome.storage.session?.onChanged?.addListener((changes) => {
    if (changes.pendingTask?.newValue) consumePendingTask();
  });

  // 多视图同步：侧边栏/聊天页/聊天卡各自持有内存 conversations，任一视图
  // 写 storage 后其余视图重载。流式中跳过（turn 收尾本就 loadConversations 兜底），
  // 防止 stale 全量写复活已删会话。防抖 200ms 合并连续写；内容一致即自己写的，跳过。
  let syncTimer = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.conversations) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      if (streaming) return;
      const fresh = await loadConversations();
      if (JSON.stringify(fresh) === JSON.stringify(conversations)) return;
      conversations = fresh;
      if (!conversations.some((c) => c.id === currentId)) currentId = conversations[0]?.id ?? '';
      if (!conversations.length) {
        const conv = newConv('新对话');
        conversations.push(conv);
        currentId = conv.id;
        await saveConversations(conversations);
      }
      renderConvList();
      renderMessages();
      syncEngineUi();
    }, 200);
  });

  return { renderMessages, renderConvList, renderModelOptions };
}

// 顶层实例（原生侧边栏 / 独立聊天页）可见时通知后台：收起各页面里的聊天卡，
// 避免侧边栏与聊天卡两个聊天窗并存。聊天卡 iframe 不是顶层，不参与。
if (window.self === window.top) {
  const notifyPanelVisible = () => {
    if (document.visibilityState !== 'visible') return;
    try { chrome.runtime.sendMessage({ type: 'om:panel-visible' }); } catch { /* 上下文失效时忽略 */ }
  };
  document.addEventListener('visibilitychange', notifyPanelVisible);
  notifyPanelVisible();
}

// 本模块只被两个页面 HTML 直接加载，自启动视图
createChatView().catch((e) => {
  document.body.innerHTML = `<pre style="color:#cf222e;padding:16px">初始化失败：${e.stack || e.message}</pre>`;
});
