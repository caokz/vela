// 对比 beta 头对网关速度的影响：glm-5.3-flash 加/不加 context-1m beta 头。
// 顺带 dump 原始 SSE 事件类型（修正 TTFT 解析）。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
const env = settings.env ?? {};
const base = env.ANTHROPIC_BASE_URL;
const token = env.ANTHROPIC_AUTH_TOKEN;

async function probe(model, extraHeaders, label) {
  const t0 = Date.now();
  let ttft = null;
  let chars = 0;
  let outTokens = null;
  const types = new Map();
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': token,
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      stream: true,
      messages: [{ role: 'user', content: '用三句话说明 Flink 的 checkpoint 机制中 barrier 对齐的作用。' }],
    }),
  });
  if (!res.ok) return { label, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
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
      const t = ev.type + (ev.delta ? `/${ev.delta.type ?? ''}` : '');
      types.set(t, (types.get(t) || 0) + 1);
      const text = ev.delta?.text ?? ev.text ?? '';
      if (text) {
        if (ttft === null) ttft = Date.now() - t0;
        chars += text.length;
      }
      if (ev.type === 'message_delta' && ev.usage?.output_tokens != null) outTokens = ev.usage.output_tokens;
    }
  }
  const genMs = Date.now() - t0 - (ttft ?? 0);
  return {
    label,
    ttftMs: ttft,
    totalMs: Date.now() - t0,
    outChars: chars,
    outTokens,
    tps: ttft != null && outTokens ? (outTokens / (genMs / 1000)).toFixed(1) : null,
    eventTypes: [...types.entries()].map(([k, n]) => `${k}x${n}`).join(' '),
  };
}

for (let round = 1; round <= 2; round++) {
  console.log(`--- round ${round} ---`);
  console.log(JSON.stringify(await probe('glm-5.3-flash', {}, 'flash-无beta')));
  console.log(JSON.stringify(await probe('glm-5.3-flash', { 'anthropic-beta': 'context-1m-2025-08-07' }, 'flash-1m-beta')));
  console.log(JSON.stringify(await probe('glm-5.3', {}, 'glm5.3-无beta')));
}
