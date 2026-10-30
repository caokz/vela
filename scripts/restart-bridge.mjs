// 一次性：重启本机 bridge（杀 39217 监听进程 + PowerShell 隐藏窗口拉起，不留 cmd 控制台）
import { execSync, spawn } from 'node:child_process';

const PORT = 39217;
try {
  const lines = execSync(`netstat -ano | findstr :${PORT}`, { shell: 'cmd.exe' }).toString();
  const pids = [...new Set(lines.split('\n').filter((l) => l.includes('LISTENING'))
    .map((l) => l.trim().split(/\s+/).at(-1)).filter(Boolean))];
  for (const pid of pids) execSync(`taskkill /PID ${pid} /F`, { shell: 'cmd.exe' });
  console.log('killed:', pids.join(', ') || '(none)');
} catch { console.log('no running bridge'); }

await new Promise((r) => setTimeout(r, 1000));
const ps = [
  "Start-Process -FilePath 'node' -ArgumentList 'index.js'",
  " -WorkingDirectory 'E:\\code\\vela\\bridge' -WindowStyle Hidden",
  " -RedirectStandardOutput 'E:\\code\\vela\\bridge\\bridge-detached.log'",
  " -RedirectStandardError 'E:\\code\\vela\\bridge\\bridge-detached.err.log'",
].join('');
spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
try {
  const out = execSync(`netstat -ano | findstr :${PORT}`, { shell: 'cmd.exe' }).toString();
  console.log(out.includes('LISTENING') ? 'bridge up:\n' + out.trim() : 'bridge NOT listening');
} catch { console.log('bridge NOT listening'); }
