// 本地 mock LLM：同时实现 OpenAI 兼容 /chat/completions 与 Anthropic /v1/messages 的 SSE 流式协议，
// 含工具调用（tool_calls / tool_use）。路径前缀区分「不同供应商」：/<prefix>/v1/chat/completions、
// /<prefix>/v1/messages。脚本化应答：respond(req) 返回 {text?, toolCalls?, error?, delayMs?}。
// 所有请求记入 requests，供测试断言（路由到哪家、带没带工具、工具结果回填形状）。
import { createServer } from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 统一视图：把两种协议的请求体规整成 { protocol, prefix, model, tools, messages:[{role, text, toolResults, toolCalls}] }
export function normalizeRequest(protocol, prefix, body) {
  const messages = [];
  if (protocol === 'openai') {
    for (const m of body.messages ?? []) {
      if (m.role === 'tool') {
        const last = messages.at(-1);
        const tr = { id: m.tool_call_id, content: String(m.content ?? '') };
        if (last?.role === 'tool') last.toolResults.push(tr);
        else messages.push({ role: 'tool', text: '', toolResults: [tr] });
      } else {
        // content 可能是块数组（视觉：text + image_url）：text 部分并入 text 供 respond 路由
        messages.push({
          role: m.role,
          text: typeof m.content === 'string' ? m.content
            : Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '',
          toolCalls: (m.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments })),
          toolResults: [],
        });
      }
    }
  } else {
    if (body.system) messages.push({ role: 'system', text: body.system, toolResults: [] });
    for (const m of body.messages ?? []) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      // tool_result 的 content 可能是块数组（文本 + document / image 附件）：取文本部分
      const resultText = (c) => (Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : String(c ?? ''));
      const toolResults = blocks.filter((b) => b.type === 'tool_result').map((b) => ({ id: b.tool_use_id, content: resultText(b.content), isError: !!b.is_error }));
      const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input) }));
      messages.push({ role: toolResults.length ? 'tool' : m.role, text, toolCalls, toolResults });
    }
  }
  const tools = (body.tools ?? []).map((t) => t.function?.name || t.name);
  return { protocol, prefix, model: body.model, tools, messages, raw: body };
}

function chunks(s, n = 6) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

async function streamOpenAi(res, spec) {
  const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  for (const c of chunks(spec.text || '')) {
    frame({ choices: [{ index: 0, delta: { content: c } }] });
    await sleep(spec.chunkDelayMs ?? 5);
  }
  (spec.toolCalls ?? []).forEach((tc, index) => {
    const args = JSON.stringify(tc.arguments ?? {});
    // 首帧带 id/name，参数分两段到达：覆盖客户端按 index 拼接的逻辑
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }] } }] });
    const mid = Math.ceil(args.length / 2);
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(0, mid) } }] } }] });
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(mid) } }] } }] });
  });
  frame({ choices: [{ index: 0, delta: {}, finish_reason: spec.toolCalls?.length ? 'tool_calls' : 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function streamAnthropic(res, spec) {
  const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
  ev('message_start', { message: { id: 'msg_mock', role: 'assistant', content: [] } });
  let index = 0;
  if (spec.text) {
    ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
    for (const c of chunks(spec.text)) {
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: c } });
      await sleep(spec.chunkDelayMs ?? 5);
    }
    ev('content_block_stop', { index });
    index++;
  }
  for (const tc of spec.toolCalls ?? []) {
    const args = JSON.stringify(tc.arguments ?? {});
    ev('content_block_start', { index, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } });
    const mid = Math.ceil(args.length / 2);
    ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: args.slice(0, mid) } });
    ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: args.slice(mid) } });
    ev('content_block_stop', { index });
    index++;
  }
  ev('message_delta', { delta: { stop_reason: spec.toolCalls?.length ? 'tool_use' : 'end_turn' } });
  ev('message_stop', {});
  res.end();
}

export async function startMockLlm({ port = 0, respond } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const m = req.url.match(/^\/([^/]+)\/v1\/(chat\/completions|messages|models)$/);
    if (!m) { res.writeHead(404); res.end('not found'); return; }
    const [, prefix, kind] = m;
    if (kind === 'models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 非法 JSON 交给 respond 处理 */ }
    const protocol = kind === 'messages' ? 'anthropic' : 'openai';
    const n = normalizeRequest(protocol, prefix, body);
    n.headers = req.headers;
    requests.push(n);
    let spec;
    try { spec = (await respond?.(n, requests)) ?? { text: 'mock 默认回答' }; } catch (e) { spec = { error: { status: 500, body: String(e) } }; }
    if (spec.delayMs) await sleep(spec.delayMs);
    if (spec.error) {
      res.writeHead(spec.error.status || 500, { 'content-type': 'application/json' });
      res.end(spec.error.body || JSON.stringify({ error: { message: 'mock error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (protocol === 'openai') await streamOpenAi(res, spec);
    else await streamAnthropic(res, spec);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  return {
    port: actual,
    url: (prefix) => `http://127.0.0.1:${actual}/${prefix}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
