// 冷 prefill 复验：换一段全新 60KB system，flash 冷打两次（第一次=真冷，第二次=暖），
// 另用全新 prompt 测 glm-5.3 作对照，确认 flash 35s 冷 prefill 是真实成本还是排队抖动。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).env;
const tag = Date.now().toString(36); // 每次 run 不同的内容，保证真冷
const filler = Array.from({ length: 600 }, (_, i) =>
  `资产 ${i}-${tag}: kafka.topology.partition${i}.ConsumerGroup${i} 维护 topic-${i} 的 lag 与 offset 提交，触发 rebalance 时迁移到 broker-${i}，与 coordinator-${i} 保持心跳。`).join('\n');
const system = filler + '\n\n以上是背景知识库。回答时直接给结论。';

async function probe(label, model) {
  const t0 = Date.now();
  let ttft = null;
  const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_AUTH_TOKEN,
      authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      stream: true,
      system,
      messages: [{ role: 'user', content: '用一句话回答：资产 300 属于哪个 broker？' }],
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

await probe('flash 全新prompt 第1次(真冷)', 'glm-5.3-flash');
await probe('flash 全新prompt 第2次(暖)', 'glm-5.3-flash');
await probe('glm5.3 全新prompt 第1次(真冷)', 'glm-5.3');
await probe('glm5.3 全新prompt 第2次(暖)', 'glm-5.3');
