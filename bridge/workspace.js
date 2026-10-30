// 工作区路径解析与上传管道：所有落盘都约束在 baseDir/<workspaceId> 之下。
// 与 session 生命周期解耦——知识库上传可能发生在会话建立之前（还没发过消息）。

import { existsSync, mkdirSync, createWriteStream, unlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_WORKSPACE_BASE = join(homedir(), '.vela-bridge', 'workspaces');

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ~ / ~/ / ~\ 开头展开为用户主目录（fs.check 与 cwdBase 共用）
export function expandTilde(p) {
  return String(p || '').trim().replace(/^~(?=[/\\]|$)/, homedir());
}

// workspaceId 只放行安全字符（conv:<uuid>），杜绝路径段注入；id 里的 ':' 在
// Windows 上是非法文件名字符（ADS 语法），映射为 '-' 作目录段名
function workspaceRootPath({ cwdBase, workspaceId }) {
  if (!workspaceId) throw err('bad-params', '缺少 workspaceId');
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(workspaceId)) throw err('bad-workspace', 'workspaceId 含非法字符');
  return join(expandTilde(cwdBase) || DEFAULT_WORKSPACE_BASE, workspaceId.replace(/:/g, '-'));
}

// 工作区根 = expandTilde(cwdBase || 默认)/workspaceId，建目录后返回绝对路径
export function resolveWorkspaceRoot({ cwdBase, workspaceId }) {
  const root = workspaceRootPath({ cwdBase, workspaceId });
  mkdirSync(root, { recursive: true });
  return root;
}

// 删除会话工作区（删除会话时调用）。幂等：目录不存在返回 removed:false。
export function removeWorkspaceRoot({ cwdBase, workspaceId }) {
  const root = workspaceRootPath({ cwdBase, workspaceId });
  if (!existsSync(root)) return { removed: false };
  rmSync(root, { recursive: true, force: true });
  return { removed: true };
}

// relPath 清洗：只接受 '/' 分隔的相对路径；拒绝绝对路径、盘符、'..' 段、反斜杠与空字节。
// 段内 Windows 保留字符替换为 '_'，段尾点/空格剥掉（落盘兼容）。
export function sanitizeRelPath(relPath) {
  const raw = String(relPath || '').trim();
  if (!raw) throw err('bad-path', '缺少 relPath');
  if (raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) {
    throw err('bad-path', 'relPath 必须是 / 分隔的相对路径');
  }
  if (/^[A-Za-z]:/.test(raw)) throw err('bad-path', 'relPath 不允许盘符');
  const parts = raw.split('/').map((s) => s.trim()).filter((s) => s && s !== '.');
  if (!parts.length) throw err('bad-path', 'relPath 为空');
  for (const p of parts) {
    if (p === '..') throw err('bad-path', 'relPath 不允许 ..');
  }
  return parts
    .map((p) => p.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || '_')
    .join('/');
}

// 上传状态机：begin 开流（wx 独占，重名自动加 “ -2” 后缀）→ chunk 写块 → end 落定。
// 超时闲置的上传由 sweep 清理，半成品尽力删除。
export function createUploadManager({ maxFileBytes = 200 * 1024 * 1024, idleMs = 10 * 60 * 1000 } = {}) {
  const active = new Map(); // uploadId -> { absPath, name, stream, bytes, lastActive }

  function begin({ cwdBase, workspaceId, relPath }) {
    const root = resolveWorkspaceRoot({ cwdBase, workspaceId });
    const clean = sanitizeRelPath(relPath);
    const dir = dirname(join(root, clean));
    mkdirSync(dir, { recursive: true });
    // 重名不覆盖：wx 独占创建，冲突按 “stem -N.ext” 从 -2 递增（≤100 次）
    let name = basename(clean);
    let absPath = join(dir, name);
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let i = 2; existsSync(absPath); i++) {
      if (i > 100) throw err('file-exists', '同名文件过多');
      name = ext ? `${stem} -${i}${ext}` : `${stem} -${i}`;
      absPath = join(dir, name);
    }
    const uploadId = 'u' + randomUUID().replace(/-/g, '').slice(0, 12);
    const stream = createWriteStream(absPath, { flags: 'wx' });
    const up = { absPath, name, stream, bytes: 0, lastActive: Date.now() };
    active.set(uploadId, up);
    // 流出错（磁盘满等）：移出表，后续 op 报 no-upload，等待中的 drain 以 close 兜底
    stream.on('error', () => {
      active.delete(uploadId);
      stream.destroy();
    });
    return { uploadId, path: absPath, name };
  }

  async function chunk(uploadId, b64) {
    const up = active.get(uploadId);
    if (!up) throw err('no-upload', '上传不存在或已结束');
    up.lastActive = Date.now();
    if (typeof b64 !== 'string') throw err('bad-params', '缺少 base64 数据');
    const buf = Buffer.from(b64, 'base64');
    if (up.bytes + buf.length > maxFileBytes) {
      await cancel(uploadId);
      throw err('too-large', `文件超过上限 ${maxFileBytes} 字节`);
    }
    up.bytes += buf.length;
    if (!up.stream.write(buf)) {
      // 背压：等 drain；流被销毁时 close 兜底，避免悬挂
      await new Promise((resolve) => {
        up.stream.once('drain', resolve);
        up.stream.once('close', resolve);
      });
    }
    return { bytes: up.bytes };
  }

  async function end(uploadId) {
    const up = active.get(uploadId);
    if (!up) throw err('no-upload', '上传不存在或已结束');
    active.delete(uploadId);
    await new Promise((resolve, reject) => {
      up.stream.once('error', reject);
      up.stream.end(() => {
        up.stream.off('error', reject);
        resolve();
      });
    });
    return { path: up.absPath, name: up.name, bytes: up.bytes };
  }

  // 幂等取消：销毁流 + 尽力删半成品（Windows 句柄延迟释放时删除可能失败，忽略）
  async function cancel(uploadId) {
    const up = active.get(uploadId);
    if (!up) return {};
    active.delete(uploadId);
    await new Promise((resolve) => {
      up.stream.once('close', resolve);
      up.stream.destroy();
    });
    try { unlinkSync(up.absPath); } catch { /* 已删或句柄未释放 */ }
    return {};
  }

  function sweep() {
    const now = Date.now();
    for (const [id, up] of active) {
      if (now - up.lastActive > idleMs) cancel(id).catch(() => {});
    }
  }

  return { begin, chunk, end, cancel, sweep };
}
