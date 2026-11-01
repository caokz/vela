// 全量自动化测试入口：单元测试 → 打包 → 浏览器 e2e，逐个串行跑（多数 e2e 用固定调试端口）。
// 判定：退出码非 0，或输出里出现以 FAIL / ✖ 开头的行，都算失败（个别旧诊断脚本出错仍 exit 0）。
// 需要 bridge 的 e2e 运行前确认 127.0.0.1:39217 在线，不在就拉起本仓库 bridge（结束时停掉自己拉起的）。
// 用法：
//   node scripts/test-all.mjs              # 默认：离线可跑的全部（mock LLM，不产生真实调用）
//   node scripts/test-all.mjs --network    # 追加真实网页车道（访问 nightlies.apache.org）
//   node scripts/test-all.mjs --real-llm   # 追加真实供应商/agent 调用（需本机已配置，产生费用）
//   node scripts/test-all.mjs --only=llm   # 只跑名字含 llm 的项
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE = join(ROOT, 'bridge');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);

// [名称, 命令参数, 选项]
const SUITES = [
  ['bridge 单元（turn hub）', ['turn.test.js'], { cwd: BRIDGE }],
  ['bridge 协议冒烟', ['smoke.js'], { cwd: BRIDGE }],
  ['bridge claude 选项', ['claude-options.test.js'], { cwd: BRIDGE }],
  ['bridge codex 适配器', ['codex-adapter.test.js'], { cwd: BRIDGE }],
  ['语法检查（全部 ES module）', ['--experimental-vm-modules', 'scripts/check-syntax.mjs']],
  ['LLM 适配器 / 路由 / 工具循环 单元', ['scripts/test-llm-unit.mjs']],
  ['本机知识库 / 文件工具 单元', ['scripts/test-kb-unit.mjs']],
  ['search_files 覆盖完整性 + fetch_url 404 处理 单元', ['scripts/test-search-unit.mjs']],
  ['思维导图大纲 / 导出 纯函数 单元', ['scripts/test-mindmap-unit.mjs']],
  ['品牌标识一致性', ['scripts/test-brand.mjs']],
  ['打包扩展', ['scripts/package.mjs']],
  ['扩展冒烟（SW / 三页面 / 会话交互）', ['scripts/smoke-test.mjs']],
  ['LLM 问答 + 任务模式 e2e（mock LLM）', ['scripts/verify-llm-chat.mjs']],
  ['本机知识库 + 文件工具 e2e（mock LLM）', ['scripts/verify-kb-tools.mjs']],
  ['聊天卡网页上下文跟随宿主页（mock LLM）', ['scripts/verify-card-ctx.mjs']],
  ['划词工具条全量', ['scripts/verify-selection.mjs']],
  ['高亮真实输入路径', ['scripts/verify-highlight-input.mjs']],
  ['高亮像素终验', ['scripts/verify-hl-pixel.mjs']],
  ['高亮自检告警', ['scripts/verify-hl-diag.mjs']],
  ['高亮强制深色', ['scripts/verify-hl-forcedark.mjs']],
  ['跨行高亮不误报遮挡', ['scripts/verify-hl-multiline.mjs']],
  ['划词与页面滚动', ['scripts/verify-sel-scroll.mjs']],
  ['扩展重载后划词可用', ['scripts/verify-ext-reload.mjs']],
  ['扩展重载后旧聊天卡不刷错误并自动刷新', ['scripts/verify-ctx-invalid.mjs']],
  ['打包产物高亮', ['scripts/verify-package-hl.mjs']],
  ['剪贴板兜底', ['scripts/verify-copy-fallback.mjs']],
  ['沉浸式翻译回填', ['scripts/verify-immersive.mjs']],
  ['ARIA div 表格翻译（x.ai 型）', ['scripts/verify-aria-table.mjs']],
  ['顶栏导航与弹层翻译（x.ai 型）', ['scripts/verify-top-modal.mjs']],
  ['面板追问转 agent', ['scripts/verify-followup-agent.mjs']],
  ['agent 模型下拉跟随所选 agent（mock bridge）', ['scripts/verify-agent-models.mjs']],
  ['划词思维导图 e2e（mock LLM）', ['scripts/verify-mindmap.mjs']],
  ['网页媒体悬停 e2e（mock LLM）', ['scripts/verify-media.mjs']],
  ['知识库同步到 Agent 工作区（bridge）', ['scripts/verify-kb-agent-sync.mjs'], { bridge: true }],
  ['卡片里 LLM 任务经 bridge 读写本机路径（bridge）', ['scripts/verify-kb-bridge.mjs'], { bridge: true }],
  ['会话导出（bridge）', ['scripts/verify-export.mjs'], { bridge: true }],
  ['设置页自动配对（bridge）', ['scripts/verify-auto-pair.mjs'], { bridge: true }],
  ['设置页检测/启动序列（bridge）', ['scripts/verify-button-sequence.mjs'], { bridge: true }],
  ['设置页启停按钮（bridge，含停止）', ['scripts/verify-agent-buttons.mjs'], { bridge: true }],
  ['真实页高亮（Flink 文档）', ['scripts/diag-highlight-real.mjs'], { network: true }],
  ['打包产物 × 真实页高亮', ['scripts/verify-package-hl-flink.mjs'], { network: true }],
  ['真实供应商整页翻译', ['scripts/verify-translate-real.mjs'], { realLlm: true }],
  ['真实供应商 LLM 问答 + 任务模式', ['scripts/verify-llm-real.mjs'], { realLlm: true }],
  ['bridge 真实 claude turn', ['live-check.js'], { cwd: BRIDGE, realLlm: true, bridge: false }],
];

function portOpen(port) {
  return new Promise((res) => {
    const s = createConnection({ port, host: '127.0.0.1' }, () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.setTimeout(1500, () => { s.destroy(); res(false); });
  });
}

let bridgeChild = null;
async function ensureBridge() {
  if (await portOpen(39217)) return true;
  if (!existsSync(join(BRIDGE, 'node_modules'))) {
    console.log('  bridge 依赖未安装，执行 npm install …');
    spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: BRIDGE, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  bridgeChild = spawn(process.execPath, ['index.js'], { cwd: BRIDGE, stdio: 'ignore' });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await portOpen(39217)) return true;
  }
  return false;
}

function run(name, cmd, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, cmd, { cwd: opts.cwd || ROOT, env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += '\nFAIL 超时（300s）'; child.kill(); }, 300000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const fails = out.split(/\r?\n/).filter((l) => /^\s*(FAIL\b|✖)/.test(l));
      const passes = out.split(/\r?\n/).filter((l) => /^\s*(PASS\b|✔)/.test(l)).length;
      const ok = code === 0 && fails.length === 0;
      resolve({ name, ok, code, passes, fails, out, secs: ((Date.now() - t0) / 1000).toFixed(1) });
    });
  });
}

const results = [];
for (const [name, cmd, opts = {}] of SUITES) {
  if (opts.network && !flag('--network')) continue;
  if (opts.realLlm && !flag('--real-llm')) continue;
  if (only && !name.toLowerCase().includes(only.toLowerCase()) && !cmd.join(' ').includes(only)) continue;
  if (opts.bridge && !(await ensureBridge())) {
    results.push({ name, ok: false, passes: 0, fails: ['FAIL bridge 无法启动'], secs: '0' });
    console.log(`✗ ${name} — bridge 无法启动`);
    continue;
  }
  process.stdout.write(`… ${name}`);
  const r = await run(name, cmd, opts);
  results.push(r);
  process.stdout.write(`\r${r.ok ? '✓' : '✗'} ${name}（${r.passes} 项通过，${r.secs}s）\n`);
  if (!r.ok) {
    for (const f of r.fails.slice(0, 10)) console.log(`    ${f.trim().slice(0, 300)}`);
    if (!r.fails.length) console.log(r.out.split(/\r?\n/).slice(-15).map((l) => `    ${l}`).join('\n'));
  }
}
if (bridgeChild) bridgeChild.kill();

const failed = results.filter((r) => !r.ok);
const total = results.reduce((a, r) => a + r.passes, 0);
console.log(`\n共 ${results.length} 组，${results.length - failed.length} 组通过，断言通过 ${total} 项${failed.length ? `；失败：${failed.map((r) => r.name).join('、')}` : '；全部通过'}`);
process.exit(failed.length ? 1 : 0);
