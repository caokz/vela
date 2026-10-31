// e2e：知识库浏览器授权的本机文件夹 → Agent 工作区增量同步（真实 bridge，不调用 Claude）。
// 句柄用 OPFS 模拟（同 verify-kb-tools），在聊天页内直接调用 kb/sync.js + agent client，
// 断言文件真实落到 bridge 工作区 <cwdBase>/<会话 id>/knowledge/<名称>/…，二次同步只传变更文件，
// 依赖目录不同步。需要 bridge 在 127.0.0.1:39217（test-all 会自动拉起）。
// 用法：node scripts/verify-kb-agent-sync.mjs
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, waitFor, createChecker, seedStorage } from './lib/cdp.mjs';

const { check, summary } = createChecker();
const base = mkdtempSync(join(tmpdir(), 'vela-kbsync-'));
const CONV = 'conv:kbsync-test';
const b = await launch({ port: 9374 });
try {
  const sw = await b.sw();
  await seedStorage(sw, { llmSettings: { agentBridge: { url: 'ws://127.0.0.1:39217', baseDir: base } } });
  sw.close();
  const s = await b.openTab(`chrome-extension://${b.extId}/src/chatpage/chat.html`, { wait: 1800 });
  await waitFor(() => s.evaluate(`!!document.getElementById('om-kb')`));
  // 页内工具：建 OPFS 项目 → 存句柄 → 调同步
  await s.evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const p = await root.getDirectoryHandle('sync-proj', { create: true });
    const put = async (path, text) => {
      const segs = path.split('/');
      let d = p;
      for (const x of segs.slice(0, -1)) d = await d.getDirectoryHandle(x, { create: true });
      const w = await (await d.getFileHandle(segs.at(-1), { create: true })).createWritable();
      await w.write(text);
      await w.close();
    };
    window.__put = put;
    await put('src/App.java', 'class App { /* v1 */ }');
    await put('README.md', '# 同步测试');
    await put('node_modules/x/index.js', 'ignored');
    const { putHandle } = await import('/src/kb/store.js');
    await putHandle('kb-sync-1', p);
    const { getAgentClient } = await import('/src/agent/client.js');
    const { loadRoots } = await import('/src/kb/store.js');
    const { syncRootsToWorkspace } = await import('/src/kb/sync.js');
    const client = getAgentClient({});
    await client.ensureReady();
    window.__sync = async () => {
      const { roots } = await loadRoots([{ id: 'kb-sync-1', kind: 'handle', name: 'sync-proj', handleKind: 'dir', wsPath: 'knowledge/sync-proj' }]);
      return syncRootsToWorkspace({
        roots, wsPaths: new Map([['kb-sync-1', 'knowledge/sync-proj']]), convId: '${CONV}', cwdBase: ${JSON.stringify(base)},
        uploadFile: (o) => client.uploadFile(o), sanitize: (x) => x,
      });
    };
    return 1;
  })()`);
  const ws = join(base, CONV.replace(/:/g, '-'), 'knowledge', 'sync-proj');
  const r1 = JSON.parse(await s.evaluate(`window.__sync().then(JSON.stringify)`));
  check('首次同步上传全部文件（跳过 node_modules）', r1.uploaded === 2 && r1.skipped === 0, r1);
  check('文件落到 bridge 工作区 knowledge/<名称>/ 且保留层级', readFileSync(join(ws, 'src', 'App.java'), 'utf8') === 'class App { /* v1 */ }' && existsSync(join(ws, 'README.md')), ws);
  check('依赖目录未同步', !existsSync(join(ws, 'node_modules')));
  const r2 = JSON.parse(await s.evaluate(`window.__sync().then(JSON.stringify)`));
  check('未变更时二次同步不重复上传', r2.uploaded === 0 && r2.skipped === 2, r2);
  await new Promise((res) => setTimeout(res, 1100)); // lastModified 精度：确保变更可感知
  await s.evaluate(`window.__put('src/App.java', 'class App { /* v2 */ }').then(() => 1)`);
  const r3 = JSON.parse(await s.evaluate(`window.__sync().then(JSON.stringify)`));
  check('只上传变更的文件，并原名覆盖（不产生 “ -2” 副本）', r3.uploaded === 1 && readFileSync(join(ws, 'src', 'App.java'), 'utf8') === 'class App { /* v2 */ }' && !existsSync(join(ws, 'src', 'App -2.java')), r3);
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await b.close();
  rmSync(base, { recursive: true, force: true });
}
process.exit(summary());
