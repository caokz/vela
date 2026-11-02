// 本机知识库单元测试（node:test，无浏览器）：zip 解包（store + deflate）、路径解析与越界拒绝、
// 文本解码（UTF-8 / GBK / BOM）、行级 diff、skill 解析、精确替换，以及文件工具
// list_files / search_files / read_file / write_file / edit_file / load_skill 在内存假文件系统上的行为。
// Office（docx/xlsx/pptx）解析依赖 DOMParser，在浏览器 e2e（verify-kb-tools.mjs）里覆盖。
// 用法：node scripts/test-kb-unit.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestZip } from './lib/test-zip.mjs';
import { openZip } from '../src/kb/zip.js';
import { normalizePath, resolveRoot, decodeText, lineDiff, formatDiff, parseSkill, classify } from '../src/kb/files.js';
import { createFsTools, discoverSkills, applyEdit, fsSystemPrompt } from '../src/llm/fs-tools.js';

// ---- 内存版 FileSystemHandle（接口子集与浏览器一致） ----
const err = (name) => Object.assign(new Error(name), { name });
class FFile {
  constructor(name, data) { this.kind = 'file'; this.name = name; this.set(data); }
  set(data) { this.data = typeof data === 'string' ? new TextEncoder().encode(data) : data; this.mtime = Date.now(); }
  async getFile() { return new File([this.data], this.name, { lastModified: this.mtime }); }
  async createWritable() {
    let buf = '';
    return { write: async (s) => { buf += s; }, close: async () => { this.set(buf); } };
  }
  text() { return new TextDecoder().decode(this.data); }
}
class FDir {
  constructor(name, tree = {}) {
    this.kind = 'directory';
    this.name = name;
    this.kids = new Map();
    for (const [k, v] of Object.entries(tree)) this.kids.set(k, typeof v === 'string' || v instanceof Uint8Array ? new FFile(k, v) : new FDir(k, v));
  }
  async *entries() { for (const e of this.kids) yield e; }
  async getFileHandle(name, { create } = {}) {
    const h = this.kids.get(name);
    if (h?.kind === 'directory') throw err('TypeMismatchError');
    if (h) return h;
    if (!create) throw err('NotFoundError');
    const f = new FFile(name, '');
    this.kids.set(name, f);
    return f;
  }
  async getDirectoryHandle(name, { create } = {}) {
    const h = this.kids.get(name);
    if (h?.kind === 'file') throw err('TypeMismatchError');
    if (h) return h;
    if (!create) throw err('NotFoundError');
    const d = new FDir(name);
    this.kids.set(name, d);
    return d;
  }
  at(path) { return path.split('/').reduce((d, n) => d.kids.get(n), this); }
}

const project = () => new FDir('demo', {
  'README.md': '# Demo\n项目说明：订单服务。\n',
  src: {
    'Main.java': 'package demo;\n\npublic class Main {\n  public static void main(String[] a) {\n    OrderService s = new OrderService();\n  }\n}\n',
    'OrderService.java': 'package demo;\n\npublic class OrderService {\n  // TODO: 退款逻辑\n  int total() { return 0; }\n}\n',
  },
  node_modules: { 'junk.js': 'OrderService' },
  '.git': { HEAD: 'OrderService' },
  '.vela': { skills: { review: { 'SKILL.md': '---\nname: code-review\ndescription: 按团队规范审查 Java 代码\n---\n# 审查清单\n1. 命名\n', 'checklist.md': '- 空指针' } } },
  'legacy.doc': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
  'logo.bin': new Uint8Array([1, 0, 2, 0, 3]),
});
const rootsOf = (dir) => [{ id: 'r1', name: dir.name, handle: dir, kind: 'dir' }];
const tool = (tools, name) => tools.find((t) => t.name === name);

test('zip：store 与 deflate 条目都能解出', async () => {
  const zip = openZip(buildTestZip({ 'a.txt': 'hello', 'word/document.xml': '<x>深度压缩'.repeat(200) + '</x>' }, { deflate: ['word/document.xml'] }));
  assert.deepEqual(zip.names.sort(), ['a.txt', 'word/document.xml']);
  assert.equal(await zip.text('a.txt'), 'hello');
  assert.ok((await zip.text('word/document.xml')).startsWith('<x>深度压缩'));
  assert.throws(() => openZip(new Uint8Array(40)), /不是有效的 zip/);
});

test('路径：知识库名前缀、单根可省略、拒绝 .. 与绝对路径', () => {
  const roots = [{ name: 'demo', kind: 'dir' }];
  assert.deepEqual(resolveRoot(roots, 'demo/src/A.java').segs, ['src', 'A.java']);
  assert.deepEqual(resolveRoot(roots, './src\\A.java').segs, ['src', 'A.java']);
  assert.throws(() => normalizePath('demo/../etc/passwd'), /\.\./);
  assert.throws(() => normalizePath('C:\\Windows\\win.ini'), /绝对路径/);
  assert.throws(() => resolveRoot([{ name: 'a', kind: 'dir' }, { name: 'b', kind: 'dir' }], 'x/y'), /可选：a、b/);
});

test('文本解码：UTF-8、GBK 回退、UTF-16 BOM', () => {
  assert.equal(decodeText(new TextEncoder().encode('中文')), '中文');
  assert.equal(decodeText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])), '中文'); // GBK「中文」
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e])), '中');
});

test('类型判定', () => {
  assert.deepEqual(['a.java', 'Dockerfile', 'b.docx', 'c.XLSX', 'd.pdf', 'e.png', 'f.doc', 'g.bin'].map(classify),
    ['text', 'text', 'docx', 'xlsx', 'pdf', 'image', 'legacy-office', 'unknown']);
});

test('行级 diff 与格式化', () => {
  const ops = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(ops.filter((o) => o.op !== ' ').map((o) => o.op + o.text), ['-b', '+B', '+e']);
  const f = formatDiff(ops, { context: 0 });
  assert.equal(f.add, 2);
  assert.equal(f.del, 1);
  assert.match(f.text, /-b\n\+B/);
});

test('skill 解析：frontmatter 与无 frontmatter', () => {
  assert.deepEqual(
    (({ name, description }) => ({ name, description }))(parseSkill('---\nname: x\ndescription: "做 y"\n---\nbody', 'dir')),
    { name: 'x', description: '做 y' },
  );
  const p = parseSkill('# 周报模板\n内容', 'weekly');
  assert.equal(p.name, 'weekly');
  assert.equal(p.description, '周报模板');
});

test('精确替换：唯一性、replace_all、CRLF', () => {
  assert.equal(applyEdit('a b a', { old_string: 'b', new_string: 'c' }), 'a c a');
  assert.throws(() => applyEdit('a b a', { old_string: 'a', new_string: 'x' }), /出现 2 次/);
  assert.equal(applyEdit('a b a', { old_string: 'a', new_string: 'x', replace_all: true }), 'x b x');
  assert.throws(() => applyEdit('abc', { old_string: 'zz' }), /找不到/);
  assert.equal(applyEdit('l1\r\nl2\r\n', { old_string: 'l1\nl2', new_string: 'L1\nL2' }), 'L1\r\nL2\r\n');
  assert.equal(applyEdit('$1', { old_string: '$1', new_string: '$&$&' }), '$&$&'); // 替换串里的 $ 不被特殊解释
});

test('list_files：跳过 node_modules / .git，保留 .vela，标注大小', async () => {
  const tools = createFsTools(rootsOf(project()));
  const out = await tool(tools, 'list_files').run({ depth: 3 });
  assert.match(out, /^demo\//);
  assert.match(out, /Main\.java（\d/);
  assert.match(out, /\.vela\//);
  assert.doesNotMatch(out, /node_modules|\.git\//);
});

test('search_files：内容匹配带行号、glob 过滤、跳过依赖目录与二进制', async () => {
  const tools = createFsTools(rootsOf(project()));
  const out = await tool(tools, 'search_files').run({ query: 'orderservice' }, {});
  assert.match(out, /demo\/src\/Main\.java:5: OrderService s/);
  assert.match(out, /demo\/src\/OrderService\.java:3: public class OrderService/);
  assert.match(out, /文件名匹配（1）：\n- demo\/src\/OrderService\.java/);
  assert.doesNotMatch(out, /node_modules|\.git/);
  const g = await tool(tools, 'search_files').run({ query: 'package', glob: 'Main.java' }, {});
  assert.match(g, /内容匹配（1/);
  const re = await tool(tools, 'search_files').run({ query: 'TODO:\\s*\\S+', regex: true }, {});
  assert.match(re, /OrderService\.java:4/);
});

test('read_file：带行号、分段、拒绝二进制 / 旧 Office / 越界路径', async () => {
  const tools = createFsTools(rootsOf(project()));
  const read = tool(tools, 'read_file');
  const full = await read.run({ path: 'demo/src/Main.java' });
  assert.match(full.text, /共 8 行/);
  assert.match(full.text, /3│public class Main/);
  const part = await read.run({ path: 'src/Main.java', start_line: 3, end_line: 4 });
  assert.match(part.text, /第 3-4 行/);
  assert.doesNotMatch(part.text, /package demo/);
  await assert.rejects(read.run({ path: 'demo/logo.bin' }), /二进制/);
  await assert.rejects(read.run({ path: 'demo/legacy.doc' }), /docx/);
  await assert.rejects(read.run({ path: 'demo/../x' }), /\.\./);
  await assert.rejects(read.run({ path: 'demo/src/Nope.java' }), /找不到/);
});

test('write_file / edit_file：审批 diff 预览、实际落盘、新建中间目录、拒绝写 Office', async () => {
  const dir = project();
  const tools = createFsTools(rootsOf(dir));
  const write = tool(tools, 'write_file');
  const edit = tool(tools, 'edit_file');
  assert.ok(write.needsApproval && edit.needsApproval);
  const pre = await edit.approvalDetail({ path: 'demo/src/OrderService.java', old_string: '  // TODO: 退款逻辑\n', new_string: '  void refund() {}\n' });
  assert.match(pre.title, /\+1 −1/);
  assert.match(pre.diff, /-  \/\/ TODO: 退款逻辑\n\+  void refund\(\) \{\}/);
  assert.match(await edit.run({ path: 'demo/src/OrderService.java', old_string: '  // TODO: 退款逻辑\n', new_string: '  void refund() {}\n' }), /已修改/);
  assert.match(dir.at('src/OrderService.java').text(), /void refund\(\)/);
  const np = await write.approvalDetail({ path: 'demo/docs/new.md', content: 'a\nb' });
  assert.match(np.title, /新建文件.*2 行/);
  assert.match(await write.run({ path: 'demo/docs/new.md', content: 'a\nb' }), /已新建/);
  assert.equal(dir.at('docs/new.md').text(), 'a\nb');
  await assert.rejects(write.run({ path: 'demo/report.docx', content: 'x' }), /只能写入文本类文件/);
});

test('skill：发现 .vela/skills、系统提示列出简介、load_skill 读全文与附带文件', async () => {
  const roots = rootsOf(project());
  const skills = await discoverSkills(roots);
  assert.deepEqual(skills.map((s) => [s.name, s.description]), [['code-review', '按团队规范审查 Java 代码']]);
  assert.match(fsSystemPrompt(roots, skills), /code-review：按团队规范审查 Java 代码/);
  const tools = createFsTools(roots, skills);
  const load = tool(tools, 'load_skill');
  assert.deepEqual(load.parameters.properties.name.enum, ['code-review']);
  const out = await load.run({ name: 'code-review' });
  assert.match(out, /# 审查清单/);
  assert.doesNotMatch(out, /^---/m);
  assert.match(out, /demo\/\.vela\/skills\/review\/checklist\.md/);
  assert.equal(createFsTools(roots, []).some((t) => t.name === 'load_skill'), false);
});

test('单文件知识库：路径就是文件名', async () => {
  const f = new FFile('notes.md', '第一行\n第二行');
  const tools = createFsTools([{ id: 'f', name: 'notes.md', handle: f, kind: 'file' }]);
  const r = await tool(tools, 'read_file').run({ path: 'notes.md' });
  assert.match(r.text, /2│第二行/);
  assert.match(await tool(tools, 'list_files').run({}), /notes\.md（/);
});

test('工具循环：工具返回 { text, attachments } 时附件进历史、展示只用文本', async () => {
  const { runToolLoop } = await import('../src/llm/tool-loop.js');
  const seen = [];
  let n = 0;
  const callModel = async ({ messages }) => {
    seen.push(structuredClone(messages));
    return n++ ? {} : { toolCalls: [{ id: 'c1', name: 'pdf', arguments: {} }] };
  };
  const events = [];
  await runToolLoop({
    messages: [], callModel, approve: async () => true, onEvent: (e) => events.push(e),
    tools: [{ name: 'pdf', parameters: { type: 'object', properties: {} }, run: async () => ({ text: '已附 PDF', attachments: [{ kind: 'pdf', mime: 'application/pdf', name: 'a.pdf', data: 'X' }] }) }],
  });
  const t = seen[1].at(-1);
  assert.equal(t.content, '已附 PDF');
  assert.equal(t.attachments[0].name, 'a.pdf');
  assert.equal(events.find((e) => e.kind === 'tool_call_update').result, '已附 PDF');
});

test('Agent prompt：本机授权条目以工作区路径列出', async () => {
  const { buildAgentPrompt } = await import('../src/agent/compose.js');
  const conv = { knowledge: [
    { id: 'a', kind: 'handle', name: 'my proj', handleKind: 'dir', wsPath: 'knowledge/my proj' },
    { id: 'b', kind: 'handle', name: 'spec.docx', handleKind: 'file', wsPath: 'knowledge/spec.docx' },
  ] };
  const p = buildAgentPrompt(conv, { content: '分析' }, { syncedIds: new Set(['a', 'b']) });
  assert.match(p, /- knowledge\/my proj\/（my proj）/);
  assert.match(p, /- knowledge\/spec\.docx（spec\.docx）/);
  assert.match(p, /优先读本地内容/);
  // 不传 syncedIds（旧调用方）：不标注，行为不变
  assert.doesNotMatch(buildAgentPrompt(conv, { content: '分析' }), /本轮未同步/);
});

test('Agent prompt：kind:local 本机路径点名列出（模型才知道本地有源码，不去网上找）', async () => {
  const { buildAgentPrompt } = await import('../src/agent/compose.js');
  const conv = { knowledge: [
    { id: 'l1', kind: 'local', path: 'E:\\code\\flink' },
    { id: 'l2', kind: 'local', path: 'C:\\docs\\note.md' },
  ] };
  const p = buildAgentPrompt(conv, { content: 'flink 里 delegation token 怎么实现' }, { syncedIds: new Set() });
  assert.match(p, /知识库本机路径（已加入会话可读目录/);
  assert.match(p, /- E:\\code\\flink/);
  assert.match(p, /- C:\\docs\\note\.md/);
  assert.match(p, /优先读这些本地内容，本地查不到再联网/);
});

test('Agent prompt：本轮未同步的句柄条目如实标注，已同步的不标', async () => {
  const { buildAgentPrompt } = await import('../src/agent/compose.js');
  const conv = { knowledge: [
    { id: 'a', kind: 'handle', name: 'proj', handleKind: 'dir', wsPath: 'knowledge/proj' },
    { id: 'b', kind: 'handle', name: 'x.md', handleKind: 'file', wsPath: 'knowledge/x.md' },
  ] };
  // a 授权失效被跳过（不在 syncedIds），b 正常同步
  const p = buildAgentPrompt(conv, { content: '问' }, { syncedIds: new Set(['b']) });
  assert.match(p, /- knowledge\/proj\/（proj）（本轮未同步，内容可能过期或缺失）/);
  assert.match(p, /- knowledge\/x\.md（x\.md）$/m);
});

// ---- bridge 虚拟文件系统：用内存假 client 模拟 fs.check / fs.list / fs.read / fs.write ----
function fakeBridgeClient(tree) {
  // tree: { 'C:': { proj: { 'a.txt': '内容', sub: { 'b.java': 'x' } } }，字符串 = 文件
  const calls = [];
  const resolve = (p) => {
    const segs = p.split(/[\\/]+/).filter(Boolean);
    let n = tree;
    for (const s of segs) { if (n && typeof n === 'object' && s in n) n = n[s]; else return undefined; }
    return n;
  };
  const meta = (n) => (typeof n === 'string' ? { exists: true, isDirectory: false, size: Buffer.byteLength(n), mtimeMs: 1000 } : { exists: true, isDirectory: true, size: 0, mtimeMs: 0 });
  return {
    calls,
    async ensureReady() { if (tree.__offline) throw new Error('连接失败'); },
    async fsCheck(p) { calls.push(['check', p]); const n = resolve(p); return n === undefined ? { exists: false, isDirectory: false } : meta(n); },
    async fsList(p, opts) { calls.push(['list', p, opts]); const n = resolve(p); return { path: p, entries: Object.entries(n).map(([name, v]) => ({ name, path: `${p}\\${name}`, isDirectory: typeof v !== 'string', ...(typeof v === 'string' ? { size: Buffer.byteLength(v), mtimeMs: 1000 } : {}) })) }; },
    async fsRead(p) { calls.push(['read', p]); const n = resolve(p); if (typeof n !== 'string') throw new Error('不是文件'); return { size: Buffer.byteLength(n), b64: Buffer.from(n).toString('base64') }; },
    async fsWrite({ path, content }) {
      calls.push(['write', path]);
      const segs = path.split(/[\\/]+/).filter(Boolean);
      let n = tree;
      for (const s of segs.slice(0, -1)) n = n[s] ??= {};
      n[segs.at(-1)] = content;
      return { path, bytes: Buffer.byteLength(content) };
    },
  };
}

test('bridge 虚拟句柄：同一套文件工具直接可用（列目录 / 搜索 / 读 / 改 / 新建 / skill），隐藏目录可见', async () => {
  const { loadBridgeRoots } = await import('../src/kb/bridge-fs.js');
  const tree = { 'C:': { proj: {
    'Main.java': 'class Main {\n  // BRIDGE-MARKER\n}\n',
    src: { 'Svc.java': 'class Svc { /* TODO: 退款 */ }' },
    node_modules: { 'x.js': 'BRIDGE-MARKER ignored' },
    '.vela': { skills: { fmt: { 'SKILL.md': '---\nname: fmt\ndescription: 格式规范\n---\n# 规范\nSKILL-BRIDGE' } } },
  }, 'note.md': '单文件内容' } };
  const client = fakeBridgeClient(tree);
  const { roots, skipped } = await loadBridgeRoots(client, [
    { id: 'k1', kind: 'local', path: 'C:\\proj' },
    { id: 'k2', kind: 'local', path: 'C:\\note.md' },
    { id: 'k3', kind: 'local', path: 'C:\\gone' },
    { id: 'k4', kind: 'handle', name: 'ignored' },
  ]);
  assert.deepEqual(roots.map((r) => [r.name, r.kind]), [['proj', 'dir'], ['note.md', 'file']]);
  assert.deepEqual(skipped.map((s) => [s.name, s.reason]), [['gone', '路径不存在']]);
  const skills = await discoverSkills(roots);
  assert.deepEqual(skills.map((s) => s.name), ['fmt']);
  const tools = createFsTools(roots, skills);
  const t = (n) => tool(tools, n);
  const ls = await t('list_files').run({ depth: 3 });
  assert.match(ls, /Main\.java（\d+ B）/);
  assert.match(ls, /\.vela\//);
  assert.doesNotMatch(ls, /node_modules/);
  const hits = await t('search_files').run({ query: 'BRIDGE-MARKER' }, {});
  assert.match(hits, /proj\/Main\.java:2:/);
  assert.doesNotMatch(hits, /node_modules|ignored/);
  assert.match((await t('read_file').run({ path: 'proj/src/Svc.java' })).text, /1│class Svc/);
  assert.match((await t('read_file').run({ path: 'note.md' })).text, /1│单文件内容/);
  assert.match(await t('load_skill').run({ name: 'fmt' }), /SKILL-BRIDGE/);
  // 写：edit + 新建（父目录由 bridge fs.write 创建），走 fs.write
  await t('edit_file').run({ path: 'proj/src/Svc.java', old_string: '/* TODO: 退款 */', new_string: 'void refund() {}' });
  assert.equal(tree['C:'].proj.src['Svc.java'], 'class Svc { void refund() {} }');
  await t('write_file').run({ path: 'proj/docs/new.md', content: 'hello' });
  assert.equal(tree['C:'].proj.docs['new.md'], 'hello');
  assert.deepEqual(client.calls.filter((c) => c[0] === 'write').map((c) => c[1]).length, 2);
  // 列目录带 hidden + stat：一次往返拿到大小，不为 list_files 的每个文件再读内容
  assert.ok(client.calls.some((c) => c[0] === 'list' && c[2]?.hidden && c[2]?.stat));
  assert.equal(client.calls.filter((c) => c[0] === 'read' && /Main\.java$/.test(c[1])).length, 1, 'list_files 不读文件内容；只有 search 读了一次');
  await assert.rejects(t('read_file').run({ path: 'proj/nope.txt' }), /找不到/);
});

test('bridge 离线：本机路径条目整体跳过并给出原因', async () => {
  const { loadBridgeRoots } = await import('../src/kb/bridge-fs.js');
  const { roots, skipped } = await loadBridgeRoots(fakeBridgeClient({ __offline: true }), [{ id: 'k', kind: 'local', path: '/home/u/proj' }]);
  assert.equal(roots.length, 0);
  assert.match(skipped[0].reason, /bridge 未连接/);
  assert.equal(skipped[0].name, 'proj');
});

// ---- 快照条目（kind:'snapshot'，聊天卡降级添加的只读副本，kb/snapshot-fs.js 虚拟句柄） ----
const snapFile = (rel, content, name) => ({ rel, file: new File([content], name || (rel || 'f').split('/').pop(), { type: 'text/plain' }) });

test('快照虚拟句柄：目录树 + 同一套文件工具（读 / 搜 / 列 / skill），单文件根', async () => {
  const { buildSnapshotRoot } = await import('../src/kb/snapshot-fs.js');
  const files = [
    snapFile('src/Main.java', 'class Main { /* SNAP-MARKER */ }\n'),
    snapFile('README.md', '# 快照\nSNAP-README'),
    snapFile('.vela/skills/fmt/SKILL.md', '---\nname: fmt\ndescription: 快照规范\n---\n# 规范\nSNAP-SKILL'),
  ];
  const root = buildSnapshotRoot('demo-snap', files);
  assert.equal(root.kind, 'directory');
  const roots = [{ id: 's1', name: 'demo-snap', handle: root, kind: 'dir' }];
  const skills = await discoverSkills(roots);
  assert.deepEqual(skills.map((s) => s.name), ['fmt']);
  const tools = createFsTools(roots, skills);
  assert.match((await tool(tools, 'read_file').run({ path: 'demo-snap/src/Main.java' })).text, /1│class Main.*SNAP-MARKER/);
  assert.match(await tool(tools, 'search_files').run({ query: 'SNAP-README' }, {}), /demo-snap\/README\.md:2:/);
  assert.match(await tool(tools, 'list_files').run({}), /README\.md（/);
  assert.match(await tool(tools, 'load_skill').run({ name: 'fmt' }), /SNAP-SKILL/);
  // 单文件根：rel 为空 → 文件句柄，路径就是条目名
  const single = buildSnapshotRoot('notes.md', [snapFile('', '单行快照', 'notes.md')]);
  assert.equal(single.kind, 'file');
  assert.match((await tool(createFsTools([{ id: 's2', name: 'notes.md', handle: single, kind: 'file' }]), 'read_file').run({ path: 'notes.md' })).text, /1│单行快照/);
});

test('快照只读：write_file / edit_file 明确报错且原内容不变', async () => {
  const { buildSnapshotRoot } = await import('../src/kb/snapshot-fs.js');
  const root = buildSnapshotRoot('demo-snap', [snapFile('a.txt', 'AAA\nBBB\n')]);
  const tools = createFsTools([{ id: 's1', name: 'demo-snap', handle: root, kind: 'dir' }]);
  await assert.rejects(tool(tools, 'write_file').run({ path: 'demo-snap/new.md', content: 'x' }), /只读/);
  await assert.rejects(tool(tools, 'edit_file').run({ path: 'demo-snap/a.txt', old_string: 'AAA', new_string: 'X' }), /只读/);
  assert.match((await tool(tools, 'read_file').run({ path: 'demo-snap/a.txt' })).text, /AAA/);
  await assert.rejects(tool(tools, 'read_file').run({ path: 'demo-snap/nope.txt' }), /找不到/);
});

test('Agent prompt：快照条目与 handle 同样按工作区路径列出', async () => {
  const { buildAgentPrompt } = await import('../src/agent/compose.js');
  const conv = { knowledge: [
    { id: 'a', kind: 'snapshot', name: 'proj', handleKind: 'dir', wsPath: 'knowledge/proj' },
    { id: 'b', kind: 'snapshot', name: 'x.md', handleKind: 'file', wsPath: 'knowledge/x.md' },
  ] };
  const p = buildAgentPrompt(conv, { content: '问' }, { syncedIds: new Set(['b']) });
  assert.match(p, /- knowledge\/proj\/（proj）（本轮未同步，内容可能过期或缺失）/);
  assert.match(p, /- knowledge\/x\.md（x\.md）$/m);
});
