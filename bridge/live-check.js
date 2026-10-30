// 真实 turn 手动检查（产生一次真实 claude 调用，不进 CI）：node bridge/live-check.js
// 验证 SDK 事件映射与 turn 生命周期：message_chunk / session_info / turn_end。
import { createHub } from './turn.js';
import { claudeAdapter } from './agents/claude.js';

const hub = createHub();
hub.attachBroadcast(() => {});
const session = hub.create({ agentId: 'claude-code', cwd: process.cwd(), contextDirs: [] });

await claudeAdapter.startTurn(session, '只回复两个字：正常', {
  emit: (event) => {
    if (event.kind === 'message_chunk') process.stdout.write(event.text);
    else console.log(`\n[事件] ${JSON.stringify(event)}`);
  },
  signal: new AbortController().signal,
  onPermission: async () => 'deny',
});

console.log(`\n[结果] agentSessionId=${session.agentSessionId} busy=${session.busy}`);
