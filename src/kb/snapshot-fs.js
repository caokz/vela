// 快照条目（kind:'snapshot'）的虚拟句柄：网页里的聊天卡是跨源 iframe，Chrome 禁止它弹
// File System Access 选择框，也禁止跨源 requestPermission——「授权文件夹」在卡片里既弹不出、
// 侧边栏授过的句柄也过不了授权。降级方案：<input type="file">（webkitdirectory）在 iframe
// 里可以弹，选中的文件字节复制进 IndexedDB 做只读副本，三种引擎共用：
//   LLM 问答：单文件附进 system；LLM 任务：fs-tools 全套只读工具；Agent：kb/sync.js 照常同步。
// 接口与浏览器句柄 / bridge-fs.js 同形（entries / getFileHandle / getDirectoryHandle / getFile），
// 写入（createWritable / create）一律抛 ReadOnlyError，files.js 的 notFound 原样放行这类错误。

const err = (name, message) => Object.assign(new Error(message || name), { name });

export const READONLY_TIP = '快照副本是只读的：要修改文件请到侧边栏 / 聊天页「授权文件夹」，或添加经 bridge 的本机路径';

class SnapshotFile {
  constructor(name, file) {
    this.kind = 'file';
    this.name = name;
    this.file = file;
  }
  getFile() { return this.file; }
  createWritable() { throw err('ReadOnlyError', READONLY_TIP); }
}

class SnapshotDir {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.kids = new Map();
    this.truncated = false; // 与 bridge 虚拟句柄同形：walk 据此提示「没列全」，快照不会截断
  }
  async *entries() { for (const e of this.kids) yield e; }
  async getFileHandle(name, { create = false } = {}) {
    const h = this.kids.get(name);
    if (h?.kind === 'directory') throw err('TypeMismatchError');
    if (h) return h;
    if (create) throw err('ReadOnlyError', `不能在快照里新建文件。${READONLY_TIP}`);
    throw err('NotFoundError');
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    const h = this.kids.get(name);
    if (h?.kind === 'file') throw err('TypeMismatchError');
    if (h) return h;
    if (create) throw err('ReadOnlyError', `不能在快照里新建目录。${READONLY_TIP}`);
    throw err('NotFoundError');
  }
}

/**
 * 快照记录 → 虚拟根句柄。files: [{ rel, file }]，rel 是库内相对路径（单文件根为空）。
 * 同名冲突后者覆盖（webkitRelativePath 不会产生，防快照记录被手改）；防御性剥掉空段与 ..
 */
export function buildSnapshotRoot(name, files) {
  const list = (files ?? []).filter((x) => x?.file);
  if (list.length === 1 && !String(list[0].rel || '').trim()) return new SnapshotFile(name, list[0].file);
  const root = new SnapshotDir(name);
  for (const { rel, file } of list) {
    const segs = String(rel || file.name || 'file').split('/')
      .map((s) => s.trim()).filter((s) => s && s !== '.' && s !== '..');
    if (!segs.length) segs.push(String(file.name || 'file'));
    let d = root;
    for (const s of segs.slice(0, -1)) {
      let next = d.kids.get(s);
      if (!next || next.kind !== 'directory') d.kids.set(s, (next = new SnapshotDir(s)));
      d = next;
    }
    d.kids.set(segs.at(-1), new SnapshotFile(segs.at(-1), file));
  }
  return root;
}
