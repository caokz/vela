// 语法检查：把每个 ES module 文件按模块语法编译一遍（不执行）。
// node --check 对 .js 会按 CommonJS / 自动探测处理，个别情况下漏报；这里用 vm.SourceTextModule 精确检查。
// 用法：node --experimental-vm-modules scripts/check-syntax.mjs [文件...]（缺省：src/ bridge/ scripts/ 下全部 .js/.mjs）
import vm from 'node:vm';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function list(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) list(p, out);
    else if (/\.m?js$/.test(n)) out.push(p);
  }
  return out;
}
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'bridge', 'scripts'].flatMap((d) => list(join(ROOT, d)));
let bad = 0;
for (const f of files) {
  try {
    new vm.SourceTextModule(readFileSync(f, 'utf8'), { identifier: f });
  } catch (e) {
    bad++;
    console.log(`FAIL ${relative(ROOT, f)}: ${e.message}`);
  }
}
console.log(bad ? `${bad} 个文件有语法错误` : `PASS ${files.length} 个文件语法正确`);
process.exit(bad ? 1 : 0);
