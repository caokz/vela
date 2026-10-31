// search_files 覆盖完整性 + fetch_url 的 404 处理（node:test，无浏览器）。
// 起因：用户在大项目（Flink 源码）里让模型搜类，search_files 遍历到 2 万条目上限就静默停止并报
// 「内容无匹配」，模型据此以为知识库里没有，转去联网并凭记忆猜 URL（分支名 master、包路径少一段）全 404。
// 用法：node scripts/test-search-unit.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFsTools } from '../src/llm/fs-tools.js';
import { LIMITS } from '../src/kb/files.js';
import { alternateBranchUrl, notFoundHint } from '../src/llm/browser-tools.js';

const err = (n) => Object.assign(new Error(n), { name: n });
class F {
  constructor(name, data) { this.kind = 'file'; this.name = name; this.data = data; }
  async getFile() { const d = this.data; return { name: this.name, size: d.length, lastModified: 0, arrayBuffer: async () => new TextEncoder().encode(d).buffer }; }
}
// 目录：gen 是异步生成器，可模拟「很多文件」而不占内存；truncated 模拟 bridge 单目录条目被截断
class D {
  constructor(name, gen, { truncated = false } = {}) { this.kind = 'directory'; this.name = name; this.gen = gen; this.truncated = false; this._t = truncated; }
  async *entries() { this.truncated = this._t; yield* this.gen(); }
  async getDirectoryHandle(n) { for await (const [k, v] of this.entries()) if (k === n && v.kind === 'directory') return v; throw err('NotFoundError'); }
  async getFileHandle(n) { for await (const [k, v] of this.entries()) if (k === n && v.kind === 'file') return v; throw err('NotFoundError'); }
}
const search = (root, args) => createFsTools([{ id: 'r', name: 'flink', handle: root, kind: 'dir' }]).find((t) => t.name === 'search_files').run(args, {});

// 字母序靠前的 aaa-big 里 25000 个文件，目标在靠后的 zzz-kafka 里（模拟大仓库）
const bigTree = () => new D('flink', async function* () {
  yield ['aaa-big', new D('aaa-big', async function* () { for (let i = 0; i < 25000; i++) yield [`f${String(i).padStart(5, '0')}.java`, new F(`f${i}.java`, 'class X {}')]; })];
  yield ['zzz-kafka', new D('zzz-kafka', async function* () { yield ['DynamicKafkaSource.java', new F('DynamicKafkaSource.java', 'public class DynamicKafkaSource {}')]; })];
});

test('大项目：目标排在 2 万个条目之后也能搜到（旧版静默停在 20000 并报「无匹配」）', async () => {
  const out = await search(bigTree(), { query: 'DynamicKafkaSource' });
  assert.match(out, /文件名匹配（1）：\n- flink\/zzz-kafka\/DynamicKafkaSource\.java/);
  assert.match(out, /flink\/zzz-kafka\/DynamicKafkaSource\.java:1: public class DynamicKafkaSource/);
  assert.doesNotMatch(out, /没有搜全/);
});

test('遍历达到条目上限：必须明确提示没搜全，而不是只说无匹配', async () => {
  const old = LIMITS.walkEntries;
  LIMITS.walkEntries = 100;
  try {
    const out = await search(bigTree(), { query: 'DynamicKafkaSource' });
    assert.match(out, /内容无匹配/);
    assert.match(out, /⚠ 没有搜全：目录遍历达到 100 个条目上限/);
    assert.match(out, /不要据此断定知识库里没有/);
  } finally { LIMITS.walkEntries = old; }
});

test('目录被数据源截断（bridge 单目录条目上限）：提示是哪些目录只列了一部分', async () => {
  const root = new D('flink', async function* () {
    yield ['pkg', new D('pkg', async function* () { yield ['A.java', new F('A.java', 'class A {}')]; }, { truncated: true })];
  });
  const out = await search(root, { query: 'NoSuchThing' });
  assert.match(out, /⚠ 没有搜全：这些目录条目过多、只列出了一部分：flink\/pkg/);
});

test('读取内容超时：报出已扫描 / 候选数', async () => {
  const old = LIMITS.searchBudgetMs;
  LIMITS.searchBudgetMs = -1; // 一开始就超时
  try {
    const out = await search(bigTree(), { query: 'x', glob: '*.java' });
    assert.match(out, /⚠ 没有搜全：读取文件内容超过 -?[\d.]+ 秒，只扫描了 0 \/ 25001 个候选文件/);
  } finally { LIMITS.searchBudgetMs = old; }
});

test('完整遍历后确实没有：明确说「已完整遍历 N 个文本文件」，不带警告', async () => {
  const root = new D('flink', async function* () { yield ['a.java', new F('a.java', 'class A {}')]; yield ['b.md', new F('b.md', '# b')]; });
  const out = await search(root, { query: 'Nope' });
  assert.match(out, /内容无匹配（扫描 2 个文件）/);
  assert.match(out, /已完整遍历 2 个文本文件，确实没有匹配/);
  assert.doesNotMatch(out, /⚠/);
});

test('并发读取：多文件命中按遍历顺序稳定输出，max_results 生效', async () => {
  const root = new D('flink', async function* () {
    for (let i = 0; i < 50; i++) yield [`F${String(i).padStart(2, '0')}.java`, new F(`F${i}.java`, `line1\nTARGET ${i}\nline3`)];
  });
  const out = await search(root, { query: 'TARGET', max_results: 5 });
  const hits = out.split('\n').filter((l) => /\.java:2:/.test(l));
  assert.deepEqual(hits.map((l) => l.match(/F(\d+)\.java/)[1]), ['00', '01', '02', '03', '04']);
  assert.match(out, /内容匹配（5\+，已达上限/);
});

test('fetch_url：raw.githubusercontent 的 master ↔ main 分支互换重试', () => {
  assert.equal(
    alternateBranchUrl('https://raw.githubusercontent.com/apache/flink-connector-kafka/master/flink-connector-kafka/A.java'),
    'https://raw.githubusercontent.com/apache/flink-connector-kafka/main/flink-connector-kafka/A.java',
  );
  assert.equal(alternateBranchUrl('https://raw.githubusercontent.com/o/r/main/x/y.md'), 'https://raw.githubusercontent.com/o/r/master/x/y.md');
  assert.equal(alternateBranchUrl('https://raw.githubusercontent.com/o/r/v1.2.3/x.md'), null, '标签 / commit 不换');
  assert.equal(alternateBranchUrl('https://example.com/o/r/master/x'), null, '非 raw.githubusercontent 不处理');
  assert.equal(alternateBranchUrl('not a url'), null);
});

test('fetch_url：404 的补充说明指向列目录核实路径', () => {
  const gh = notFoundHint('https://raw.githubusercontent.com/o/r/main/a/B.java');
  assert.match(gh, /分支名或路径拼错了/);
  assert.match(gh, /api\.github\.com\/repos\/<owner>\/<repo>\/contents/);
  assert.match(notFoundHint('https://example.com/docs/x'), /读上级页面/);
});
