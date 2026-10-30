// 协议冒烟：进程内起 server + ws 客户端走一遍关键 op。node bridge/smoke.js
// 需先 npm i。agents.list 会真实探测本机 claude；不做真实 LLM 轮次。
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { WebSocket } from 'ws';
import { createHub } from './turn.js';
import { startServer } from './server.js';

const assert = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
};

const TOKEN = 'smoke-' + randomUUID().replace(/-/g, '');
const PORT = 39200 + Math.floor(Math.random() * 100);
const hub = createHub();
const { httpServer } = await startServer({ port: PORT, token: TOKEN, hub, bridgeVersion: 'smoke' });

function connect() {
  return new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: 'chrome-extension://smoke' });
}
const req = (ws, op, params) =>
  new Promise((resolve, reject) => {
    const id = 'r' + Math.random();
    const onMsg = (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id === id) {
        ws.off('message', onMsg);
        m.ok ? resolve(m.result) : reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, op, params }));
  });

// 错 token 不再断开：Origin 校验通过即自动配对，hello 响应下发当前 token
{
  const ws = connect();
  const res = await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ id: 'h1', op: 'hello', params: { token: 'wrong' } })));
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id === 'h1') resolve(m); });
  });
  assert('错 token 自动配对并回 token', res.ok === true && res.result?.token === TOKEN, JSON.stringify(res.result ?? res.error));
  const agents = await req(ws, 'agents.list', {});
  assert('配对后的连接可发请求', Array.isArray(agents.agents));
  ws.close();
}
// 错 Origin 必须被拒
{
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: 'https://evil.example' });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  const code = await closed;
  assert('非扩展 Origin 被拒', code === 4003, `close code=${code}`);
}

const ws = connect();
await new Promise((r) => ws.on('open', r));
const hello = await req(ws, 'hello', { token: TOKEN, v: 1 });
assert('hello 通过并回协议版本', hello.v === 1);

const { agents } = await req(ws, 'agents.list', {});
const claude = agents.find((a) => a.id === 'claude-code');
assert('探测到 claude code', !!claude && !!claude.version, claude ? `v=${claude.version} authed=${claude.authed}` : '未安装');

const fsHome = await req(ws, 'fs.check', { path: '~' });
assert('fs.check ~ 目录', fsHome.exists === true && fsHome.isDirectory === true, `home=${homedir()}`);
const fsBad = await req(ws, 'fs.check', { path: 'Z:/definitely/not/exist' });
assert('fs.check 不存在路径', fsBad.exists === false);

// fs.write：绝对路径与工作区三元组两条路都建父目录落盘；越界 relPath 被拒
const fsWriteTmp = mkdtempSync(join(tmpdir(), 'om-fw-'));
const fsWriteAbs = await req(ws, 'fs.write', { path: `${fsWriteTmp.replaceAll('\\', '/')}/sub/dir/note.md`, content: '# 标题\n正文' });
const fsWriteBytes = readFileSync(fsWriteAbs.path, 'utf8');
assert('fs.write 绝对路径写入', fsWriteAbs.bytes === Buffer.byteLength('# 标题\n正文', 'utf8') && fsWriteBytes === '# 标题\n正文', `path=${fsWriteAbs.path}`);
const fsWriteWs = await req(ws, 'fs.write', { cwdBase: fsWriteTmp, workspaceId: 'conv:smoke_ws-1', relPath: 'docs/summary.md', content: 'x' });
assert('fs.write 工作区三元组写入', fsWriteWs.path.includes('conv-smoke_ws-1') && existsSync(join(fsWriteTmp, 'conv-smoke_ws-1', 'docs', 'summary.md')), `path=${fsWriteWs.path}`);
const fsWriteEscape = await req(ws, 'fs.write', { cwdBase: fsWriteTmp, workspaceId: 'conv:smoke_ws-1', relPath: '../escape.md', content: 'x' }).catch((e) => e);
assert('fs.write 拒绝 .. relPath', fsWriteEscape.code === 'bad-path', fsWriteEscape.message);
const fsWriteHuge = await req(ws, 'fs.write', { path: `${fsWriteTmp}/huge.md`, content: 'x'.repeat(10 * 1024 * 1024 + 1) }).catch((e) => e);
assert('fs.write 超 10MiB 报 too-large', fsWriteHuge.code === 'too-large', fsWriteHuge.message);

const { sessionId } = await req(ws, 'session.new', { agentId: 'claude-code', cwd: '' });
assert('session.new 返回 id', String(sessionId).startsWith('s:'));

// model 参数透传：合法字符串接受，超长截断到 100（存 session.model，适配器消费）
const modelSession = await req(ws, 'session.new', {
  agentId: 'claude-code', cwd: '', model: 'claude-sonnet-4-5',
});
assert('session.new 接受 model 参数', String(modelSession.sessionId).startsWith('s:'));
const noAdapterModel = await req(ws, 'session.new', { agentId: 'nope', model: 'x' }).catch((e) => e);
assert('model 参数不影响未知 agent 报错', noAdapterModel.code === 'unknown-agent');

const badPrompt = await req(ws, 'session.prompt', { sessionId, text: '' }).catch((e) => e);
assert('空消息被拒', badPrompt.code === 'bad-params');
const noAdapter = await req(ws, 'session.new', { agentId: 'nope' }).catch((e) => e);
assert('未知 agent 被拒', noAdapter.code === 'unknown-agent');

// models.list：动态模型列表（适配器向背后 LLM 网关拉 /v1/models）。
// 结果取决于本机网络与鉴权环境：成功是数组（可为空），失败是错误帧——两种都算协议正常
const noAdapterModels = await req(ws, 'models.list', { agentId: 'nope' }).catch((e) => e);
assert('models.list 未知 agent 被拒', noAdapterModels.code === 'unknown-agent');
const modelList = await req(ws, 'models.list', { agentId: 'claude-code' }).catch((e) => e);
assert(
  'models.list 返回数组或网关错误',
  Array.isArray(modelList?.models) || modelList instanceof Error,
  Array.isArray(modelList?.models) ? `models=${modelList.models.length}` : modelList.message,
);

// 取消一个不存在的会话
const noCancel = await req(ws, 'session.cancel', { sessionId: 's:none' }).catch((e) => e);
assert('取消不存在会话报错', noCancel.code === 'no-session');

// ---- 会话工作区：baseDir/<workspaceId> 由 bridge 创建并作为 cwd 返回 ----
const tmpBase = mkdtempSync(join(tmpdir(), 'om-ws-'));
try {
  const wsSession = await req(ws, 'session.new', {
    agentId: 'claude-code', cwdBase: tmpBase, workspaceId: 'conv:smoke_ws-1',
  });
  const expectedRoot = join(tmpBase, 'conv-smoke_ws-1');
  assert(
    'workspaceId 会话的 cwd 指向 baseDir/<id> 且目录已创建',
    wsSession.cwd === expectedRoot && existsSync(expectedRoot),
    `cwd=${wsSession.cwd}`,
  );
  assert('session.new 返回 cwd', typeof wsSession.cwd === 'string' && wsSession.cwd.length > 0);
  assert('session.new 返回 workspacePath', wsSession.workspacePath === expectedRoot, `workspacePath=${wsSession.workspacePath}`);

  // ---- projectDir：绑定项目目录覆盖 cwd；工作区照常创建（上传仍落工作区） ----
  const projRoot = join(tmpBase, 'myproj');
  mkdirSync(projRoot, { recursive: true });
  const projWsRoot = join(tmpBase, 'conv-smoke_ws-2');
  const projSession = await req(ws, 'session.new', {
    agentId: 'claude-code', cwdBase: tmpBase, workspaceId: 'conv:smoke_ws-2', projectDir: projRoot,
  });
  assert(
    'projectDir 覆盖 cwd 且工作区照常创建',
    projSession.cwd === projRoot && existsSync(projWsRoot),
    `cwd=${projSession.cwd}`,
  );
  assert('绑定时 workspacePath 仍指工作区', projSession.workspacePath === projWsRoot, `workspacePath=${projSession.workspacePath}`);

  const badProj = await req(ws, 'session.new', {
    agentId: 'claude-code', cwdBase: tmpBase, workspaceId: 'conv:smoke_ws-3', projectDir: join(tmpBase, 'nope'),
  }).catch((e) => e);
  assert('projectDir 不存在报 bad-path', badProj.code === 'bad-path', `code=${badProj.code}`);

  const fileAsProj = await req(ws, 'session.new', {
    agentId: 'claude-code', cwdBase: tmpBase, workspaceId: 'conv:smoke_ws-3', projectDir: join(expectedRoot, 'knowledge', 'a.txt'),
  }).catch((e) => e);
  assert('projectDir 指向文件报 bad-path', fileAsProj.code === 'bad-path', `code=${fileAsProj.code}`);

  const badWs = await req(ws, 'session.new', {
    agentId: 'claude-code', cwdBase: tmpBase, workspaceId: 'a/b',
  }).catch((e) => e);
  assert('非法 workspaceId 被拒', badWs.code === 'bad-workspace', `code=${badWs.code}`);

  // ---- 分块上传全链路：begin → chunk → end，读回校验 ----
  const up = await req(ws, 'upload.begin', { cwdBase: tmpBase, workspaceId: 'conv:smoke_ws-1', relPath: 'knowledge/a.txt' });
  assert('upload.begin 返回 uploadId 与落盘名', typeof up.uploadId === 'string' && up.name === 'a.txt', `name=${up.name}`);
  await req(ws, 'upload.chunk', { uploadId: up.uploadId, b64: Buffer.from('hello ').toString('base64') });
  await req(ws, 'upload.chunk', { uploadId: up.uploadId, b64: Buffer.from('上传').toString('base64') });
  const done = await req(ws, 'upload.end', { uploadId: up.uploadId });
  const written = readFileSync(join(expectedRoot, 'knowledge', 'a.txt'));
  assert(
    '上传内容逐字节一致（含多字节 UTF-8）',
    written.equals(Buffer.from('hello 上传')) && done.bytes === written.length,
    `bytes=${done.bytes}`,
  );
  assert('end 返回绝对路径', done.path === join(expectedRoot, 'knowledge', 'a.txt'), done.path);

  // relPath 逃逸一律拒绝
  for (const bad of ['../escape.txt', '/abs.txt', 'C:\\x.txt', 'a/../b.txt']) {
    const e = await req(ws, 'upload.begin', { cwdBase: tmpBase, workspaceId: 'conv:smoke_ws-1', relPath: bad }).catch((er) => er);
    assert(`relPath 逃逸被拒（${bad}）`, e.code === 'bad-path', `code=${e.code}`);
  }

  // 未知 / 已结束的 uploadId
  const noUpload = await req(ws, 'upload.chunk', { uploadId: 'nope', b64: '' }).catch((e) => e);
  assert('未知 uploadId 报 no-upload', noUpload.code === 'no-upload');
  const endedAgain = await req(ws, 'upload.end', { uploadId: up.uploadId }).catch((e) => e);
  assert('已结束上传再 end 报 no-upload', endedAgain.code === 'no-upload');

  // 重名自动后缀：同 relPath 二次 begin → 'a -2.txt'，不覆盖已上传文件
  const up2 = await req(ws, 'upload.begin', { cwdBase: tmpBase, workspaceId: 'conv:smoke_ws-1', relPath: 'knowledge/a.txt' });
  await req(ws, 'upload.chunk', { uploadId: up2.uploadId, b64: Buffer.from('second').toString('base64') });
  const done2 = await req(ws, 'upload.end', { uploadId: up2.uploadId });
  assert('重名文件自动加后缀', done2.name === 'a -2.txt' && existsSync(join(expectedRoot, 'knowledge', 'a -2.txt')), done2.name);
  assert('原文件未被覆盖', readFileSync(join(expectedRoot, 'knowledge', 'a.txt')).equals(Buffer.from('hello 上传')));

  // 上传半途取消：半成品删除
  const up3 = await req(ws, 'upload.begin', { cwdBase: tmpBase, workspaceId: 'conv:smoke_ws-1', relPath: 'knowledge/c.bin' });
  await req(ws, 'upload.chunk', { uploadId: up3.uploadId, b64: Buffer.alloc(1024, 7).toString('base64') });
  await req(ws, 'upload.cancel', { uploadId: up3.uploadId });
  assert('取消后半成品已删除', !existsSync(join(expectedRoot, 'knowledge', 'c.bin')));

  // ---- fs.list：目录优先、隐藏项过滤、parent 可回上级 ----
  const listing = await req(ws, 'fs.list', { path: tmpBase });
  assert(
    'fs.list 返回上级与条目',
    listing.parent === dirname(tmpBase) && Array.isArray(listing.entries) && listing.truncated === false,
    `entries=${listing.entries.length}`,
  );
  const wsEntry = listing.entries.find((e) => e.name === 'conv-smoke_ws-1');
  assert(
    'fs.list 条目含工作区目录且目录优先排序',
    !!wsEntry && wsEntry.isDirectory === true && listing.entries[0].isDirectory === true,
  );
  assert('fs.list 条目带绝对路径', wsEntry.path === join(tmpBase, 'conv-smoke_ws-1'));
  const listBad = await req(ws, 'fs.list', { path: 'Z:/definitely/not/exist' }).catch((e) => e);
  assert('fs.list 不可读路径报 bad-path', listBad.code === 'bad-path', `code=${listBad.code}`);

  // 盘根列出所有存在的盘符（含当前盘），跨盘浏览不困在 C 盘
  const driveRoot = /^[A-Za-z]:[\\/]/.exec(expectedRoot)?.[0] ?? 'C:\\';
  const rootListing = await req(ws, 'fs.list', { path: driveRoot });
  const driveEntries = rootListing.entries.filter((e) => /^[A-Z]:$/.test(e.name));
  assert(
    'fs.list 盘根列盘符且钉在最前',
    rootListing.path.endsWith('\\')
      && driveEntries.some((e) => e.path === driveRoot)
      && driveEntries.every((e) => rootListing.entries.indexOf(e) < driveEntries.length),
    `drives=${driveEntries.map((e) => e.name).join(',')}`,
  );

  // ---- workspace.remove：删会话工作区，幂等 ----
  const removed = await req(ws, 'workspace.remove', { cwdBase: tmpBase, workspaceId: 'conv:smoke_ws-1' });
  assert('workspace.remove 删除目录', removed.removed === true && !existsSync(expectedRoot));
  const removedAgain = await req(ws, 'workspace.remove', { cwdBase: tmpBase, workspaceId: 'conv:smoke_ws-1' });
  assert('workspace.remove 幂等', removedAgain.removed === false);
  const badRemove = await req(ws, 'workspace.remove', { cwdBase: tmpBase, workspaceId: '../evil' }).catch((e) => e);
  assert('workspace.remove 拒绝非法 id', badRemove.code === 'bad-workspace', `code=${badRemove.code}`);

  // ---- bridge.shutdown：回 ok 后关连接、关服务句柄（smoke 不传 onShutdown，默认只关不退进程）----
  const shutdownWs = connect();
  await new Promise((r) => shutdownWs.on('open', r));
  await req(shutdownWs, 'hello', { token: TOKEN });
  let shutdownClosed = false;
  shutdownWs.on('close', () => { shutdownClosed = true; });
  const shutdownRes = await req(shutdownWs, 'bridge.shutdown', {});
  assert('bridge.shutdown 回 ok', shutdownRes.ok === true);
  await new Promise((r) => setTimeout(r, 500));
  assert('bridge.shutdown 后连接关闭', shutdownClosed === true);
} finally {
  rmSync(tmpBase, { recursive: true, force: true });
}

ws.close();
// bridge.shutdown 用例已把服务句柄关掉（smoke 不退进程）：重复 close 不报错
httpServer.close(() => {});
console.log('smoke 完成');
