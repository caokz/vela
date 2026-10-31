// 知识库本机句柄持久化：FileSystemHandle 只能结构化克隆进 IndexedDB（chrome.storage 存不了）。
// 扩展各页面同源（chrome-extension://<id>），侧边栏 / 聊天页 / 聊天卡 iframe 共享同一份句柄。
// 另存 Agent 同步清单：文件相对路径 → 「大小:修改时间」，只上传有变化的文件。

const DB = 'om-kb';
const STORE_HANDLES = 'handles';
const STORE_MANIFEST = 'manifests';

let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_HANDLES);
      req.result.createObjectStore(STORE_MANIFEST);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const putHandle = (id, handle) => tx(STORE_HANDLES, 'readwrite', (s) => s.put(handle, id));
export const getHandle = (id) => tx(STORE_HANDLES, 'readonly', (s) => s.get(id));
export async function deleteHandle(id) {
  await tx(STORE_HANDLES, 'readwrite', (s) => s.delete(id));
  await tx(STORE_MANIFEST, 'readwrite', (s) => s.delete(id));
}
export const getManifest = async (key) => (await tx(STORE_MANIFEST, 'readonly', (s) => s.get(key))) || {};
export const putManifest = (key, m) => tx(STORE_MANIFEST, 'readwrite', (s) => s.put(m, key));

/**
 * 确认句柄授权。interactive=true 时可弹浏览器授权提示（必须处在用户手势内：点击 / 回车发送）。
 * 返回 'granted' | 'prompt' | 'denied'。OPFS 句柄等无 queryPermission 的视为已授权。
 */
export async function ensurePermission(handle, mode = 'read', interactive = false) {
  if (!handle?.queryPermission) return 'granted';
  let state = await handle.queryPermission({ mode });
  if (state === 'prompt' && interactive) {
    try { state = await handle.requestPermission({ mode }); } catch { /* 无用户手势 / 跨源 iframe：保持 prompt */ }
  }
  return state;
}

/**
 * 把会话知识库里的 handle 条目解析成工具可用的 roots：[{ id, name, handle, kind }]。
 * 名称冲突时追加（2）（3）；句柄丢失（浏览器数据被清）的条目跳过并在 missing 里返回。
 */
export async function loadRoots(knowledge) {
  const roots = [];
  const missing = [];
  const used = new Set();
  for (const k of knowledge ?? []) {
    if (k?.kind !== 'handle') continue;
    const handle = await getHandle(k.id).catch(() => null);
    if (!handle) { missing.push(k); continue; }
    let name = k.name || handle.name;
    for (let i = 2; used.has(name); i++) name = `${k.name || handle.name}（${i}）`;
    used.add(name);
    roots.push({ id: k.id, name, handle, kind: handle.kind === 'directory' ? 'dir' : 'file' });
  }
  return { roots, missing };
}
