// 1M-beta 通路的 prefill/缓存探针：同 60KB system，flash + context-1m beta 头冷/暖各一次。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).env;
const filler = Array.from({ length: 600 }, (_, i) =>
  `模块 ${i}: org.apache.flink.runtime.checkpoint.related${i}.Class${i} 负责协调 checkpoint 编号 ${i} 的状态快照与恢复，持有 Coordinator${i} 与 Store${i}，在 barrier ${i} 对齐后触发 snapshotState。`).join('\n');
const system = filler + '\n\n以上是背景知识库。回答时直接给结论。';

async function probe(label, headers) {
  const t0 = Date.now();
  let ttft = null;
  const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_AUTH_TOKEN,
      authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`,
      'anthropic-version': '2023-06-01',
      ...headers,
    },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      max_tokens: 200,
      stream: true,
      system,
      messages: [{ role: 'user', content: '用一句话回答：模块 300 的 barrier 编号是多少？' }],
    }),
  });
  if (!res.ok) { console.log(label, 'HTTP', res.status, (await res.text()).slice(0, 140)); return; }
  const dec = new TextDecoder();
  let buf = '';
  for await (const ch of res.body) {
    buf += dec.decode(ch, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(p); } catch { continue; }
      if (ev.type === 'content_block_delta' && ttft === null) ttft = Date.now() - t0;
      if (ev.type === 'message_stop') { console.log(label, '| ttft_ms', ttft, '| total_ms', Date.now() - t0); return; }
    }
  }
  console.log(label, '| ttft_ms', ttft, '| total_ms', Date.now() - t0);
}

await probe('flash+1m-beta 第1次(冷)', { 'anthropic-beta': 'context-1m-2025-08-07' });
await probe('flash+1m-beta 第2次(暖)', { 'anthropic-beta': 'context-1m-2025-08-07' });
await probe('flash 无beta 再打(验证无beta缓存仍暖)', {});
