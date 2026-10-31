// 品牌标识一致性：brand.js 是单一来源，widget.js 手抄的 logo 路径与 assets/icons 下的 PNG
// 必须与之同步（改了 brand.js 忘记同步时这里失败）。用法：node scripts/test-brand.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO_PATHS } from '../src/ui/brand.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('页面浮窗 widget.js 的 logo 与 brand.js 同源', () => {
  const widget = readFileSync(join(ROOT, 'src/content/widget.js'), 'utf8');
  for (const d of LOGO_PATHS) assert.ok(widget.includes(`d="${d}"`), `widget.js 缺少路径 ${d}`);
});

test('assets/icons 下的 PNG 与生成器当前输出一致（改 logo 后需重跑 make-icons）', () => {
  const before = [16, 32, 48, 128].map((s) => readFileSync(join(ROOT, `assets/icons/icon${s}.png`)));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/make-icons.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const after = [16, 32, 48, 128].map((s) => readFileSync(join(ROOT, `assets/icons/icon${s}.png`)));
  before.forEach((b, i) => assert.ok(b.equals(after[i]), `icon${[16, 32, 48, 128][i]}.png 与生成器输出不一致`));
});
