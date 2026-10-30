// WS 服务：鉴权（hello token）、Origin 校验、请求/响应 id 配对、op 分发。
// 帧格式：
//   客户端→bridge  {id, op, params}
//   bridge→客户端  {id, ok, result} / {id, ok:false, error:{code,message}} / {type:'event', sessionId, seq, event}

import { createServer as createHttpServer } from 'node:http';
import { stat, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { getAdapter, listAgents } from './agents/registry.js';
import { expandTilde, resolveWorkspaceRoot, removeWorkspaceRoot, sanitizeRelPath, createUploadManager } from './workspace.js';

const PROTOCOL_VERSION = 1;

// 盘符列表：并行探测 + 单盘 250ms 超时 + 60s 缓存。
// 断连的网络映射盘/空读卡器单次 stat 可阻塞数秒，串行探测会把盘根目录列表整个拖住
//（盘根是浏览器高频路径，每次 fs.list 都要探测）；超时的盘先不列出，路径跳转仍可直达。
const DRIVE_PROBE_MS = 250;
const DRIVE_CACHE_MS = 60_000;
let driveCache = { at: 0, drives: [] };

async function probeDrives() {
  if (Date.now() - driveCache.at < DRIVE_CACHE_MS) return driveCache.drives;
  const exists = await Promise.all(
    Array.from({ length: 26 }, (_, i) => {
      const drive = `${String.fromCharCode(65 + i)}:\\`;
      return Promise.race([
        stat(drive).then(() => true, () => false),
        new Promise((r) => setTimeout(() => r(false), DRIVE_PROBE_MS)),
      ]);
    }),
  );
  const drives = exists.reduce((acc, ok, i) => {
    if (ok) acc.push({ name: `${String.fromCharCode(65 + i)}:`, path: `${String.fromCharCode(65 + i)}:\\`, isDirectory: true });
    return acc;
  }, []);
  driveCache = { at: Date.now(), drives };
  return drives;
}

export function startServer({ port, token, hub, bridgeVersion, onShutdown }) {
  const httpServer = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ bridge: 'vela', version: bridgeVersion }));
  });

  const wss = new WebSocketServer({ server: httpServer });

  // 上传管道与 session 解耦（知识库上传可发生在建会话之前）；闲置上传定期清理
  const uploads = createUploadManager();
  setInterval(() => uploads.sweep(), 60_000).unref();

  wss.on('connection', (ws, req) => {
    // Origin 校验：只放行 chrome-extension://（token 是第二道门）
    const origin = req.headers.origin || '';
    if (!origin.startsWith('chrome-extension://')) {
      ws.close(4003, 'origin not allowed');
      return;
    }
    let authed = false;

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!authed) {
        if (msg.op !== 'hello') {
          ws.close(4001, 'auth failed');
          return;
        }
        // token 匹配直接放行；缺失/不匹配走自动配对：连接已过 chrome-extension://
        // Origin 校验，网页进不来；本地进程本就能读 token.json，token 防的是网页。
        // 对扩展下发当前 token（客户端存下，下次带对 token 即走快路径）
        const matched = msg.params?.token === token;
        authed = true;
        send(ws, { id: msg.id, ok: true, result: { v: PROTOCOL_VERSION, bridgeVersion, ...(matched ? {} : { token }) } });
        return;
      }
      try {
        const result = await dispatch(msg.op, msg.params ?? {}, ws);
        send(ws, { id: msg.id, ok: true, result: result ?? {} });
      } catch (err) {
        send(ws, {
          id: msg.id,
          ok: false,
          error: { code: err.code || 'internal', message: err.message || String(err) },
        });
      }
    });
  });

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  hub.attachBroadcast((frame) => {
    const data = JSON.stringify(frame);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  });

  async function dispatch(op, params) {
    switch (op) {
      case 'ping':
        return {};
      case 'agents.list':
        return { agents: await listAgents() };
      case 'models.list': {
        // 模型下拉的动态选项来源：适配器向自己背后的 LLM 网关拉 /v1/models。
        // 适配器未实现（如某些 CLI agent）或网关不支持时返回空列表，前端回退预设
        const adapter = getAdapter(params.agentId);
        if (!adapter) throw err('unknown-agent', `未知 agent: ${params.agentId}`);
        const models = typeof adapter.listModels === 'function' ? await adapter.listModels() : [];
        return { models };
      }
      case 'session.new': {
        if (!getAdapter(params.agentId)) throw err('unknown-agent', `未知 agent: ${params.agentId}`);
        const dirs = await resolveSessionDirs(params);
        const session = hub.create({
          agentId: params.agentId,
          ...dirs,
          permissionMode: params.permissionMode || 'default',
          model: typeof params.model === 'string' ? params.model.trim().slice(0, 100) : '',
        });
        return { sessionId: session.id, cwd: session.cwd, workspacePath: dirs.workspacePath };
      }
      case 'session.resume': {
        if (!params.agentSessionId) throw err('bad-params', '缺少 agentSessionId');
        if (!getAdapter(params.agentId)) throw err('unknown-agent', `未知 agent: ${params.agentId}`);
        const dirs = await resolveSessionDirs(params);
        const session = hub.create({
          agentId: params.agentId,
          ...dirs,
          permissionMode: params.permissionMode || 'default',
          model: typeof params.model === 'string' ? params.model.trim().slice(0, 100) : '',
        });
        session.agentSessionId = params.agentSessionId;
        return { sessionId: session.id, cwd: session.cwd, workspacePath: dirs.workspacePath };
      }
      case 'session.prompt':
        return runTurn(params);
      case 'session.cancel': {
        const session = hub.get(params.sessionId);
        if (!session) throw err('no-session', '会话不存在');
        session.abort?.abort();
        return { ok: true };
      }
      case 'permission.respond': {
        const session = hub.get(params.sessionId);
        if (!session) throw err('no-session', '会话不存在');
        if (!hub.respondPermission(session, params.requestId, params.outcome)) {
          throw err('no-request', '审批请求不存在或已落地');
        }
        return { ok: true };
      }
      case 'events.replay': {
        const session = hub.get(params.sessionId);
        if (!session) throw err('no-session', '会话不存在');
        return { events: hub.replay(session, params.fromSeq || 0) };
      }
      case 'upload.begin':
        return uploads.begin(params);
      case 'upload.chunk':
        return uploads.chunk(params.uploadId, params.b64);
      case 'upload.end':
        return uploads.end(params.uploadId);
      case 'upload.cancel':
        return uploads.cancel(params.uploadId);
      case 'fs.check': {
        const target = expandTilde(String(params.path || ''));
        if (!target) throw err('bad-params', '缺少 path');
        try {
          const st = await stat(target);
          return { exists: true, isDirectory: st.isDirectory() };
        } catch {
          return { exists: false, isDirectory: false };
        }
      }
      case 'fs.list': {
        // 知识库面板的本机目录浏览器：bridge 有 fs 权限，扩展页没有——
        // 浏览真实路径勾选，零拷贝引用。目录优先、字母序，超 1000 条截断
        const target = expandTilde(String(params.path || ''));
        if (!target) throw err('bad-params', '缺少 path');
        const abs = resolve(target);
        // 盘符探测与目录枚举并行，互不等待
        const drivesPromise = /^[A-Za-z]:[\\/]?$/.test(abs) ? probeDrives() : null;
        let dirents;
        try {
          dirents = await readdir(abs, { withFileTypes: true });
        } catch (e) {
          throw err('bad-path', `无法读取目录：${e.message}`);
        }
        // symlink 归类（stat 目标）并行做，避免目录里 junction/链接多时逐个串行
        const entries = (await Promise.all(
          dirents
            .filter((d) => !d.name.startsWith('.') && !d.name.startsWith('$')) // 隐藏/系统噪音
            .map(async (d) => {
              let isDirectory = d.isDirectory();
              if (d.isSymbolicLink()) {
                try { isDirectory = (await stat(join(abs, d.name))).isDirectory(); } catch { return null; }
              }
              return { name: d.name, path: join(abs, d.name), isDirectory };
            }),
        )).filter(Boolean);
        // Windows 盘根之上没有父目录，上级按钮到顶即困在当前盘：
        // 在盘根把所有存在的盘符列为可进入目录项，供跨盘浏览
        const drives = drivesPromise ? await drivesPromise : [];
        entries.sort((a, b) => (Number(b.isDirectory) - Number(a.isDirectory)) || a.name.localeCompare(b.name));
        // 盘符钉在最前：localeCompare 把 ':' 当可忽略标点，混排会被中文/字母目录埋掉
        entries.unshift(...drives);
        const truncated = entries.length > 1000;
        if (truncated) entries.length = 1000;
        return { path: abs, parent: dirname(abs), entries, truncated };
      }
      case 'fs.write': {
        // 一次性小文件写入（会话导出）：path 为绝对/~ 路径，或走与 upload 一致的
        // 工作区三元组 cwdBase+workspaceId+relPath。父目录自动创建，覆盖同名文件
        const content = typeof params.content === 'string' ? params.content : '';
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > 10 * 1024 * 1024) throw err('too-large', '内容超过 10 MiB 上限');
        let target;
        if (params.path) {
          target = resolve(expandTilde(String(params.path)));
        } else if (params.workspaceId && params.relPath) {
          const root = resolveWorkspaceRoot({ cwdBase: params.cwdBase, workspaceId: params.workspaceId });
          target = resolve(root, sanitizeRelPath(params.relPath));
        } else {
          throw err('bad-params', '缺少 path 或 workspaceId/relPath');
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
        return { path: target, bytes };
      }
      case 'workspace.remove':
        // 删除会话时清掉 baseDir/<workspaceId> 工作区（幂等）
        return removeWorkspaceRoot(params);
      case 'bridge.shutdown': {
        // 设置页「停止」按钮。先回 ok 再停，保证响应帧发出去了；
        // onShutdown 不传时默认只关服务句柄（内嵌测试用，不退进程）
        setTimeout(() => {
          if (onShutdown) onShutdown();
          else {
            for (const client of wss.clients) client.close();
            wss.close();
            httpServer.close();
          }
        }, 100);
        return { ok: true };
      }
      default:
        throw err('bad-op', `未知操作: ${op}`);
    }
  }

  // 会话目录：workspaceId 优先（bridge 侧解析 baseDir/<workspaceId> 并 mkdir，
  // 路径分隔符 / ~ 展开都在本机做），旧参数 cwd 保留兼容；contextDirs 逐条 ~ 展开。
  // projectDir（会话绑定的项目目录）存在时覆盖 cwd；工作区照常创建（上传/知识库
  // 仍落工作区），并追加进 contextDirs，agent 免审批读取上传件。
  async function resolveSessionDirs(params) {
    const workspacePath = params.workspaceId
      ? resolveWorkspaceRoot({ cwdBase: params.cwdBase, workspaceId: params.workspaceId })
      : '';
    let cwd = workspacePath || (params.cwd || '');
    const contextDirs = (Array.isArray(params.contextDirs) ? params.contextDirs : [])
      .map((d) => expandTilde(String(d || '')))
      .filter(Boolean);
    if (params.projectDir) {
      const p = resolve(expandTilde(String(params.projectDir)));
      let st;
      try {
        st = await stat(p);
      } catch {
        throw err('bad-path', `项目目录不存在: ${p}`);
      }
      if (!st.isDirectory()) throw err('bad-path', `项目目录不是目录: ${p}`);
      cwd = p;
      if (workspacePath && !contextDirs.includes(workspacePath)) contextDirs.push(workspacePath);
    }
    return { cwd, contextDirs, workspacePath };
  }

  // prompt 即开 turn：busy 守卫 → abort 接线 → 适配器跑完自动落 busy=false。
  // 适配器保证发 turn_end，busy 复位不依赖调用方。
  function runTurn({ sessionId, text }) {
    const session = hub.get(sessionId);
    if (!session) throw err('no-session', '会话不存在');
    if (session.busy) throw err('busy', '上一轮还没结束');
    const adapter = getAdapter(session.agentId);
    if (!adapter) throw err('unknown-agent', `未知 agent: ${session.agentId}`);
    if (!text || !String(text).trim()) throw err('bad-params', '消息为空');

    const abort = new AbortController();
    session.abort = abort;
    session.busy = true;
    adapter
      .startTurn(session, String(text), {
        emit: (event) => hub.emit(session, event),
        signal: abort.signal,
        onPermission: (req) => hub.requestPermission(session, req),
      })
      .finally(() => {
        session.busy = false;
        session.abort = null;
      });
    return { accepted: true };
  }

  return new Promise((resolve, reject) => {
    httpServer.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const e = new Error(`端口 ${port} 已被占用（bridge 可能已在运行）；换端口用 --port`);
        e.code = 'port-in-use';
        reject(e);
      } else reject(err);
    });
    httpServer.listen(port, '127.0.0.1', () => resolve({ httpServer, wss }));
  });
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
