// 自动配对链路探针：不带 token hello → 响应应下发 token，且该连接可继续请求。
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:39217', { headers: { Origin: 'chrome-extension://probe' } });
ws.on('open', () => ws.send(JSON.stringify({ id: 1, op: 'hello', params: { token: '', v: 1 } })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id === 1) {
    const got = m.ok && typeof m.result?.token === 'string' && m.result.token.length >= 32;
    console.log('hello 无 token →', got ? `自动配对成功（token ${m.result.token.slice(0, 8)}…）` : `失败: ${JSON.stringify(m.result ?? m.error)}`);
    if (got) ws.send(JSON.stringify({ id: 2, op: 'agents.list', params: {} }));
    else process.exit(1);
  }
  if (m.id === 2) {
    console.log('配对连接可发请求 →', m.ok ? `ok（${m.result.agents.length} 个 agent）` : JSON.stringify(m.error));
    ws.close();
    process.exit(m.ok ? 0 : 1);
  }
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 10000);
