// 冒烟测试：加载未打包扩展 → 验证 SW 注册与 storage 可用、三个页面渲染、控制台无错误。
// 零依赖（Node 22+ 内置 WebSocket）。默认使用 Playwright Chromium（支持 --load-extension）。
// 用法：node scripts/smoke-test.mjs [chrome.exe 路径]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/chrome.mjs';

const EXT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.argv[2] || findChrome();
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'vela-smoke-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT_ROOT}`,
  `--disable-extensions-except=${EXT_ROOT}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let msgId = 0;
const failures = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
}

// 持久 CDP 会话：单条 WebSocket 上复用请求并收集事件
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败 ' + wsUrl)); });
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
    else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, events, close: () => ws.close() };
}

async function evalInPage(sess, expr) {
  const r = await sess.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
}

// SW 刚注册/刚唤醒时 evaluate 偶发拿不到结果，轮询重试直到有值
async function evalRetry(sess, expr, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const v = await evalInPage(sess, expr).catch(() => undefined);
    if (v !== undefined && v !== null) return v;
    await sleep(500);
  }
  return undefined;
}

async function openPage(url) {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${url}`, { method: 'PUT' })).json();
  await sleep(300);
  const sess = await connect(t.webSocketDebuggerUrl);
  await sess.send('Runtime.enable');
  await sess.send('Page.enable');
  await sess.send('Page.reload');
  await sleep(1200); // 等 module 脚本执行
  return { t, sess };
}

try {
  // 等 CDP 就绪 + 我们的 SW 注册（--disable-extensions-except 之外 Playwright 还带组件扩展，按路径精确匹配）
  let swTarget = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      swTarget = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background/service-worker.js'));
      if (swTarget) break;
    } catch { /* retry */ }
  }
  if (!swTarget) throw new Error('CDP 未就绪或扩展 SW 未注册');
  check('service worker 注册', Boolean(swTarget), swTarget?.url ?? '未找到');
  if (!swTarget) throw new Error('SW 未注册');

  const extId = new URL(swTarget.url).host;
  check('扩展 ID 解析', /^[a-p]{32}$/.test(extId), extId);

  const swSess = await connect(swTarget.webSocketDebuggerUrl);
  await swSess.send('Runtime.enable');
  await sleep(1000); // SW onInstalled 异步链（rebuildMenus）起步

  // 隔离本地 bridge：token 自动配对会让冒烟 profile 连上真机 127.0.0.1:39217，
  // 连接态/模型列表随环境漂移。指向死端口，保持断连与静态模型别名的确定性行为
  await evalInPage(swSess, `(async () => {
    await chrome.storage.local.set({ llmSettings: { agentBridge: { url: 'ws://127.0.0.1:39299', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' } } });
    return 'ok';
  })()`);

  // manifest v2 契约：scripting 权限 + <all_urls> 主机授权
  const manifest = await evalRetry(swSess, `(async () => {
    const r = await fetch(chrome.runtime.getURL('manifest.json'));
    const m = await r.json();
    return JSON.stringify({ v: m.version, perms: m.permissions, hosts: m.host_permissions });
  })()`).then((s) => (typeof s === 'string' ? JSON.parse(s) : {}));
  check('manifest scripting 权限', manifest.perms.includes('scripting'), manifest.perms.join(','));
  check('manifest <all_urls> 授权', manifest.hosts?.includes('<all_urls>') === true, (manifest.hosts ?? []).join(','));
  const diskVer = JSON.parse(readFileSync(join(EXT_ROOT, 'manifest.json'), 'utf8')).version;
  check(`manifest 版本 ${diskVer}`, manifest.v === diskVer, manifest.v);

  const storageVal = await evalInPage(swSess, `(async () => {
    try {
      await chrome.storage.local.set({ __smoke: 1 });
      const ok = (await chrome.storage.local.get('__smoke')).__smoke === 1 ? 'ok' : 'fail';
      await chrome.storage.local.remove('__smoke');
      return ok;
    } catch (e) { return 'error: ' + e.message; }
  })()`);
  check('SW chrome.storage 可用', storageVal === 'ok', storageVal);
  check('SW chrome.scripting 可用', await evalInPage(swSess, `typeof chrome.scripting?.executeScript === 'function' ? 'ok' : 'fail'`) === 'ok');
  // 菜单在 onInstalled 里异步重建，轮询等待（contextMenus 无 getAll，用 update+lastError 探测）
  let menusOk = 'fail';
  for (let i = 0; i < 10 && menusOk !== 'ok'; i++) {
    await sleep(500);
    menusOk = await evalInPage(swSess, `new Promise((res) => {
      try {
        chrome.contextMenus.update('om-root', {}, () => {
          const err = chrome.runtime.lastError;
          res(err ? 'fail:' + err.message : 'ok');
        });
      } catch (e) { res('error: ' + e.message); }
    })`);
  }
  check('SW 右键菜单已建', menusOk === 'ok', menusOk);
  // 页面浮窗 + 划词工具条 content script 注册（onInstalled 异步链，轮询等待）
  let widgetOk = 'fail';
  for (let i = 0; i < 10 && widgetOk === 'fail'; i++) {
    await sleep(500);
    widgetOk = await evalRetry(swSess, `(async () => {
      const list = await chrome.scripting.getRegisteredContentScripts();
      return JSON.stringify(list.find((s) => s.id === 'om-widget')?.js ?? []);
    })()`) === JSON.stringify(['src/content/widget.js', 'src/content/selection-popup.js']) ? 'ok' : 'fail';
  }
  check('SW 浮窗与划词工具条 content script 已注册', widgetOk === 'ok', widgetOk);
  swSess.close();

  for (const page of ['options/options.html', 'sidepanel/sidepanel.html', 'chatpage/chat.html']) {
    const { t, sess } = await openPage(`chrome-extension://${extId}/src/${page}`);
    const name = page.split('/')[0];
    const dom = JSON.parse(await evalInPage(sess, page.includes('options')
      ? `JSON.stringify({
          cards: document.querySelectorAll('.provider').length,
          hasSave: !!document.getElementById('om-save'),
          hasTxLang: !!document.getElementById('om-tx-lang'),
          hasTxMode: !!document.getElementById('om-tx-mode'),
          hasBaseDir: !!document.getElementById('om-agent-basedir'),
          hasPermSelect: !!document.getElementById('om-agent-perm'),
          hasAgentModel: !!document.getElementById('om-agent-model'),
          // bridge 启停管理：启动/停止按钮 + 实时连接状态
          hasStartBtn: !!document.getElementById('om-agent-start'),
          hasStopBtn: !!document.getElementById('om-agent-stop'),
          connState: document.getElementById('om-agent-conn')?.textContent || '',
          qaRows: document.querySelectorAll('.qa-row').length,
        })`
      : `JSON.stringify({
          topbar: !!document.getElementById('om-topbar'),
          msgs: !!document.getElementById('om-messages'),
          composer: !!document.getElementById('om-composer'),
          sidebar: !!document.getElementById('om-sidebar'),
          convItems: document.querySelectorAll('.om-conv-item').length,
          topSettings: !!document.getElementById('om-topbar-settings'),
          // 顶栏引擎切换已移除（默认本地 Agent 模式）：选择框不应存在
          // 引擎切换下拉（Agent / LLM 问答 / LLM 任务）：新会话默认 Agent
          engineVal: document.getElementById('om-engine')?.value || '',
          engineOpts: [...(document.getElementById('om-engine')?.options || [])].map((o) => o.value).join(','),
          // agent 会话的输入框下方权限模式与 agent 模型下拉存在
          permSelect: !!document.getElementById('om-perm'),
          agentModelSel: !!document.getElementById('om-agent-model-sel'),
          // 跳到最新浮标与 agent 停止按钮存在（默认隐藏）
          jumpBtn: !!document.getElementById('om-jump'),
          stopBtn: !!document.getElementById('om-stop'),
          jumpHidden: document.getElementById('om-jump')?.hidden === true,
          stopHidden: document.getElementById('om-stop')?.hidden === true,
          // 目录绑定栏已移除（工作区由 baseDir/<会话 id> 自动生成）
          noDirBar: !document.querySelector('.om-dir-bar'),
          attachBtn: !!document.getElementById('om-attach'),
          kbBtn: !!document.getElementById('om-kb'),
          exportBtn: !!document.getElementById('om-export'),
          convEditBtns: document.querySelectorAll('.om-conv-edit').length,
          emptySettings: !!document.getElementById('om-empty-settings'),
          noSummarize: !document.getElementById('om-summarize'),
          noTranslate: !document.getElementById('om-translate'),
        })`) ?? '{}');
    if (page.includes('options')) {
      check(`${name} 渲染`, (dom.cards ?? 0) >= 1 && dom.hasSave, `provider cards=${dom.cards}`);
      check(`${name} 翻译设置控件`, dom.hasTxLang && dom.hasTxMode, JSON.stringify(dom));
      check(`${name} 工作基础目录配置项`, dom.hasBaseDir, JSON.stringify(dom));
      check(`${name} 权限模式默认值配置项`, dom.hasPermSelect, JSON.stringify(dom));
      check(`${name} agent 模型配置项`, dom.hasAgentModel, JSON.stringify(dom));
      // 死端口上的自动重连让灯在 未连接/连接中 之间切换，两者都不是 ready 即通过
      check(`${name} bridge 启停按钮与连接状态`, dom.hasStartBtn && dom.hasStopBtn && !dom.connState.includes('已连接'), JSON.stringify(dom));
      check(`${name} 快捷动作编辑器（默认 4 条）`, (dom.qaRows ?? 0) >= 4, `qaRows=${dom.qaRows}`);
    } else {
      check(`${name} 渲染`, dom.topbar && dom.msgs && dom.composer, JSON.stringify(dom));
      check(`${name} 侧栏骨架`, dom.sidebar && (dom.convItems ?? 0) >= 1, JSON.stringify(dom));
      check(`${name} 设置入口（顶栏齿轮；引擎下拉默认 Agent、无引导卡）`, dom.topSettings && dom.engineVal === 'agent' && dom.engineOpts === 'agent,llm,llm-tools' && !dom.emptySettings && dom.noSummarize && dom.noTranslate, JSON.stringify(dom));
      check(`${name} 附件与知识库入口（目录绑定栏已移除）`, dom.attachBtn && dom.kbBtn && dom.noDirBar, JSON.stringify(dom));
      check(`${name} 顶栏导出按钮与会话重命名按钮`, dom.exportBtn && (dom.convEditBtns ?? 0) >= 1, JSON.stringify(dom));
      check(`${name} 输入框下方权限模式与 agent 模型下拉`, dom.permSelect === true && dom.agentModelSel === true, JSON.stringify(dom));
      check(`${name} 跳到最新浮标与 agent 停止按钮（默认隐藏）`, dom.jumpBtn === true && dom.stopBtn === true && dom.jumpHidden && dom.stopHidden, JSON.stringify(dom));
    }
    // 交互冒烟：无供应商时应不 throw（发送按钮点击被模型守卫拦截）
    const clickErr = await evalInPage(sess, `(() => {
      try {
        document.getElementById('om-send')?.click();
        document.getElementById('om-add')?.click();
        return 'ok';
      } catch (e) { return 'error: ' + e.message; }
    })()`);
    check(`${name} 交互无异常`, clickErr === 'ok', clickErr);
    // 控制台错误（exceptionThrown / console API error 级别）
    const errs = sess.events
      .filter((e) => e.method === 'Runtime.exceptionThrown'
        || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
      .map((e) => JSON.stringify(e.params?.exceptionDetails?.exception?.description
        ?? e.params?.args?.[0]?.value ?? '').slice(0, 200));
    check(`${name} 无控制台错误`, errs.length === 0, errs.join(' | ') || 'clean');
    sess.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
  }

  // ---- 会话排序 + 重命名 + 导出弹层（chatpage 种子数据复检）----
  {
    const { t, sess } = await openPage(`chrome-extension://${extId}/src/chatpage/chat.html`);
    const seed = await evalInPage(sess, `(async () => {
      const now = Date.now();
      const mk = (id, title, created, itemAt) => ({
        id, title, createdAt: created, updatedAt: created,
        items: itemAt ? [{ id: 'msg:' + id, conversationId: id, type: 'question', parentItemId: '', content: 'x', createdAt: itemAt }] : [],
      });
      await chrome.storage.local.set({ conversations: [
        mk('conv:old', '旧会话', now - 90000, now - 80000), // 创建早、消息也早 → 应排最后
        mk('conv:new', '新会话', now - 200000, now - 1000), // 创建更早但最后消息最新 → 应排最前
        mk('conv:empty', '无消息', now - 5000, null),       // 无消息看 createdAt → 居中
      ]});
      return 'ok';
    })()`);
    check('种子会话写入', seed === 'ok', String(seed));
    await sess.send('Page.reload');
    await sleep(1500);
    const order = await evalInPage(sess, `JSON.stringify([...document.querySelectorAll('.om-conv-item .om-conv-title')].map((e) => e.textContent))`);
    check('会话列表按活跃时间降序', order === JSON.stringify(['新会话', '无消息', '旧会话']), order);

    const rename = await evalInPage(sess, `(async () => {
      const item = [...document.querySelectorAll('.om-conv-item')]
        .find((e) => e.querySelector('.om-conv-title')?.textContent === '新会话');
      if (!item) return 'no-item';
      item.querySelector('.om-conv-edit').click();
      const input = item.querySelector('.om-conv-title-input');
      if (!input) return 'no-input';
      input.value = '改名后的会话';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 500));
      const stored = await chrome.storage.local.get('conversations');
      const conv = stored.conversations.find((c) => c.id === 'conv:new');
      return conv?.title === '改名后的会话' ? 'ok' : 'title=' + conv?.title;
    })()`);
    check('铅笔按钮重命名（Enter 提交落 storage）', rename === 'ok', String(rename));

    const dbl = await evalInPage(sess, `(async () => {
      const title = [...document.querySelectorAll('.om-conv-item .om-conv-title')]
        .find((e) => e.textContent === '旧会话');
      if (!title) return 'no-title';
      const item = title.closest('.om-conv-item'); // replaceWith 会把 title 摘出 DOM，先拿住父项
      title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      const input = item.querySelector('.om-conv-title-input');
      if (!input) return 'no-input';
      input.value = '   '; // 空值回退原标题
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 500));
      const stored = await chrome.storage.local.get('conversations');
      const conv = stored.conversations.find((c) => c.id === 'conv:old');
      return conv?.title === '旧会话' ? 'ok' : 'title=' + conv?.title;
    })()`);
    check('双击进入编辑、空值回退原标题', dbl === 'ok', String(dbl));

    // 输入框下方权限模式切换：写回当前选中会话的 permissionMode。
    // 启动默认选中 lastActive 最新的 conv:new，先点选 conv:old 再切换，断言才有着落
    await evalInPage(sess, `[...document.querySelectorAll('.om-conv-item')]
      .find((e) => e.dataset.convId === 'conv:old').click()`);
    await sleep(300);
    const perm = await evalInPage(sess, `(async () => {
      const sel = document.getElementById('om-perm');
      if (!sel) return 'missing';
      if (sel.value !== 'default') return 'value=' + sel.value; // 旧会话无字段 → 设置页默认
      sel.value = 'acceptEdits';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const stored = await chrome.storage.local.get('conversations');
      const conv = stored.conversations.find((c) => c.id === 'conv:old');
      return conv?.permissionMode === 'acceptEdits' ? 'ok' : 'perm=' + conv?.permissionMode;
    })()`);
    check('权限模式切换落 storage（下一轮生效）', perm === 'ok', String(perm));

    // 输入框下方 agent 模型下拉：切到 sonnet 写回 conv.model，切回空值删除字段
    const modelSel = await evalInPage(sess, `(async () => {
      const sel = document.getElementById('om-agent-model-sel');
      if (!sel) return 'missing';
      if (sel.value !== '') return 'value=' + sel.value; // 旧会话无字段 → 默认模型
      if (!sel.querySelector('option[value="sonnet"]')) return 'no-sonnet-option';
      sel.value = 'sonnet';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const stored = await chrome.storage.local.get('conversations');
      let conv = stored.conversations.find((c) => c.id === 'conv:old');
      if (conv?.model !== 'sonnet') return 'model=' + conv?.model;
      sel.value = '';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const stored2 = await chrome.storage.local.get('conversations');
      conv = stored2.conversations.find((c) => c.id === 'conv:old');
      return conv?.model === undefined ? 'ok' : 'model-not-cleared=' + conv?.model;
    })()`);
    check('agent 模型下拉切换落 storage（空值清回默认）', modelSel === 'ok', String(modelSel));

    // 知识库弹层：工作目录绑定行存在（bridge 未连接时也能渲染默认态）
    const kb = await evalInPage(sess, `(async () => {
      const btn = document.getElementById('om-kb');
      if (!btn) return 'missing';
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const row = document.querySelector('.om-kb-pop .om-kb-cwd');
      const text = row?.textContent || '';
      document.querySelector('.om-kb-pop') && (document.querySelector('.om-kb-pop').hidden = true);
      return row && text.includes('默认独立工作区') ? 'ok' : 'row=' + text;
    })()`);
    check('知识库弹层含工作目录绑定行', kb === 'ok', String(kb));

    // 当前会话是存储序第一项 conv:old：先选中 conv:new（已改名）再开导出弹层
    await evalInPage(sess, `[...document.querySelectorAll('.om-conv-item')]
      .find((e) => e.dataset.convId === 'conv:new').click()`);
    await sleep(300);
    const exp = await evalInPage(sess, `(async () => {
      const btn = document.getElementById('om-export');
      if (!btn) return 'missing';
      if (btn.disabled) return 'disabled';
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const pop = document.querySelector('.om-export-pop');
      const name = pop?.querySelector('.om-export-name')?.value ?? '';
      if (!/^\\d{8}-\\d{4}_改名后的会话\\.md$/.test(name)) return 'name=' + name;
      const hasWhere = !!pop.querySelector('.om-export-where');
      // 点「取消」关闭弹层（不能点第一个按钮：那是「导出」，会真发一轮）
      [...pop.querySelectorAll('.om-kb-actions button')].find((b) => b.textContent === '取消')?.click();
      return hasWhere || !!pop.querySelector('.om-export-note') ? 'ok' : 'no-dir-ui';
    })()`);
    check('导出弹层预填自动文件名', exp === 'ok', String(exp));

    // 切到无消息会话：导出按钮置灰
    await evalInPage(sess, `[...document.querySelectorAll('.om-conv-item')]
      .find((e) => e.dataset.convId === 'conv:empty').click()`);
    await sleep(300);
    const emptyDisabled = await evalInPage(sess, `document.getElementById('om-export')?.disabled`);
    check('空会话导出按钮置灰', emptyDisabled === true, String(emptyDisabled));

    // 控制台错误兜底
    const errs = sess.events
      .filter((e) => e.method === 'Runtime.exceptionThrown'
        || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
      .map((e) => JSON.stringify(e.params?.exceptionDetails?.exception?.description
        ?? e.params?.args?.[0]?.value ?? '').slice(0, 200));
    check('chatpage 交互复检无控制台错误', errs.length === 0, errs.join(' | ') || 'clean');
    sess.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
  }

  // ---- agent 步骤离线回放：子智能体分组 + 每步耗时 + 轮统计；markdown 表格 ----
  {
    const { t, sess } = await openPage(`chrome-extension://${extId}/src/chatpage/chat.html`);
    const seed = await evalInPage(sess, `(async () => {
      await chrome.storage.local.set({ conversations: [{
        id: 'conv:agent', title: 'agent 会话', createdAt: Date.now(), updatedAt: Date.now(), engine: 'agent',
        items: [
          { id: 'msg:q1', conversationId: 'conv:agent', type: 'question', parentItemId: '', content: '分析', createdAt: Date.now() },
          {
            id: 'msg:a1', conversationId: 'conv:agent', type: 'answer', parentItemId: 'msg:q1',
            content: '| 阶段 | 组件 | 动作 |\\n| --- | --- | --- |\\n| 触发 | Job | checkpoint() |', model: 'agent · Claude Code', createdAt: Date.now(),
            meta: { agent: {
              agentId: 'claude-code', agentSessionId: '',
              steps: [
                { id: 't1', title: 'Task: 分析 flink', status: 'completed', detail: '', parentId: '', durationMs: 83000 },
                { id: 't2', title: 'Grep: barrier', status: 'completed', result: '3 matches', parentId: 't1', durationMs: 4200 },
                { id: 't3', title: 'Read: Checkpoint.java', status: 'completed', detail: '', parentId: 't1', durationMs: 1200 },
                { id: 't4', title: 'Glob: **/*.java', status: 'completed', detail: '', parentId: '', durationMs: 800 },
              ],
              thought: '', durationMs: 95000, costUSD: 0.1234,
            } },
        }],
      }]});
      return 'ok';
    })()`);
    check('agent 会话种子写入', seed === 'ok', String(seed));
    await sess.send('Page.reload');
    await sleep(1500);
    const dom = await evalInPage(sess, `(() => {
      const stats = document.querySelector('.om-msg-answer .om-meta-stats')?.textContent || '';
      const group = document.querySelector('.om-agent-step-group');
      return JSON.stringify({
        summary: document.querySelector('.om-agent-subagents')?.textContent || '',
        groupTitle: group?.querySelector('.om-agent-step-title')?.textContent || '',
        childCount: group?.querySelectorAll('.om-agent-step-children > .om-agent-step').length ?? -1,
        topLevelSteps: document.querySelectorAll('.om-agent-steps > .om-agent-step').length,
        durs: [...document.querySelectorAll('.om-agent-step-dur')].map((e) => e.textContent),
        stats,
        tableCells: document.querySelectorAll('.om-md-table th, .om-md-table td').length,
      });
    })()`) ?? '{}';
    const d = JSON.parse(dom);
    check('子智能体汇总行（运行了 1 个子智能体）', d.summary === '运行了 1 个子智能体', dom);
    check('子步骤折叠进 Task 组、顶层不混入', d.groupTitle === 'Task: 分析 flink' && d.childCount === 2 && d.topLevelSteps === 2, dom);
    check('每步耗时徽标与轮统计', d.durs.includes('4s') && d.durs.includes('1m23s') && d.stats.includes('1m35s') && d.stats.includes('$0.12'), dom);
    check('Markdown 表格渲染（含表头 3+3 单元格）', (d.tableCells ?? 0) === 6, dom);
    const errs = sess.events
      .filter((e) => e.method === 'Runtime.exceptionThrown'
        || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
      .map((e) => JSON.stringify(e.params?.args?.[0]?.value ?? '').slice(0, 200));
    check('agent 回放复检无控制台错误', errs.length === 0, errs.join(' | ') || 'clean');
    sess.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
  }
} catch (e) {
  check('冒烟流程', false, e.message);
} finally {
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 目录占用忽略 */ }
}
process.exit(failures.length ? 1 : 0);
