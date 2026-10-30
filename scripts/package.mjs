// 打包：把扩展打成 Chrome Web Store 可直接上传的 zip（store 模式，零依赖）。
// 要求 zip 内顶层直接是 manifest.json，不套目录层。
// 白名单制：只有 manifest.json / src / assets / LICENSE 进包——docs、scripts、
// README、bridge 等仓库文件不随扩展分发。
// 用法：node scripts/package.mjs
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from './lib/zip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const OUT_DIR = join(ROOT, 'dist');
const OUT = join(OUT_DIR, `vela-${manifest.version}.zip`);

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

// 白名单：扩展运行真正需要的顶层条目
const files = ['manifest.json', 'LICENSE']
  .map((f) => join(ROOT, f))
  .filter((p) => existsSync(p));
for (const dir of ['src', 'assets']) {
  const p = join(ROOT, dir);
  if (existsSync(p)) files.push(...listFiles(p));
}
files.sort();
if (!files.some((f) => f.endsWith('manifest.json'))) throw new Error('manifest.json 不在打包清单中');

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const zip = buildZip(files, ROOT);
writeFileSync(OUT, zip);

const sha256 = createHash('sha256').update(zip).digest('hex');
console.log(`产物: ${OUT}`);
console.log(`文件数: ${files.length}，大小: ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`sha256: ${sha256}`);
