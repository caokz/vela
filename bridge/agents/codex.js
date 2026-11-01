// codex 适配器：spawn `codex app-server`（JSON-RPC over stdio，按行分帧）。
// 链路：initialize → thread/start（新会话）| thread/resume（续聊）→ turn/start，
// 通知归一化到 vela 事件词汇表；服务端审批请求（item/*/requestApproval 等）
// 转 onPermission，用户应答后按 codex 的 decision 词汇回写。
// codex 线程持久化在 CODEX_HOME，跨进程 resume 续聊（协议实测 0.162.x）。
// 未知 method / 通知一律丢弃，CLI 迭代快，容错优先。

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROBE_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 20000;
const INTERRUPT_GRACE_MS = 3500;

export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function codexConfigText() {
  try {
    return readFileSync(join(codexHome(), 'config.toml'), 'utf8');
  } catch { /* 无配置文件：环境变量兜底 */ }
  return '';
}

// config.toml 的默认模型（model = "..."）：探测回传给前端「默认模型」显示真实落点
export function codexDefaultModel() {
  const m = codexConfigText().match(/^\s*model\s*=\s*"([^"]+)"/m);
  return m ? m[1] : '';
}

// 登录态判定（尽力而为）：auth.json = ChatGPT 登录；config.toml 配了自建
// model_provider（base_url + key 落在配置/环境）也算可用——实测未登录 ChatGPT
// 但 custom provider 配好时 turn 照常工作，误报「未登录」会把它挡在门外。
export function codexAuthed() {
  if (existsSync(join(codexHome(), 'auth.json'))) return true;
  return /^\s*\[model_providers\./m.test(codexConfigText());
}

// 定位 codex 可执行文件。npm 全局包是 node 壳 + 平台原生 exe：长驻 stdio 通信
// 必须直连原生 exe——.cmd 经 shell 包装后 kill 只杀得掉 cmd，孙进程 codex.exe
// 会残留。找不到原生 exe 再退回 PATH 上的 `codex`（win32 下 .cmd 需 shell）。
export function resolveCodexCommand() {
  if (process.env.VELA_CODEX_PATH) {
    const p = process.env.VELA_CODEX_PATH;
    return { command: p, args: [], shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(p) };
  }
  if (process.platform === 'win32') {
    const pkg = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
    for (const platform of ['codex-win32-x64', 'codex-win32-arm64']) {
      for (const triple of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) {
        const exe = join(pkg, platform, 'vendor', triple, 'bin', 'codex.exe');
        if (existsSync(exe)) return { command: exe, args: [], shell: false };
      }
    }
  }
  return { command: 'codex', args: [], shell: process.platform === 'win32' };
}

function killTree(child) {
  if (child.exitCode != null || child.signalCode) return;
  if (process.platform === 'win32') {
    // /T 连子进程树一起杀（codex 会再派生 pwsh / rg 等子进程）
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    try { child.kill(); } catch { /* 已退出 */ }
  }
}

// vela 权限模式 → codex sandbox + approvalPolicy。
// default/acceptEdits：工作区可写、按需审批（codex 的 on-request 本就只对
// 沙箱外/高危动作发审批，acceptEdits 语义近似）；bypassPermissions：全放行。
export function codexPolicy(permissionMode) {
  if (permissionMode === 'bypassPermissions') {
    return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
  }
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
}

// 统一 spawn：shell 模式下参数必须拼进命令串（node 对 shell+args 只做拼接并告警）。
// 追加的参数都是死字符串，无注入面。
function spawnCodex(extraArgs, options) {
  const { command, args, shell } = resolveCodexCommand();
  if (shell) return spawn([command, ...args, ...extraArgs].join(' '), [], { ...options, shell: true });
  return spawn(command, [...args, ...extraArgs], options);
}

function runVersion() {
  return new Promise((resolve) => {
    const resolved = resolveCodexCommand();
    const args = [...resolved.args, '--version'];
    const command = resolved.shell ? [resolved.command, ...args].join(' ') : resolved.command;
    const child = execFile(command, resolved.shell ? [] : args, { timeout: PROBE_TIMEOUT_MS, shell: resolved.shell }, (err, stdout) => {
      resolve(err ? null : (stdout || '').trim());
    });
    child.on('error', () => resolve(null));
  });
}

// 工具步骤状态 → 渲染层状态词汇（in_progress / completed / failed / cancelled）
function mapItemStatus(status) {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'declined') return 'cancelled';
  return 'in_progress';
}

function capLine(s, max) {
  const line = String(s ?? '').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

// codex 的 ThreadItem → tool_call / tool_call_update。fileChange 的审批请求里
// 没有路径列表，靠 items 缓存反查（item/started 先到）。
function itemTitle(item) {
  switch (item?.type) {
    case 'commandExecution':
      return `shell: ${capLine(item.command, 90)}`;
    case 'fileChange': {
      const paths = (item.changes ?? []).map((c) => c.path);
      return paths.length ? `edit: ${capLine(paths.join(', '), 90)}` : 'edit: 文件修改';
    }
    case 'mcpToolCall':
      return `${item.server || 'mcp'}.${item.tool || 'tool'}`;
    case 'webSearch': {
      const q = item.query || item.action?.query || item.action?.url || '';
      return `search: ${capLine(q, 90)}`;
    }
    default:
      return item?.type || 'item';
  }
}

function itemDetail(item) {
  switch (item?.type) {
    case 'commandExecution':
      return capLine(`command: ${item.command}\ncwd: ${item.cwd ?? ''}`, 1200);
    case 'fileChange':
      return capLine((item.changes ?? []).map((c) => `${c.kind}: ${c.path}`).join('\n'), 1200);
    case 'mcpToolCall':
      return capLine(safeJson(item.arguments), 1200);
    case 'webSearch':
      return capLine(item.query || safeJson(item.action) || '', 1200);
    default:
      return '';
  }
}

function itemResult(item) {
  switch (item?.type) {
    case 'commandExecution':
      if (item.aggregatedOutput != null && item.aggregatedOutput !== '') {
        return capLine(item.aggregatedOutput, 2500);
      }
      return item.exitCode != null ? `exit ${item.exitCode}` : '';
    case 'fileChange':
      return capLine((item.changes ?? []).map((c) => `${c.kind}: ${c.path}`).join('\n'), 2500);
    case 'mcpToolCall': {
      if (item.error?.message) return capLine(item.error.message, 2500);
      const content = Array.isArray(item.result?.content) ? item.result.content : [];
      const text = content.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? (b.text ?? '') : safeJson(b))).join('\n');
      return capLine(text, 2500);
    }
    case 'webSearch':
      return capLine(item.query || '', 2500);
    default:
      return '';
  }
}

function safeJson(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

export const codexAdapter = {
  id: 'codex',
  name: 'Codex CLI',
  loginCommand: ['codex', 'login'],

  async probe() {
    const version = await runVersion();
    return {
      id: this.id,
      name: this.name,
      version: version || '',
      authed: version ? codexAuthed() : false,
      loginCommand: this.loginCommand,
      defaultModel: codexDefaultModel(),
    };
  },

  // 模型列表：起一个临时 app-server 问 model/list；拿不到时退 config.toml 的
  // 默认模型，仍拿不到抛错（上层捕获后前端回退预设，不阻塞聊天）。
  async listModels() {
    try {
      const ids = await listModelsViaServer();
      if (ids.length) return ids;
    } catch { /* 起进程失败/超时 → 走 config 回退 */ }
    const fallback = codexDefaultModel();
    if (fallback) return [fallback];
    throw new Error('模型列表不可得：codex app-server 未返回模型且 config.toml 无默认模型');
  },

  // 跑一个 turn：起 app-server → initialize → thread/start|resume → turn/start，
  // 等 turn/completed。结束保证发 turn_end（且只发一次）；取消走 turn/interrupt，
  // 宽限期内等 interrupted 的 turn/completed 自然落地，超时兜底 kill 进程。
  async startTurn(session, text, { emit, signal, onPermission }) {
    const cwd = session.cwd || homedir();
    const { sandbox, approvalPolicy } = codexPolicy(session.permissionMode);
    const model = session.model || '';
    const contextDirs = Array.isArray(session.contextDirs) ? session.contextDirs.filter(Boolean) : [];

    const child = spawnCodex(['app-server'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });

    let nextId = 1;
    let threadId = '';
    let turnId = '';
    let settled = false;          // turn_end 是否已发（保证只发一次）
    let interrupting = false;     // 已发 interrupt，等 turn/completed(interrupted)
    let heldError = '';           // error 通知先到、turn/completed 后到时的报错文案
    const pending = new Map();    // 请求 id -> resolve
    const items = new Map();      // itemId -> ThreadItem（审批反查 / tool 状态）
    const toolT0 = new Map();     // itemId -> 开始时间戳
    let buf = '';

    const write = (obj) => {
      try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* 进程已退出 */ }
    };
    const request = (method, params, timeoutMs = REQUEST_TIMEOUT_MS) => new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); resolve({ id, error: { message: `${method} 超时` } }); }, timeoutMs);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      write({ jsonrpc: '2.0', id, method, params });
    });
    const respond = (id, result) => write({ id, result });
    const respondError = (id, message) => write({ id, error: { code: -32601, message } });

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      killTree(child);
      for (const resolve of pending.values()) resolve({ error: { message: 'turn 已结束' } });
      pending.clear();
    };
    const finish = (stopReason, error = '') => {
      if (settled) return;
      settled = true;
      if (error) emit({ kind: 'turn_end', stopReason, error });
      else emit({ kind: 'turn_end', stopReason });
      cleanup();
    };

    const onAbort = () => {
      if (settled) return;
      interrupting = true;
      if (threadId && turnId) request('turn/interrupt', { threadId, turnId }, 3000);
      setTimeout(() => finish('cancelled'), INTERRUPT_GRACE_MS).unref?.();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      finish('error', `启动 codex 失败（${err.code === 'ENOENT' ? '未找到 codex CLI，npm i -g @openai/codex 或设 VELA_CODEX_PATH' : err.message}）`);
    });
    child.on('exit', () => {
      if (signal.aborted || interrupting) finish('cancelled');
      else finish('error', heldError || 'codex 进程意外退出');
    });
    child.stderr?.on('data', () => { /* codex 往 stderr 打日志噪声，丢弃 */ });

    const onNotification = (method, p) => {
      switch (method) {
        case 'item/agentMessage/delta':
          if (p?.delta) emit({ kind: 'message_chunk', text: String(p.delta) });
          break;
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta':
          if (p?.delta) emit({ kind: 'thought_chunk', text: String(p.delta) });
          break;
        case 'turn/started':
          if (!turnId && p?.turn?.id) turnId = p.turn.id;
          break;
        case 'item/started':
          onItem(p?.item, false);
          break;
        case 'item/completed':
          onItem(p?.item, true);
          break;
        case 'error':
          // willRetry=true 的瞬时错误等重试结果；终态错误由 turn/completed 兜出
          if (p?.error?.message && p?.willRetry === false) heldError = p.error.message;
          break;
        case 'turn/completed':
          onTurnCompleted(p?.turn);
          break;
        default:
          break; // thread/status、hook、账号、remoteControl 等噪声全部丢弃
      }
    };

    const onItem = (item, completed) => {
      if (!item?.id || !['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)) return;
      items.set(item.id, item);
      if (completed) {
        const t0 = toolT0.get(item.id);
        toolT0.delete(item.id);
        emit({
          kind: 'tool_call_update',
          id: item.id,
          status: mapItemStatus(item.status),
          result: itemResult(item),
          ...(t0 != null ? { durationMs: Date.now() - t0 } : {}),
          ...(item.durationMs != null ? { durationMs: item.durationMs } : {}),
        });
      } else if (!toolT0.has(item.id)) {
        toolT0.set(item.id, Date.now());
        emit({ kind: 'tool_call', id: item.id, title: itemTitle(item), detail: itemDetail(item), parentId: '' });
      }
    };

    const onTurnCompleted = (turn) => {
      if (typeof turn?.durationMs === 'number') emit({ kind: 'usage', durationMs: turn.durationMs });
      if (turn?.status === 'interrupted' || interrupting) finish('cancelled');
      else if (turn?.status === 'failed') finish('error', turn?.error?.message || heldError || 'turn 失败');
      else finish('end');
    };

    // 服务端请求 = 审批/输入类回调：每一条都必须回（结果或错误），
    // 否则 codex 侧挂起等不到应答。未知请求回 -32601 让其走失败路径。
    const onServerRequest = async (m) => {
      const p = m.params ?? {};
      const ask = (title, detail) => onPermission({ title, detail: capLine(detail, 400) });
      try {
        switch (m.method) {
          case 'item/commandExecution/requestApproval': {
            const decision = await ask('运行命令', `${p.command ?? ''}${p.cwd ? `\n（目录 ${p.cwd}）` : ''}`) === 'allow' ? 'accept' : 'decline';
            respond(m.id, { decision });
            break;
          }
          case 'item/fileChange/requestApproval': {
            const item = items.get(p.itemId);
            const paths = (item?.changes ?? []).map((c) => c.path).join('\n');
            const decision = await ask('修改文件', paths || p.reason || 'codex 请求写入文件') === 'allow' ? 'accept' : 'decline';
            respond(m.id, { decision });
            break;
          }
          case 'item/permissions/requestApproval': {
            // GrantedPermissionProfile 与请求的 RequestPermissionProfile 同形：
            // 允许 = 原样回批；拒绝 = 全空画像（字段可空，codex 视为未授予）
            const allow = await ask('扩展权限', `${p.reason ?? ''}\n${safeJson(p.permissions) || 'codex 请求额外文件/网络权限'}`) === 'allow';
            respond(m.id, allow ? { permissions: p.permissions ?? {}, scope: 'turn' } : { permissions: { fileSystem: null, network: null }, scope: 'turn' });
            break;
          }
          case 'execCommandApproval': // 旧版审批协议，decision 词汇不同
          case 'applyPatchApproval': {
            const detail = Array.isArray(p.command) ? p.command.join(' ') : (p.fileChanges ? Object.keys(p.fileChanges).join('\n') : '');
            const decision = await ask('运行命令', detail || 'codex 请求执行命令') === 'allow' ? 'approved' : 'denied';
            respond(m.id, { decision });
            break;
          }
          case 'mcpServer/elicitation/request':
            respond(m.id, { action: 'decline' });
            break;
          default:
            respondError(m.id, 'vela bridge 不支持该请求');
            break;
        }
      } catch {
        respondError(m.id, '审批处理失败');
      }
    };

    const handleLine = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method && msg.id != null) { onServerRequest(msg); return; }
      if (msg.id != null && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
        return;
      }
      if (msg.method) onNotification(msg.method, msg.params);
    };
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) handleLine(line);
      }
    });

    const init = await request('initialize', { clientInfo: { name: 'vela-bridge', version: 'codex-adapter' } });
    if (init.error || settled) { finish('error', `codex initialize 失败：${init.error?.message || '未知错误'}`); return; }

    const threadParams = { cwd, sandbox, approvalPolicy, ...(model ? { model } : {}) };
    let threadResp = null;
    if (session.agentSessionId) threadResp = await request('thread/resume', { threadId: session.agentSessionId, ...threadParams });
    if (!threadResp || threadResp.error) {
      // 新会话，或 resume 失败（线程被归档/清理）降级开新线程：历史丢失但本轮能继续
      threadResp = await request('thread/start', threadParams);
    }
    threadId = threadResp?.result?.thread?.id || '';
    if (!threadId || settled) {
      finish('error', `codex 会话建立失败：${threadResp?.error?.message || '未返回 threadId'}`);
      return;
    }
    session.agentSessionId = threadId;
    emit({ kind: 'session_info', agentSessionId: threadId });

    const turnParams = {
      threadId,
      input: [{ type: 'text', text }],
      // 知识库工作区等会话可读目录 → 追加为可写根，与 claude 的 additionalDirectories 对齐
      ...(contextDirs.length && sandbox !== 'danger-full-access'
        ? { sandboxPolicy: { type: 'workspaceWrite', writableRoots: contextDirs } }
        : {}),
    };
    const turnResp = await request('turn/start', turnParams);
    if (turnResp.error || settled) {
      finish('error', `codex turn 启动失败：${turnResp.error?.message || '未知错误'}`);
      return;
    }
    turnId = turnResp.result?.turn?.id || turnId;

    // turn/completed 到达（或取消/进程退出兜底）前挂起；hub 的 busy 等本 promise 落地
    await new Promise((resolve) => {
      const probe = setInterval(() => { if (settled) { clearInterval(probe); resolve(); } }, 100);
      child.once('exit', () => { clearInterval(probe); resolve(); });
    });
  },
};

// 起临时 app-server 拉 model/list（data[].id，过滤 hidden），10s 上限后杀进程
async function listModelsViaServer() {
  const child = spawnCodex(['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const timer = setTimeout(() => killTree(child), 10000);
  try {
    const ids = await new Promise((resolve, reject) => {
      let nextId = 1;
      const pending = new Map();
      let buf = '';
      const fail = (msg) => { reject(new Error(msg)); };
      child.on('error', (err) => fail(`codex 启动失败：${err.message}`));
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id != null && pending.has(msg.id)) {
            const done = pending.get(msg.id);
            pending.delete(msg.id);
            done(msg);
          }
        }
      });
      const request = (method, params) => new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      (async () => {
        const init = await request('initialize', { clientInfo: { name: 'vela-bridge', version: 'codex-adapter' } });
        if (init.error) return fail(`initialize 失败：${init.error?.message}`);
        const list = await request('model/list', { limit: 100 });
        if (list.error) return fail(`model/list 失败：${list.error?.message}`);
        const ids = (Array.isArray(list.result?.data) ? list.result.data : [])
          .filter((m) => m && typeof m.id === 'string' && !m.hidden)
          .map((m) => m.id);
        resolve(ids);
      })().catch(fail);
    });
    return ids;
  } finally {
    clearTimeout(timer);
    killTree(child);
  }
}
