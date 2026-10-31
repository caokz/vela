// 把 bridge 的 fs.* 包装成与 File System Access 句柄同形的「虚拟句柄」：
// LLM 任务的文件工具（list / search / read / write / edit / skill）只认 entries() /
// getFileHandle() / getDirectoryHandle() / getFile() / createWritable()，包一层之后
// 对 bridge 管的本机路径原样可用——不需要浏览器弹文件选择框（聊天卡里弹不了），
// 也没有授权过期问题。路径本身是知识库里 kind:'local' 的绝对路径条目。
//
// 读：fs.read（整文件 base64，30MiB 上限）；列目录：fs.list（hidden + stat）；
// 写：createWritable 缓冲文本，close 时 fs.write（≤10MiB，父目录自动创建）。

const err = (name, message) => Object.assign(new Error(message || name), { name });

// 子路径：沿用父路径里的分隔符风格（Windows 反斜杠 / POSIX 斜杠）
const join = (parent, name) => `${parent.replace(/[\\/]+$/, '')}${parent.includes('\\') ? '\\' : '/'}${name}`;
export const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);

class LazyFile {
  constructor(client, path, name, meta) {
    this.client = client;
    this.path = path;
    this.name = name;
    this.size = meta.size ?? 0;
    this.lastModified = Math.round(meta.mtimeMs ?? 0);
  }
  async arrayBuffer() {
    const r = await this.client.fsRead(this.path);
    const bin = atob(r.b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
  async text() { return new TextDecoder().decode(await this.arrayBuffer()); }
}

class BridgeFile {
  constructor(client, path, name, meta = null) {
    this.kind = 'file';
    this.name = name;
    this.client = client;
    this.path = path;
    this.meta = meta;
  }
  async getFile() {
    let meta = this.meta;
    if (!meta) {
      const r = await this.client.fsCheck(this.path);
      if (!r.exists || r.isDirectory) throw err('NotFoundError', `找不到 ${this.path}`);
      meta = this.meta = r;
    }
    return new LazyFile(this.client, this.path, this.name, meta);
  }
  async createWritable() {
    let buf = '';
    return {
      write: async (s) => { buf += String(s); },
      close: async () => {
        await this.client.fsWrite({ path: this.path, content: buf });
        this.meta = null; // 写后大小 / 修改时间已变，下次重新取
      },
    };
  }
}

class BridgeDir {
  constructor(client, path, name) {
    this.kind = 'directory';
    this.name = name;
    this.client = client;
    this.path = path;
    this.truncated = false; // 上次 entries() 是否被 bridge 截断（walk 据此提示「没列全」）
  }
  async *entries() {
    const r = await this.client.fsList(this.path, { hidden: true, stat: true, limit: 20000 });
    this.truncated = !!r.truncated;
    for (const e of r.entries) {
      if (/^[A-Za-z]:\\?$/.test(e.name)) continue; // 盘根的盘符导航项
      yield [e.name, e.isDirectory
        ? new BridgeDir(this.client, e.path, e.name)
        : new BridgeFile(this.client, e.path, e.name, { size: e.size ?? 0, mtimeMs: e.mtimeMs ?? 0 })];
    }
  }
  async getFileHandle(name, { create = false } = {}) {
    const path = join(this.path, name);
    const r = await this.client.fsCheck(path);
    if (r.exists && r.isDirectory) throw err('TypeMismatchError');
    if (!r.exists && !create) throw err('NotFoundError');
    return new BridgeFile(this.client, path, name, r.exists ? r : { size: 0, mtimeMs: 0 });
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    const path = join(this.path, name);
    const r = await this.client.fsCheck(path);
    if (r.exists && !r.isDirectory) throw err('TypeMismatchError');
    // create：目录在首次写入文件时由 bridge 的 fs.write 自动创建，这里只返回虚拟句柄
    if (!r.exists && !create) throw err('NotFoundError');
    return new BridgeDir(this.client, path, name);
  }
}

/**
 * 知识库里 kind:'local'（bridge 绝对路径）的条目 → 工具用的 roots。
 * bridge 未连接 / 路径已不存在的条目跳过，原因在 skipped 里返回。
 * @returns {{ roots: Array<{id,name,handle,kind}>, skipped: Array<{ name, reason }> }}
 */
export async function loadBridgeRoots(client, knowledge, usedNames = new Set()) {
  const entries = (knowledge ?? []).filter((k) => k?.kind === 'local' && k.path);
  if (!entries.length) return { roots: [], skipped: [] };
  try {
    await client.ensureReady();
  } catch (e) {
    return { roots: [], skipped: entries.map((k) => ({ name: baseName(k.path), reason: `bridge 未连接：${e.message}` })) };
  }
  const roots = [];
  const skipped = [];
  for (const k of entries) {
    let name = baseName(k.path);
    try {
      const r = await client.fsCheck(k.path);
      if (!r.exists) { skipped.push({ name, reason: '路径不存在' }); continue; }
      for (let i = 2; usedNames.has(name); i++) name = `${baseName(k.path)}（${i}）`;
      usedNames.add(name);
      roots.push({
        id: k.id, name, kind: r.isDirectory ? 'dir' : 'file',
        handle: r.isDirectory ? new BridgeDir(client, k.path, name) : new BridgeFile(client, k.path, baseName(k.path), r),
      });
    } catch (e) {
      skipped.push({ name, reason: e.message });
    }
  }
  return { roots, skipped };
}
