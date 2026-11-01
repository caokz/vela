// 打包 bridge：产出 dist/vela-bridge-{version}.zip，供商店用户从
// GitHub Release 下载后解压运行（npm i && node index.js）。
// 排除 node_modules、运行日志、性能探针脚本（*-probe.mjs）。
// 用法：node scripts/package-bridge.mjs
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from './lib/zip.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE = join(ROOT, 'bridge');
// 版本取 bridge/package.json（与扩展 manifest 各自独立维护）
const pkg = JSON.parse(readFileSync(join(BRIDGE, 'package.json'), 'utf8'));
const OUT_DIR = join(ROOT, 'dist');
const OUT = join(OUT_DIR, `vela-bridge-${pkg.version}.zip`);

const EXCLUDE_DIRS = new Set(['node_modules']);
const EXCLUDE_FILES = /\.(log|pid)$/i;
// 本地诊断脚本不随包分发：性能探针（*-probe.mjs）与真实调用检查（live-check.js）
const EXCLUDE_LOCAL = /(-probe\.mjs|^live-check\.js)$/;

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (!EXCLUDE_FILES.test(name) && !EXCLUDE_LOCAL.test(name)) out.push(p);
  }
  return out;
}

const files = listFiles(BRIDGE).sort();
if (!files.some((f) => f.endsWith(join('bridge', 'index.js')))) throw new Error('bridge/index.js 不在打包清单中');

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const zip = buildZip(files, BRIDGE);
writeFileSync(OUT, zip);

const sha256 = createHash('sha256').update(zip).digest('hex');
console.log(`产物: ${OUT}`);
console.log(`文件数: ${files.length}，大小: ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`sha256: ${sha256}`);
