// e2e 脚本共用的 Chromium 定位：VELA_CHROME 环境变量优先；否则在本机 Playwright 缓存里
// 挑版本号最大的 chromium-*（chrome-win64 / chrome-win 两种目录布局都认）。
// 品牌版 Chrome 137+ 已禁用 --load-extension，只能用 Playwright 的 Chromium。
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// 杀整棵进程树并等命令返回：child.kill() 只杀 chrome 主进程，渲染器 / crashpad 等
// 子进程会成为孤儿，在 Windows 上继续持有 user-data-dir 句柄，随后 rmSync 清理
// 临时 profile 必然 EPERM（Node 的 maxRetries 重试也扛不住长驻孤儿）。
export const killTree = async (chrome) => {
  if (!chrome || chrome.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((res) => {
      const tk = spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      tk.on('close', () => res());
      tk.on('error', () => { try { chrome.kill(); } catch { /* 已退出 */ } res(); });
    });
  } else chrome.kill();
};

export function findChrome() {
  if (process.env.VELA_CHROME) return process.env.VELA_CHROME;
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  let dirs = [];
  try { dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)); } catch { /* 无缓存 */ }
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const p = join(root, d, sub, 'chrome.exe');
      if (existsSync(p)) return p;
    }
  }
  return join(root, 'chromium-1208', 'chrome-win64', 'chrome.exe');
}
