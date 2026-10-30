// bridge 入口：node index.js [--port 39217]
// 启动即打印 token 文件路径；扩展设置页粘贴一次 token 完成配对。
// Windows 上启动时自动注册 vela-bridge:// URL 协议（设置页「启动」按钮靠它
// 拉起本进程）；VELA_NO_PROTOCOL_REGISTER=1 可跳过注册。

import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from './turn.js';
import { ensureToken, tokenFilePath } from './token.js';
import { startServer } from './server.js';

const BRIDGE_VERSION = '0.5.0';

const portArg = process.argv.indexOf('--port');
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) || 39217 : 39217;
const token = ensureToken();
const bridgeDir = resolve(dirname(fileURLToPath(import.meta.url)));

const hub = createHub();

// 协议键写 HKCU（用户级，无需管理员）：vela-bridge://launch → wscript launcher.vbs。
// 幂等：每次启动覆盖刷新；失败只打日志不阻塞。
function registerProtocol() {
  if (process.platform !== 'win32' || process.env.VELA_NO_PROTOCOL_REGISTER) return;
  const root = 'HKCU\\Software\\Classes\\vela-bridge';
  const launcher = join(bridgeDir, 'launcher.vbs');
  const add = (args) =>
    new Promise((res) => {
      execFile('reg', ['add', ...args, '/f'], { windowsHide: true }, (err) => {
        if (err) console.error(`[Vela bridge] 协议注册失败：${err.message}`);
        res();
      });
    });
  // 调用点不等待：注册在后台完成，不阻塞监听
  add([root, '/ve', '/t', 'REG_SZ', '/d', 'URL:Vela Bridge']);
  add([root, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '']);
  add([`${root}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', `wscript.exe "${launcher}"`]);
}

const { httpServer, wss } = await startServer({
  port,
  token,
  hub,
  bridgeVersion: BRIDGE_VERSION,
  // 设置页「停止」按钮 / Ctrl+C 共用的优雅退出路径
  onShutdown: () => {
    for (const client of wss.clients) client.close();
    wss.close();
    httpServer.close();
    console.log('[Vela bridge] 已停止');
    setTimeout(() => process.exit(0), 200);
  },
}).catch((err) => {
  console.error(`[Vela bridge] 启动失败：${err.message}`);
  process.exit(1);
});

process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));

registerProtocol();

console.log(`[Vela bridge] v${BRIDGE_VERSION} 监听 ws://127.0.0.1:${port}`);
console.log(`[Vela bridge] token：${tokenFilePath()}（首次使用在扩展设置页粘贴文件内的 token）`);
console.log('[Vela bridge] 会话工作区默认根：~/.vela-bridge/workspaces（基础目录可在扩展设置页修改）');
