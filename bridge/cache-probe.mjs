// 网关 prompt cache 探针：同一大 system prompt（~60KB）连打两次，比 TTFT。
// 第二次 TTFT 明显下降 = 缓存命中；持平 = 不缓存，agent 长上下文每轮全量重 prefill。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
const env = settings.env ?? {};
const base = env.ANTHROPIC_BASE_URL;
const token = env.ANTHROPIC_AUTH_TOKEN;

const filler = Array.from({ length: 600 }, (_, i) =>
  `模块 ${i}: org.apache.flink.runtime.checkpoint.related${i}.Class${i} 负责协调 checkpoint 编号 ${i} 的状态快照与恢复，持有 Coordinator${i} 与 Store${i}，在 barrier ${i} 对齐后触发 snapshotState。`).join('\n');
const system = filler + '\n\n以上是背景知识库。回答时直接给结论。';

async function probe(model, label) {
  const t0 = Date.now();
  let ttft = null;
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': token,
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      stream: true,
      system,
      messages: [{ role: 'user', content: '用一句话回答：模块 300 的 barrier 编号是多少？' }],
    }),
  });
  if (!res.ok) return { label, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 140)}` };
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.type === 'content_block_delta' && ttft === null) ttft = Date.now() - t0;
      if (ev.type === 'message_stop') return { label, ttftMs: ttft, totalMs: Date.now() - t0 };
    }
  }
  return { label, ttftMs: ttft, totalMs: Date.now() - t0 };
}

for (const model of ['glm-5.3-flash', 'glm-5.3']) {
  console.log(JSON.stringify(await probe(model, `${model}-第1次`)));
  console.log(JSON.stringify(await probe(model, `${model}-第2次(同system)`)));
  console.log(JSON.stringify(await probe(model, `${model}-第3次(同system)`)));
}
