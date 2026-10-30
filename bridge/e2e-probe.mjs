// bridge 端到端一轮计时：session.new → prompt → turn_end，量 bridge+SDK 链路固有开销。
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const token = JSON.parse(readFileSync(join(homedir(), '.vela-bridge', 'token.json'), 'utf8')).token;
const ws = new WebSocket('ws://127.0.0.1:39217', { headers: { Origin: 'chrome-extension://probe' } });
let nextId = 1;
const pending = new Map();
const events = [];
const t0 = Date.now();
const marks = [];

function call(op, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, op, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${op}`)); }
    }, 120000).unref?.();
  });
}

process.on('unhandledRejection', (e) => { console.error('unhandled', String(e)); process.exit(1); });
ws.on('close', (code, reason) => { console.error('ws closed', code, reason.toString()); process.exit(1); });

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString());
  if (frame.id != null && pending.has(frame.id)) {
    pending.get(frame.id).resolve(frame);
    pending.delete(frame.id);
    return;
  }
  if (frame.seq != null) {
    const e = frame.event;
    marks.push([Date.now() - t0, e.kind, (e.text || e.stopReason || e.error || e.id || '').slice(0, 80)]);
  }
});

ws.on('open', async () => {
  const hello = await call('hello', { token });
  console.log('hello', JSON.stringify(hello.result));
  const s = await call('session.new', { agentId: 'claude-code', permissionMode: 'bypassPermissions', model: 'glm-5.3-flash' });
  console.log('session.new ms', Date.now() - t0, JSON.stringify(s));
  const p = await call('session.prompt', { sessionId: s.result.sessionId, text: '只回答：1+1 等于几？不要调用任何工具。' });
  console.log('prompt settled ms', Date.now() - t0, JSON.stringify(p.result).slice(0, 120));
  const done = setInterval(() => {
    if (marks.some(([, kind]) => kind === 'turn_end')) {
      clearInterval(done);
      for (const [ms, kind, extra] of marks) console.log(ms, kind, '|', extra);
      process.exit(0);
    }
  }, 100);
  setTimeout(() => { console.error('timeout waiting turn_end'); for (const [ms, kind] of marks) console.log(ms, kind); process.exit(1); }, 150000);
});
ws.on('error', (e) => { console.error('WS error', String(e)); process.exit(1); });
