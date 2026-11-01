// 假 codex app-server：按行分帧的 JSON-RPC，复刻 0.162.x 实测协议
// （initialize / thread/start|resume / turn/start / 审批请求 / turn/completed）。
// 仅测试用，被 codex-adapter.test.js 经 VELA_CODEX_PATH 拉起。行为由
// FAKE_SCENARIO 环境变量驱动，收到的审批决策落盘 FAKE_RESULT_FILE 供断言。

import { writeSync, writeFileSync } from 'node:fs';

const SCENARIO = process.env.FAKE_SCENARIO || 'full';
let approvals = []; // 收到的审批决策
const seen = { threadStart: null, threadResume: null, turnStart: null, interrupts: 0 }; // 客户端请求参数留档
let nextId = 100;
const openApprovals = new Map(); // 审批请求 id -> resolve(客户端回包)
const interruptWaiters = [];

const log = (obj) => writeSync(1, JSON.stringify(obj) + '\n');
const respond = (id, result) => log({ id, result });
const respondError = (id, message) => log({ id, error: { code: -32601, message } });
const notify = (method, params) => log({ method, params });

// 状态即时落盘：bridge 用 taskkill /F、SIGTERM 收尾，exit 钩子不会执行，
// 必须在每次变化后就写，测试才能读到最终状态
function persist() {
  if (process.env.FAKE_RESULT_FILE) {
    try { writeFileSync(process.env.FAKE_RESULT_FILE, JSON.stringify({ approvals, seen })); } catch { /* 忽略 */ }
  }
}

// 服务端审批请求：发出带 id 的请求行，挂起等客户端回包
function requestApproval(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    openApprovals.set(id, resolve);
    log({ id, method, params });
  });
}

async function runTurn(threadId) {
  const turnId = 'turn_1';
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
  if (SCENARIO === 'reasoning') {
    notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: 'rs_1', delta: '先想一下' });
  }
  if (SCENARIO === 'exit-fast') {
    process.exit(1); // 模拟进程崩溃：turn 没结束进程先没了
  }
  const msgId = 'msg_1';
  notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: msgId, text: '' }, startedAtMs: Date.now() });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: msgId, delta: '你好，' });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: msgId, delta: '结果在此' });

  if (['full', 'deny', 'legacy', 'filechange', 'unknown-req'].includes(SCENARIO)) {
    const execId = 'exec_1';
    notify('item/started', {
      threadId, turnId,
      item: { type: 'commandExecution', id: execId, command: 'git status', cwd: 'E:/code/vela', status: 'inProgress' },
      startedAtMs: Date.now(),
    });
    if (SCENARIO === 'filechange') {
      notify('item/started', {
        threadId, turnId,
        item: { type: 'fileChange', id: 'fc_1', status: 'inProgress', changes: [{ path: 'E:/ws/a.md', kind: 'update', diff: 'x' }] },
        startedAtMs: Date.now(),
      });
      const d = await requestApproval('item/fileChange/requestApproval', { threadId, turnId, itemId: 'fc_1', reason: '写入文件' });
      notify('item/completed', {
        threadId, turnId,
        item: { type: 'fileChange', id: 'fc_1', status: d.decision === 'accept' ? 'completed' : 'declined', changes: [{ path: 'E:/ws/a.md', kind: 'update' }] },
        completedAtMs: Date.now(),
      });
    } else if (SCENARIO === 'unknown-req') {
      await requestApproval('mcpServer/elicitation/request', { serverName: 'srv', threadId });
    } else {
      const method = SCENARIO === 'legacy' ? 'execCommandApproval' : 'item/commandExecution/requestApproval';
      const params = SCENARIO === 'legacy'
        ? { callId: execId, command: ['git', 'status'], conversationId: threadId, cwd: 'E:/code/vela', parsedCmd: [] }
        : { threadId, turnId, itemId: execId, command: 'git status', cwd: 'E:/code/vela' };
      const d = await requestApproval(method, params);
      const allowed = SCENARIO === 'legacy' ? d.decision === 'approved' : d.decision === 'accept';
      notify('item/completed', {
        threadId, turnId,
        item: {
          type: 'commandExecution', id: execId, command: 'git status', cwd: 'E:/code/vela',
          status: allowed ? 'completed' : 'declined',
          aggregatedOutput: allowed ? 'nothing to commit' : null,
          exitCode: allowed ? 0 : null, durationMs: 12,
        },
        completedAtMs: Date.now(),
      });
    }
  }

  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: msgId, text: '你好，结果在此' }, completedAtMs: Date.now() });
  notify('thread/tokenUsage/updated', {
    threadId, turnId,
    tokenUsage: { total: { totalTokens: 100, inputTokens: 80, outputTokens: 20 }, last: { totalTokens: 100 } },
  });

  if (SCENARIO === 'interrupt') {
    await new Promise((resolve) => interruptWaiters.push(resolve)); // 等 turn/interrupt 到达
  }
  const status = SCENARIO === 'fail' ? 'failed' : SCENARIO === 'interrupt' ? 'interrupted' : 'completed';
  notify('turn/completed', {
    threadId,
    turn: { id: turnId, status, durationMs: 42, error: status === 'failed' ? { message: '配额不足' } : null },
  });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(JSON.parse(line));
  }
});

function handle(msg) {
  if (msg.method && msg.id != null) {
    switch (msg.method) {
      case 'initialize':
        respond(msg.id, { userAgent: 'codex-fake', codexHome: 'C:/fake', platformOs: process.platform });
        return;
      case 'model/list':
        respond(msg.id, { data: [{ id: 'gpt-fake-1', displayName: 'Fake 1' }, { id: 'gpt-fake-2' }, { id: 'hidden-x', hidden: true }], nextCursor: null });
        return;
      case 'thread/start':
        seen.threadStart = msg.params;
        persist();
        respond(msg.id, { thread: { id: 'th_fake_new' } });
        notify('thread/started', { thread: { id: 'th_fake_new' } });
        return;
      case 'thread/resume':
        seen.threadResume = msg.params;
        persist();
        if (process.env.FAKE_RESUME_FAIL === '1') { respondError(msg.id, '线程不存在'); return; }
        respond(msg.id, { thread: { id: msg.params.threadId } });
        return;
      case 'turn/start':
        seen.turnStart = msg.params;
        persist();
        respond(msg.id, { turn: { id: 'turn_1', status: 'inProgress' } });
        runTurn(msg.params.threadId);
        return;
      case 'turn/interrupt':
        seen.interrupts += 1;
        persist();
        respond(msg.id, {});
        while (interruptWaiters.length) interruptWaiters.pop()();
        return;
      default:
        respondError(msg.id, 'fake 不支持');
        return;
    }
  }
  if (msg.id != null && openApprovals.has(msg.id)) {
    const resolve = openApprovals.get(msg.id);
    openApprovals.delete(msg.id);
    approvals.push(msg.result ?? { decision: '(空)' });
    persist();
    resolve(msg.result ?? { decision: '(空)' });
  }
}
