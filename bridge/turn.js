// 会话与事件中枢：seq 分配、环形缓冲、审批挂起、busy 守卫。
// 零 chrome/WS 依赖，Node 直跑可测（文件尾自测入口）。
// 生命周期：客户端断开不杀 turn（子进程由适配器/AbortController 管理），
// 重连后 events.replay(fromSeq) 补帧。

import { randomUUID } from 'node:crypto';

const BUFFER_LIMIT = 500;
export const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;

export function createHub() {
  const sessions = new Map();

  function create({ agentId, cwd = '', contextDirs = [], permissionMode = 'default', model = '' }) {
    const session = {
      id: `s:${randomUUID()}`,
      agentId,
      cwd,
      contextDirs: [...contextDirs],
      permissionMode,
      model,
      agentSessionId: '', // 首个 turn 后由适配器回填（session_info 事件）
      busy: false,
      abort: null, // 当前 turn 的 AbortController
      permSeq: 0,
      pending: new Map(), // requestId -> resolve('allow'|'deny')
      seq: 0,
      buffer: [], // 最近 BUFFER_LIMIT 条 {seq, event}
    };
    sessions.set(session.id, session);
    return session;
  }

  function get(id) {
    return sessions.get(id) ?? null;
  }

  // 唯一出口：适配器与 server 层都经此发事件。分配 seq、进环形缓冲、广播。
  function emit(session, event) {
    session.seq += 1;
    const frame = { type: 'event', sessionId: session.id, seq: session.seq, event };
    session.buffer.push({ seq: frame.seq, event });
    if (session.buffer.length > BUFFER_LIMIT) session.buffer.shift();
    broadcast(frame);
    return frame.seq;
  }

  function replay(session, fromSeq) {
    return session.buffer.filter((e) => e.seq > fromSeq);
  }

  function broadcast() {} // server 启动时注入，见 attachBroadcast

  function attachBroadcast(fn) {
    broadcast = fn;
  }

  // 审批：生成 requestId、挂起等客户端 respond；超时按 deny 落地。
  function requestPermission(session, { title, detail }) {
    return new Promise((resolve) => {
      session.permSeq += 1;
      const requestId = `p${session.permSeq}`;
      const timer = setTimeout(() => {
        if (session.pending.has(requestId)) {
          session.pending.delete(requestId);
          resolve('deny');
        }
      }, PERMISSION_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      session.pending.set(requestId, (outcome) => {
        clearTimeout(timer);
        resolve(outcome === 'allow' ? 'allow' : 'deny');
      });
      emit(session, { kind: 'permission_request', requestId, title, detail });
    });
  }

  function respondPermission(session, requestId, outcome) {
    const resolve = session.pending.get(requestId);
    if (!resolve) return false;
    session.pending.delete(requestId);
    resolve(outcome);
    return true;
  }

  return { sessions, create, get, emit, replay, attachBroadcast, requestPermission, respondPermission };
}
