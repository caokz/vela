// token 读写：~/.vela-bridge/token.json。首启生成落盘，之后每次启动复用。
// 扩展设置页粘贴一次即配对完成；文件权限收紧到仅当前用户。
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.vela-bridge');
const FILE = join(DIR, 'token.json');

export function tokenFilePath() {
  return FILE;
}

export function ensureToken() {
  try {
    const saved = JSON.parse(readFileSync(FILE, 'utf8'));
    if (typeof saved.token === 'string' && saved.token.length >= 32) return saved.token;
  } catch { /* 首启或文件损坏：重新生成 */ }
  const token = randomBytes(32).toString('hex');
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return token;
}
