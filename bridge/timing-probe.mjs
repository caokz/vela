// 网关模型速度对比探针：同一 prompt 打三个模型 id，量 TTFT / 总耗时 / 输出 token 数。
// 鉴权直接读 ~/.claude/settings.json 的 env（与 Claude Code 同源），token 不落日志。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
const env = settings.env ?? {};
const base = env.ANTHROPIC_BASE_URL;
const token = env.ANTHROPIC_AUTH_TOKEN;

const MODELS = [
  'glm-5.3-flash[1M]', // vela 默认（env ANTHROPIC_MODEL）
  'glm-5.3-flash',      // Orca 目录映射的实际模型
  'glm-5.3',
];

const PROMPT = '用三句话说明 Flink 的 checkpoint 机制中 barrier 对齐的作用。';

// 流式打点：TTFT、总耗时、输出 token 数、稳定后的每秒 token 数
async function probe(model) {
  const t0 = Date.now();
  let ttft = null;
  let chars = 0;
  let outTokens = null;
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
      max_tokens: 400,
      stream: true,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  }).catch((e) => ({ __err: String(e) }));
  if (res.__err) return { model, error: res.__err };
  if (!res.ok) return { model, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };

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
      try {
        const ev = JSON.parse(payload);
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          if (ttft === null) ttft = Date.now() - t0;
          chars += ev.delta.text.length;
        }
        if (ev.type === 'message_delta' && ev.usage?.output_tokens != null) outTokens = ev.usage.output_tokens;
      } catch { /* 忽略非 JSON 行 */ }
    }
  }
  return {
    model,
    ttftMs: ttft,
    totalMs: Date.now() - t0,
    outChars: chars,
    outTokens,
    tps: ttft != null && outTokens ? (outTokens / ((Date.now() - t0 - ttft) / 1000)).toFixed(1) : null,
  };
}

for (let round = 1; round <= 2; round++) {
  console.log(`--- round ${round} ---`);
  for (const m of MODELS) {
    const r = await probe(m);
    console.log(JSON.stringify(r));
  }
}
