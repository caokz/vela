// 停止按钮链路探针：hello → bridge.shutdown → 预期连接关闭。
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const token = JSON.parse(readFileSync(join(homedir(), '.vela-bridge', 'token.json'), 'utf8')).token;
const ws = new WebSocket('ws://127.0.0.1:39217', { headers: { Origin: 'chrome-extension://probe' } });
const t0 = Date.now();
ws.on('open', () => ws.send(JSON.stringify({ id: 1, op: 'hello', params: { token } })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id === 1) ws.send(JSON.stringify({ id: 2, op: 'bridge.shutdown', params: {} }));
  if (m.id === 2) console.log('shutdown 响应', Date.now() - t0, 'ms', JSON.stringify(m));
});
ws.on('close', (code) => { console.log('连接已关闭', Date.now() - t0, 'ms, code=' + code); process.exit(0); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 15000);
