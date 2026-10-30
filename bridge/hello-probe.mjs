// hello 校验探针：新 token 路径 ~/.vela-bridge/token.json + agents.list。
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const token = JSON.parse(readFileSync(join(homedir(), '.vela-bridge', 'token.json'), 'utf8')).token;
const ws = new WebSocket('ws://127.0.0.1:39217', { headers: { Origin: 'chrome-extension://probe' } });
ws.on('open', () => ws.send(JSON.stringify({ id: 1, op: 'hello', params: { token } })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id === 1) {
    console.log('hello:', JSON.stringify(m.result ?? m.error));
    ws.send(JSON.stringify({ id: 2, op: 'agents.list', params: {} }));
  }
  if (m.id === 2) {
    console.log('agents:', JSON.stringify(m.result ?? m.error));
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 10000);
