// 知识库本机文件夹 / 文件 → Agent 工作区同步。浏览器授权的句柄拿不到绝对路径，
// Agent（bridge 侧 Claude Code）读不到它们，发送前把内容增量上传到工作区 knowledge/<名称>/。
// 增量：IndexedDB 存「相对路径 → 大小:修改时间」清单，只传新增 / 变更的文件；
// 本机已删除的文件不在工作区删除（bridge 无单文件删除 op），清单里移除即可。

import { walk } from './files.js';
import { getManifest, putManifest } from './store.js';

const MAX_FILES = 2000;
const MAX_BYTES = 200 * 1024 * 1024;
const PER_FILE = 50 * 1024 * 1024;

/**
 * @param {{ roots, wsPaths: Map<string,string>, convId, cwdBase, uploadFile, sanitize, onProgress }} o
 *   wsPaths：知识库条目 id → 工作区落点（条目添加时按 sanitizeName 生成，如 knowledge/my-project）；
 *   uploadFile：agentClient.uploadFile；sanitize：chat-ui 的 sanitizeName（目录内相对路径清洗）
 * @returns {Promise<{ uploaded: number, skipped: number, total: number, truncated: boolean }>}
 */
export async function syncRootsToWorkspace({ roots, wsPaths, convId, cwdBase, uploadFile, sanitize, onProgress }) {
  let uploaded = 0;
  let skipped = 0;
  let total = 0;
  let bytes = 0;
  let truncated = false;
  for (const root of roots) {
    const key = `${convId}|${root.id}`;
    const manifest = await getManifest(key);
    const next = {};
    const files = [];
    if (root.kind === 'file') files.push({ rel: root.name, handle: root.handle });
    else {
      await walk(root.handle, '', ({ path, kind, handle }) => {
        if (kind !== 'file') return true;
        if (files.length >= MAX_FILES) { truncated = true; return 'stop'; }
        files.push({ rel: path.slice(1), handle });
        return true;
      });
    }
    for (const { rel, handle } of files) {
      const file = await handle.getFile();
      total++;
      const sig = `${file.size}:${file.lastModified}`;
      if (file.size > PER_FILE || bytes + file.size > MAX_BYTES) { truncated = true; continue; }
      next[rel] = sig;
      if (manifest[rel] === sig) { skipped++; continue; }
      const base = wsPaths.get(root.id) || `knowledge/${sanitize(root.name)}`;
      const relPath = root.kind === 'file' ? base : `${base}/${sanitize(rel)}`;
      onProgress?.(`${root.name}${root.kind === 'file' ? '' : `/${rel}`}`, uploaded + skipped, files.length);
      await uploadFile({ cwdBase, workspaceId: convId, relPath, file, overwrite: true });
      bytes += file.size;
      uploaded++;
    }
    await putManifest(key, next);
  }
  return { uploaded, skipped, total, truncated };
}

