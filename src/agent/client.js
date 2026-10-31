// agent bridge WS 客户端：每页一个单例。请求/响应按 id 配对，事件帧回调分发。
// 断线指数退避重连（1s 起、10s 封顶）；重连成功后由调用方按需 events.replay 补帧。
// 运行上下文：聊天卡 / 侧边栏 / 独立聊天页（扩展页面连 ws://127.0.0.1 不受 MV3 CSP 限制）。

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const REQUEST_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 10000;

import { loadSettings, saveSettings } from '../llm/store.js';
import { isCtxInvalid } from '../util/ctx-guard.js';

let singleton = null;

export function getAgentClient({ onEvent, onStatus }) {
  if (!singleton) singleton = createClient();
  if (onEvent) singleton.eventListeners.add(onEvent);
  if (onStatus) singleton.statusListeners.add(onStatus);
  return singleton;
}

export function dropAgentClient({ onEvent, onStatus }) {
  if (!singleton) return;
  if (onEvent) singleton.eventListeners.delete(onEvent);
  if (onStatus) singleton.statusListeners.delete(onStatus);
}

function createClient() {
  const client = {
    eventListeners: new Set(),
    statusListeners: new Set(),
    status: 'disconnected', // disconnected | connecting | ready | error
    _ws: null,
    _seq: 0,
    _pending: new Map(), // id -> {resolve, reject, timer}
    _retry: 0,
    _retryTimer: 0,
    _closedByUs: false,
    _url: '',
    _token: '',
    _wantConnected: false,

    _setStatus(s) {
      if (client.status === s) return;
      client.status = s;
      for (const fn of [...client.statusListeners]) safeCall(fn, s);
    },

    // 连接（已连接则复用）。hello 通过后才算 ready；失败 reject 且不再自动重连。
    // 单飞：connecting 期间的后续调用复用同一就绪 promise，避免重复握手。
    ensureReady() {
      client._wantConnected = true;
      if (client.status === 'ready') return Promise.resolve();
      if (client._readyPromise) return client._readyPromise;
      const p = client._readyPromise = new Promise((resolve, reject) => {
        client._readyResolve = resolve;
        client._readyReject = reject;
      });
      if (client.status !== 'connecting') client._open();
      return p;
    },

    async _open() {
      // 守卫：已 ready / 已在连接就直接返回——重连定时器迟到触发时不能
      // 替换活连接（会把 ready 翻回 connecting，撞上请求帧发不出去）
      if (client.status === 'ready' || client.status === 'connecting') return;
      let s;
      try {
        s = await loadSettings();
      } catch (e) {
        // 扩展被重新加载 / 更新后旧页面的 chrome.* 全部失效：别再重连，否则定时器每次重试都抛一条未捕获异常
        if (isCtxInvalid(e)) {
          client._wantConnected = false;
          clearTimeout(client._retryTimer);
          client._failReady('扩展已更新，请刷新页面');
          return;
        }
        throw e;
      }
      if (client.status === 'ready' || client.status === 'connecting') return; // await 期间别人已开工
      client._url = s.agentBridge.url;
      client._token = s.agentBridge.token;
      client._closedByUs = false; // 开新连接，之前的主动关闭不再适用
      clearTimeout(client._retryTimer);
      client._setStatus('connecting');
      try {
        const ws = new WebSocket(client._url);
        client._ws = ws;
        // 连接超时兜底：端口被防火墙静默丢包时 onclose 可能很久不来
        const connectTimer = setTimeout(() => { try { ws.close(); } catch { /* 已关 */ } }, CONNECT_TIMEOUT_MS);
        ws.onopen = () => {
          clearTimeout(connectTimer);
          client._request('hello', { token: client._token, v: 1 })
            .then((res) => {
              // 自动配对：token 缺失/不匹配时 bridge 在 hello 响应里下发当前 token，落盘复用
              if (res?.token && res.token !== client._token) {
                client._token = res.token;
                loadSettings()
                  .then((cur) => saveSettings({ ...cur, agentBridge: { ...cur.agentBridge, token: res.token } }))
                  .catch(() => { /* 配对结果写不进 storage 不影响本次连接 */ });
              }
              client._retry = 0;
              client._setStatus('ready');
              client._readyResolve?.();
            })
            .catch((err) => {
              ws.close();
              client._failReady(err.message);
            });
        };
        ws.onmessage = (ev) => client._onMessage(ev.data);
        ws.onclose = () => {
          clearTimeout(connectTimer);
          client._ws = null;
          client._rejectAll('连接已断开');
          if (client._closedByUs) return;
          const wasReady = client.status === 'ready';
          client._setStatus(wasReady ? 'disconnected' : 'error');
          // 本次 ensureReady 明确失败：不 settle 会让调用方永久挂起（重连由 _scheduleReconnect 接管）
          const reject = client._readyReject;
          client._readyPromise = null;
          client._readyReject = null;
          client._readyResolve = null;
          reject?.(new Error(wasReady ? 'bridge 连接已断开，正在自动重连' : 'bridge 连接失败：请确认 bridge 已启动'));
          client._scheduleReconnect();
        };
        ws.onerror = () => { /* onclose 跟进，这里不重复处理 */ };
      } catch (err) {
        client._failReady(err.message);
      }
    },

    _failReady(message) {
      client._setStatus('error');
      const reject = client._readyReject;
      client._readyPromise = null;
      client._readyReject = null;
      client._readyResolve = null;
      reject?.(new Error(message));
    },

    _scheduleReconnect() {
      if (!client._wantConnected) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** client._retry, RECONNECT_MAX_MS);
      client._retry += 1;
      client._retryTimer = setTimeout(() => client._open(), delay);
    },

    _onMessage(raw) {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === 'event') {
        for (const fn of [...client.eventListeners]) safeCall(fn, m);
        return;
      }
      const pending = m.id ? client._pending.get(m.id) : null;
      if (!pending) return;
      clearTimeout(pending.timer);
      client._pending.delete(m.id);
      if (m.ok) pending.resolve(m.result);
      else pending.reject(Object.assign(new Error(m.error?.message || 'bridge 错误'), { code: m.error?.code }));
    },

    _rejectAll(message) {
      for (const [, p] of client._pending) {
        clearTimeout(p.timer);
        p.reject(new Error(message));
      }
      client._pending.clear();
    },

    _request(op, params, timeoutMs = REQUEST_TIMEOUT_MS) {
      const ws = client._ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('bridge 未连接'));
      const id = `r${++client._seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          client._pending.delete(id);
          reject(new Error(`bridge 响应超时：${op}`));
        }, timeoutMs);
        client._pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, op, params }));
      });
    },

    listAgents() { return client._request('agents.list', {}); },
    listModels(agentId) { return client._request('models.list', { agentId }); },
    newSession(params) { return client._request('session.new', params); },
    resumeSession(params) { return client._request('session.resume', params); },
    prompt(sessionId, text) { return client._request('session.prompt', { sessionId, text }); },
    cancel(sessionId) { return client._request('session.cancel', { sessionId }); },
    respondPermission(sessionId, requestId, outcome) {
      return client._request('permission.respond', { sessionId, requestId, outcome });
    },
    replay(sessionId, fromSeq) { return client._request('events.replay', { sessionId, fromSeq }); },
    fsCheck(path) { return client._request('fs.check', { path }); },
    // opts.hidden：保留点号目录；opts.stat：条目附带 size / mtimeMs（LLM 文件工具用）
    fsList(path, opts = {}) { return client._request('fs.list', { path, ...opts }); },
    fsRead(path, maxBytes) { return client._request('fs.read', { path, ...(maxBytes ? { maxBytes } : {}) }); },
    // 一次性写入小文件（会话导出）：{path} 或 {cwdBase, workspaceId, relPath}
    fsWrite(params) { return client._request('fs.write', params); },
    removeWorkspace(params) { return client._request('workspace.remove', params); },
    // 停止 bridge：发出后服务端回 ok 即断连，调用方预期 onStatus 变 disconnected，
    // 不要把随后的断连当错误处理
    shutdownBridge() { return client._request('bridge.shutdown', {}); },
    uploadBegin(params) { return client._request('upload.begin', params); },
    uploadChunk(uploadId, b64) { return client._request('upload.chunk', { uploadId, b64 }); },
    uploadEnd(uploadId) { return client._request('upload.end', { uploadId }); },
    uploadCancel(uploadId) { return client._request('upload.cancel', { uploadId }).catch(() => {}); },

    // 分块上传一个 File/Blob 到会话工作区：768 KiB 原始块 → ~1 MiB base64 帧，
    // 逐块确认（ws maxPayload 100 MiB 内从容）。失败时尽力取消清理半成品后上抛。
    // 返回 { path: 绝对路径, name: 实际落盘名（重名时 bridge 会加后缀） }。
    // overwrite=true：原名覆盖（知识库目录增量同步），默认重名加后缀
    async uploadFile({ cwdBase, workspaceId, relPath, file, onProgress, overwrite = false }) {
      await client.ensureReady();
      const { uploadId, path, name } = await client.uploadBegin({ cwdBase, workspaceId, relPath, ...(overwrite ? { overwrite: true } : {}) });
      try {
        const CHUNK = 768 * 1024;
        const total = file.size;
        for (let off = 0; off < total; off += CHUNK) {
          const buf = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
          await client.uploadChunk(uploadId, u8ToBase64(buf));
          onProgress?.(Math.min(off + CHUNK, total), total);
        }
        if (!total) await client.uploadChunk(uploadId, ''); // 空文件也过一遍，保证落盘
        const r = await client.uploadEnd(uploadId);
        return { path: r.path, name: r.name ?? name };
      } catch (e) {
        await client.uploadCancel(uploadId);
        throw e;
      }
    },

    close() {
      client._wantConnected = false;
      clearTimeout(client._retryTimer);
      client._closedByUs = true;
      client._ws?.close();
      client._ws = null;
      client._rejectAll('客户端关闭');
      client._setStatus('disconnected');
    },
  };
  return client;
}

function safeCall(fn, arg) {
  try { fn(arg); } catch (e) { console.error('[Vela] agent 回调出错:', e); }
}

// Uint8Array → base64：按 0x8000 字节分片再 btoa，避免 fromCharCode.apply 爆栈
function u8ToBase64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
