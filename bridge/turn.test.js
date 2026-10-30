// hub 纯逻辑自测：node bridge/turn.test.js
import { createHub } from './turn.js';

const assert = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
};

const frames = [];
const hub = createHub();
hub.attachBroadcast((f) => frames.push(f));

const s = hub.create({ agentId: 'claude-code', cwd: 'C:/tmp', contextDirs: ['C:/lib'] });
assert('会话 id 前缀', s.id.startsWith('s:'));
assert('默认权限模式', s.permissionMode === 'default');

hub.emit(s, { kind: 'message_chunk', text: '你好' });
hub.emit(s, { kind: 'turn_end', stopReason: 'end' });
assert('seq 递增', s.seq === 2 && frames.length === 2);
assert('广播帧带 sessionId', frames[0].sessionId === s.id && frames[0].seq === 1);
assert('环形缓冲一致', hub.replay(s, 0).length === 2 && hub.replay(s, 1).length === 1);

// 审批：挂起 → respond → 落地
let outcome;
const p = hub.requestPermission(s, { title: 'Bash', detail: 'npm test' }).then((o) => { outcome = o; });
assert('审批事件已发', frames.at(-1).event.kind === 'permission_request' && typeof frames.at(-1).event.requestId === 'string');
const requestId = frames.at(-1).event.requestId;
assert('重复 respond 返回 false', hub.respondPermission(s, requestId, 'deny') === true && hub.respondPermission(s, requestId, 'allow') === false);
await p;
assert('deny 落地', outcome === 'deny');

const p2 = hub.requestPermission(s, { title: 'Write', detail: 'a.txt' });
const requestId2 = frames.at(-1).event.requestId;
hub.respondPermission(s, requestId2, 'allow');
assert('allow 落地', (await p2) === 'allow');
