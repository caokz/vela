// codex 适配器测试：拉起 codex-fake.mjs（假 app-server）走完整协议，
// 断言事件归一化、审批应答、resume / 取消 / 异常兜底与请求参数透传。

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAdapter, codexPolicy, resolveCodexCommand } from './agents/codex.js';

const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_MJS = join(BRIDGE_DIR, 'codex-fake.mjs');

// 假 codex 可执行文件：win32 用 .cmd 包一层（resolveCodexCommand 对 .cmd 自动带
// shell），posix 用 sh 脚本；都落到临时目录，指向真正的 codex-fake.mjs
const tmpDir = mkdtempSync(join(tmpdir(), 'vela-codex-fake-'));
const fakeExe = process.platform === 'win32'
  ? (writeFileSync(join(tmpDir, 'codex-fake.cmd'), `@node "${FAKE_MJS}" %*\r\n`, 'ascii'), join(tmpDir, 'codex-fake.cmd'))
  : (writeFileSync(join(tmpDir, 'codex-fake'), `#!/bin/sh\nexec node "${FAKE_MJS}" "$@"\n`, 'utf8'), chmodSync(join(tmpDir, 'codex-fake'), 0o755), join(tmpDir, 'codex-fake'));

const RUN_CAP_MS = 15000; // 单轮硬上限，协议坏了快速失败而不是挂死整个测试

// 跑一轮假 codex：设环境（适配器与子进程都读）→ startTurn 收集事件 → 落盘
// 断言数据回读。onEvent 可在事件流中做副作用（如收到首个增量后取消）。
async function runFake(scenario, {
  session: sessionOverrides = {},
  outcome = 'allow',
  resumeFail = false,
  onEvent = () => {},
} = {}) {
  const resultFile = join(tmpDir, `result-${scenario}-${Math.random().toString(36).slice(2)}.json`);
  const prev = { VELA_CODEX_PATH: process.env.VELA_CODEX_PATH, FAKE_SCENARIO: process.env.FAKE_SCENARIO, FAKE_RESULT_FILE: process.env.FAKE_RESULT_FILE, FAKE_RESUME_FAIL: process.env.FAKE_RESUME_FAIL };
  process.env.VELA_CODEX_PATH = fakeExe;
  process.env.FAKE_SCENARIO = scenario;
  process.env.FAKE_RESULT_FILE = resultFile;
  if (resumeFail) process.env.FAKE_RESUME_FAIL = '1';

  const events = [];
  const asks = [];
  const signal = new AbortController();
  const session = { cwd: BRIDGE_DIR, contextDirs: ['E:/ws/kb'], agentSessionId: '', permissionMode: 'default', model: '', ...sessionOverrides };
  try {
    await Promise.race([
      codexAdapter.startTurn(session, '测试输入', {
        emit: (event) => { events.push(event); onEvent(event, { signal }); },
        signal: signal.signal,
        onPermission: async (req) => { asks.push(req); return outcome; },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('runFake 超时：适配器未结束')), RUN_CAP_MS).unref?.()),
    ]);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  await new Promise((r) => setTimeout(r, 150)); // 等子进程 exit 落盘
  let recorded = { approvals: [], seen: {} };
  try { recorded = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { /* exit-fast 等场景可能没写全 */ }
  return { events, asks, session, recorded };
}

const kinds = (events) => events.map((e) => e.kind);
const chunkText = (events) => events.filter((e) => e.kind === 'message_chunk').map((e) => e.text).join('');

test('codexPolicy：权限模式映射 sandbox 与审批策略', () => {
  assert.deepEqual(codexPolicy('default'), { sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  assert.deepEqual(codexPolicy('acceptEdits'), { sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  assert.deepEqual(codexPolicy('bypassPermissions'), { sandbox: 'danger-full-access', approvalPolicy: 'never' });
});

test('resolveCodexCommand：VELA_CODEX_PATH 覆盖，.cmd 自动带 shell', () => {
  const prev = process.env.VELA_CODEX_PATH;
  process.env.VELA_CODEX_PATH = 'C:/tools/codex.exe';
  assert.deepEqual(resolveCodexCommand(), { command: 'C:/tools/codex.exe', args: [], shell: false });
  process.env.VELA_CODEX_PATH = 'C:/tools/codex.cmd';
  assert.deepEqual(resolveCodexCommand(), { command: 'C:/tools/codex.cmd', args: [], shell: process.platform === 'win32' });
  if (prev === undefined) delete process.env.VELA_CODEX_PATH; else process.env.VELA_CODEX_PATH = prev;
});

test('完整轮次：增量/工具/审批/用量归一化，threadId 回填会话', async () => {
  const { events, asks, session, recorded } = await runFake('full');
  assert.equal(session.agentSessionId, 'th_fake_new');
  assert.ok(kinds(events).includes('session_info'));
  assert.equal(events.find((e) => e.kind === 'session_info').agentSessionId, 'th_fake_new');
  assert.equal(chunkText(events), '你好，结果在此');
  const call = events.find((e) => e.kind === 'tool_call');
  assert.ok(call.id === 'exec_1');
  assert.match(call.title, /git status/);
  const upd = events.find((e) => e.kind === 'tool_call_update' && e.id === 'exec_1');
  assert.equal(upd.status, 'completed');
  assert.equal(upd.result, 'nothing to commit');
  assert.equal(events.find((e) => e.kind === 'usage').durationMs, 42);
  const end = events.at(-1);
  assert.equal(end.kind, 'turn_end');
  assert.equal(end.stopReason, 'end');
  // 审批：标题 + 命令摘要回传，决策回包是 accept
  assert.equal(asks.length, 1);
  assert.match(asks[0].detail, /git status/);
  assert.deepEqual(recorded.approvals, [{ decision: 'accept' }]);
  // 请求参数透传：cwd / sandbox / approvalPolicy / 知识库目录 → 可写根
  assert.equal(recorded.seen.threadStart.cwd, BRIDGE_DIR);
  assert.equal(recorded.seen.threadStart.sandbox, 'workspace-write');
  assert.equal(recorded.seen.threadStart.approvalPolicy, 'on-request');
  assert.deepEqual(recorded.seen.turnStart.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['E:/ws/kb'] });
});

test('拒绝审批：decision=decline，工具步骤状态 cancelled', async () => {
  const { events, recorded } = await runFake('deny', { outcome: 'deny' });
  assert.deepEqual(recorded.approvals, [{ decision: 'decline' }]);
  const upd = events.find((e) => e.kind === 'tool_call_update' && e.id === 'exec_1');
  assert.equal(upd.status, 'cancelled');
  assert.equal(events.at(-1).stopReason, 'end'); // 拒绝后 turn 照常走完
});

test('旧版 execCommandApproval：decision 词汇换 approved/denied', async () => {
  const { recorded } = await runFake('legacy');
  assert.deepEqual(recorded.approvals, [{ decision: 'approved' }]);
});

test('文件修改审批：item 缓存反查路径列表', async () => {
  const { asks, recorded } = await runFake('filechange');
  assert.match(asks[0].detail, /a\.md/);
  assert.deepEqual(recorded.approvals, [{ decision: 'accept' }]);
});

test('未知服务端请求也必须有回包（elicitation → decline）', async () => {
  const { events, recorded } = await runFake('unknown-req');
  assert.deepEqual(recorded.approvals, [{ action: 'decline' }]);
  assert.equal(events.at(-1).stopReason, 'end');
});

test('思考增量 → thought_chunk', async () => {
  const { events } = await runFake('reasoning');
  assert.equal(events.find((e) => e.kind === 'thought_chunk')?.text, '先想一下');
});

test('续聊走 thread/resume 且 threadId 不变；resume 失败降级开新线程', async () => {
  const ok = await runFake('full', { session: { agentSessionId: 'th_prev' } });
  assert.equal(ok.recorded.seen.threadResume?.threadId, 'th_prev');
  assert.equal(ok.session.agentSessionId, 'th_prev');
  const fallen = await runFake('full', { session: { agentSessionId: 'th_gone' }, resumeFail: true });
  assert.equal(fallen.recorded.seen.threadResume?.threadId, 'th_gone');
  assert.ok(fallen.recorded.seen.threadStart);
  assert.equal(fallen.session.agentSessionId, 'th_fake_new');
});

test('bypassPermissions：请求带 danger-full-access/never 且不追加可写根', async () => {
  const { recorded } = await runFake('full', { session: { permissionMode: 'bypassPermissions' } });
  assert.equal(recorded.seen.threadStart.sandbox, 'danger-full-access');
  assert.equal(recorded.seen.threadStart.approvalPolicy, 'never');
  assert.equal(recorded.seen.turnStart.sandboxPolicy, undefined);
});

test('会话模型透传到 thread/start', async () => {
  const { recorded } = await runFake('full', { session: { model: 'gpt-fake-2' } });
  assert.equal(recorded.seen.threadStart.model, 'gpt-fake-2');
});

test('取消：turn/interrupt → turn_end cancelled', async () => {
  const { events, recorded } = await runFake('interrupt', {
    onEvent: (e, { signal }) => { if (e.kind === 'message_chunk' && e.text.includes('结果')) signal.abort(); },
  });
  assert.ok(recorded.seen.interrupts >= 1);
  assert.equal(events.at(-1).kind, 'turn_end');
  assert.equal(events.at(-1).stopReason, 'cancelled');
});

test('turn 失败：错误文案透传', async () => {
  const { events } = await runFake('fail');
  const end = events.find((e) => e.kind === 'turn_end');
  assert.equal(end.stopReason, 'error');
  assert.match(end.error, /配额不足/);
});

test('进程崩溃兜底：turn_end error', async () => {
  const { events } = await runFake('exit-fast');
  const end = events.find((e) => e.kind === 'turn_end');
  assert.equal(end.stopReason, 'error');
  assert.match(end.error, /意外退出|启动 codex 失败/);
});

test('listModels：app-server 拉取并过滤 hidden', async () => {
  const prev = process.env.VELA_CODEX_PATH;
  process.env.VELA_CODEX_PATH = fakeExe;
  try {
    assert.deepEqual(await codexAdapter.listModels(), ['gpt-fake-1', 'gpt-fake-2']);
  } finally {
    if (prev === undefined) delete process.env.VELA_CODEX_PATH; else process.env.VELA_CODEX_PATH = prev;
  }
});
