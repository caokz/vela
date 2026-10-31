// LLM 层单元测试（node:test，零依赖）：
// - openai / anthropic 适配器对真实 HTTP mock 服务的流式文本与工具调用解析
// - 统一消息形状 → 两种 wire 格式的转换
// - store.streamChat 按 providerId 精确路由（chrome.storage 打桩）
// - sse.js 空转看门狗：流挂死（连接开、无数据）必须超时报错
// - tool-loop：参数校验、审批拒绝、未知工具、步数上限、取消、停止后的轨迹修复
// 用法：node scripts/test-llm-unit.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startMockLlm } from './lib/mock-llm.mjs';

// store.js 依赖 chrome.storage.local：内存实现打桩
const mem = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => ({ [k]: mem[k] }),
      set: async (o) => { Object.assign(mem, structuredClone(o)); },
    },
  },
};

const { openAiAdapter, toOpenAiMessages } = await import('../src/llm/openai.js');
const { anthropicAdapter, toAnthropicMessages } = await import('../src/llm/anthropic.js');
const { streamChat } = await import('../src/llm/store.js');
const { consumeSse } = await import('../src/llm/sse.js');
const { runToolLoop, validateArgs, repairToolTrail } = await import('../src/llm/tool-loop.js');

const mock = await startMockLlm({
  respond: (req) => {
    const last = req.messages.at(-1);
    if (last.role === 'tool') return { text: `收到工具结果:${last.toolResults.map((r) => r.content).join('|')}` };
    if (/调工具/.test(last.text)) {
      return { text: '我先查一下。', toolCalls: [{ id: 'call_1', name: 'echo', arguments: { msg: '你好 "quoted"', n: 3 } }] };
    }
    if (/报错/.test(last.text)) return { error: { status: 401, body: '{"error":"bad key"}' } };
    return { text: `[${req.prefix}] 回答：${last.text}` };
  },
});

async function collect(adapter, base, opts) {
  const deltas = [];
  await adapter.streamChat(base, 'k', { model: 'm', params: {}, onDelta: (d) => deltas.push(d), ...opts });
  return {
    text: deltas.map((d) => d.text || '').join(''),
    finals: deltas.filter((d) => d.finished),
    toolCalls: deltas.find((d) => d.finished)?.toolCalls,
  };
}

test('openai 适配器：纯文本流式，收尾只发一次 finished', async () => {
  const r = await collect(openAiAdapter, mock.url('a') + '/v1', { messages: [{ role: 'user', content: '天气' }] });
  assert.equal(r.text, '[a] 回答：天气');
  assert.equal(r.finals.length, 1);
  assert.equal(r.toolCalls, undefined);
});

test('openai 适配器：工具调用参数分段拼接并解析成对象', async () => {
  const tools = [{ name: 'echo', description: 'd', parameters: { type: 'object', properties: {} } }];
  const r = await collect(openAiAdapter, mock.url('a') + '/v1', { messages: [{ role: 'user', content: '请调工具' }], tools });
  assert.equal(r.text, '我先查一下。');
  assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'echo', arguments: { msg: '你好 "quoted"', n: 3 } }]);
  const req = mock.requests.at(-1);
  assert.deepEqual(req.tools, ['echo']);
  assert.equal(req.raw.tools[0].type, 'function');
});

test('anthropic 适配器：工具调用 input_json_delta 拼接', async () => {
  const tools = [{ name: 'echo', description: 'd', parameters: { type: 'object', properties: {} } }];
  const r = await collect(anthropicAdapter, mock.url('c'), { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: '请调工具' }], tools });
  assert.equal(r.text, '我先查一下。');
  assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'echo', arguments: { msg: '你好 "quoted"', n: 3 } }]);
  const req = mock.requests.at(-1);
  assert.equal(req.raw.system, 'S');
  assert.equal(req.raw.tools[0].input_schema.type, 'object');
});

test('anthropic 适配器：HTTP 错误抛 ProviderHttpError', async () => {
  await assert.rejects(
    () => anthropicAdapter.streamChat(mock.url('c'), 'k', { model: 'm', params: {}, messages: [{ role: 'user', content: '报错' }], onDelta: () => {} }),
    (e) => e.status === 401,
  );
});

test('消息形状转换：工具往返 + 相邻同角色合并（Anthropic 交替约束）', () => {
  const msgs = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' }, // 上一问出错没有回答：两条 user 相邻
    { role: 'assistant', content: '查一下', toolCalls: [{ id: 't1', name: 'a', arguments: { x: 1 } }, { id: 't2', name: 'b', arguments: {} }] },
    { role: 'tool', toolCallId: 't1', name: 'a', content: 'r1' },
    { role: 'tool', toolCallId: 't2', name: 'b', content: 'r2', isError: true },
  ];
  const an = toAnthropicMessages(msgs);
  assert.deepEqual(an.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(an[0].content.length, 2);
  assert.deepEqual(an[1].content.map((b) => b.type), ['text', 'tool_use', 'tool_use']);
  assert.deepEqual(an[2].content.map((b) => [b.type, b.tool_use_id, !!b.is_error]), [['tool_result', 't1', false], ['tool_result', 't2', true]]);
  const oa = toOpenAiMessages(msgs);
  assert.equal(oa[3].tool_calls[0].function.arguments, '{"x":1}');
  assert.deepEqual(oa.slice(4).map((m) => [m.role, m.tool_call_id]), [['tool', 't1'], ['tool', 't2']]);
});

test('工具结果附件（PDF / 图片）：Anthropic 放进 tool_result，OpenAI 补一条 user 消息', () => {
  const msgs = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }, { id: 't2', name: 'read_file', arguments: {} }] },
    { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'pdf 已附', attachments: [{ kind: 'pdf', mime: 'application/pdf', name: 'a.pdf', data: 'UERG' }] },
    { role: 'tool', toolCallId: 't2', name: 'read_file', content: '图已附', attachments: [{ kind: 'image', mime: 'image/png', name: 'b.png', data: 'iVBO' }] },
  ];
  const an = toAnthropicMessages(msgs).at(-1).content;
  assert.deepEqual(an[0].content.map((b) => b.type), ['text', 'document']);
  assert.equal(an[0].content[1].source.media_type, 'application/pdf');
  assert.deepEqual(an[1].content.map((b) => b.type), ['text', 'image']);
  const oa = toOpenAiMessages(msgs);
  assert.deepEqual(oa.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user'], '附件消息必须排在同组 tool 消息之后');
  assert.deepEqual(oa.at(-1).content.map((p) => p.type), ['text', 'file', 'image_url']);
  assert.equal(oa.at(-1).content[1].file.file_data, 'data:application/pdf;base64,UERG');
  assert.equal(oa.at(-1).content[2].image_url.url, 'data:image/png;base64,iVBO');
});

test('streamChat：按 providerId 精确路由，同名模型不串到激活供应商', async () => {
  mem.llmSettings = {
    providers: [
      { id: 'p-a', name: 'A', kind: 'openai', baseUrl: mock.url('a') + '/v1', apiKey: 'ka', models: ['same-model'] },
      { id: 'p-b', name: 'B', kind: 'openai', baseUrl: mock.url('b') + '/v1', apiKey: 'kb', models: ['same-model'] },
      { id: 'p-c', name: 'C', kind: 'anthropic', baseUrl: mock.url('c'), apiKey: 'kc', models: ['claude-x'] },
    ],
    activeProviderId: 'p-a',
  };
  const run = async (opts) => {
    let text = '';
    let err = null;
    await streamChat({ messages: [{ role: 'user', content: '路由' }], onDelta: (d) => { text += d.text || ''; if (d.error) err = d.error; }, ...opts });
    return { text, err, req: mock.requests.at(-1) };
  };
  const b = await run({ model: 'same-model', providerId: 'p-b' });
  assert.equal(b.text, '[b] 回答：路由');
  assert.equal(b.req.headers.authorization, 'Bearer kb');
  const c = await run({ model: 'claude-x', providerId: 'p-c' });
  assert.equal(c.text, '[c] 回答：路由');
  assert.equal(c.req.protocol, 'anthropic');
  const def = await run({ model: 'same-model' }); // 不传 providerId：翻译等页面功能沿用激活供应商
  assert.equal(def.text, '[a] 回答：路由');
  const n = mock.requests.length;
  const gone = await run({ model: 'same-model', providerId: 'p-deleted' });
  assert.match(gone.err?.message || '', /已在设置页删除/);
  assert.equal(mock.requests.length, n, '供应商被删时不能静默回退去请求别家');
});

test('sse 看门狗：流挂死（发过一帧后连接静默）→ 空转超时报错，已到帧正常派发', async () => {
  // 中转/上游挂死的典型形态：连接开着、发过数据后再无帧也不结束——read() 永不落定，
  // 上层翻译批次会无限卡在「翻译中」（x.ai/pricing 顶部 hero 卡死即此）
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"v":1}\n\n');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/`);
    const seen = [];
    await assert.rejects(
      consumeSse(res, (d) => seen.push(d), { firstTimeoutMs: 500, idleTimeoutMs: 300 }),
      /流式响应超时/,
    );
    assert.equal(seen.length, 1, '挂死前已到的帧要正常派发');
  } finally {
    srv.close();
    srv.closeAllConnections?.();
  }
});

test('validateArgs：必填 / 类型 / 整数 / enum / 非法 JSON', () => {
  const s = { type: 'object', properties: { url: { type: 'string' }, n: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['url'] };
  assert.equal(validateArgs(s, { url: 'x' }), '');
  assert.match(validateArgs(s, {}), /缺少必填参数 url/);
  assert.match(validateArgs(s, { url: 1 }), /类型应为 string/);
  assert.match(validateArgs(s, { url: 'x', n: 1.5 }), /整数/);
  assert.match(validateArgs(s, { url: 'x', mode: 'c' }), /取值/);
  assert.match(validateArgs(s, { __invalid: '{bad' }), /合法 JSON/);
});

// 脚本化模型：按调用次序给出应答
function scriptedModel(steps) {
  let i = 0;
  const seen = [];
  const fn = async ({ messages, onText }) => {
    seen.push(structuredClone(messages));
    const s = steps[Math.min(i++, steps.length - 1)];
    if (s.text) onText(s.text);
    return { toolCalls: s.toolCalls, error: s.error };
  };
  fn.seen = seen;
  return fn;
}

const echoTool = { name: 'echo', description: '', parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] }, run: async (a) => `echo:${a.msg}` };
const dangerTool = { name: 'danger', description: '', needsApproval: true, parameters: { type: 'object', properties: {} }, run: async () => 'done' };

test('tool-loop：调用 → 回填 → 最终回答；事件序列完整', async () => {
  const events = [];
  const model = scriptedModel([
    { text: '查一下', toolCalls: [{ id: 'c1', name: 'echo', arguments: { msg: 'hi' } }] },
    { text: '结果是 hi' },
  ]);
  const r = await runToolLoop({ messages: [{ role: 'user', content: 'q' }], tools: [echoTool], callModel: model, approve: async () => true, onEvent: (e) => events.push(e) });
  assert.equal(r.stopReason, 'end');
  const toolMsg = model.seen[1].at(-1);
  assert.deepEqual([toolMsg.role, toolMsg.toolCallId, toolMsg.content], ['tool', 'c1', 'echo:hi']);
  assert.equal(model.seen[1].at(-2).toolCalls[0].id, 'c1');
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k !== 'message_chunk'), ['tool_call', 'tool_call_update', 'turn_end']);
  assert.equal(events.filter((e) => e.kind === 'message_chunk').map((e) => e.text).join(''), '查一下\n\n结果是 hi');
  assert.equal(events.find((e) => e.kind === 'tool_call_update').status, 'completed');
});

test('tool-loop：审批拒绝 / 未知工具 / 参数错误都回填错误结果并继续', async () => {
  let ran = false;
  const tools = [echoTool, { ...dangerTool, run: async () => { ran = true; return 'x'; } }];
  const model = scriptedModel([
    { toolCalls: [{ id: 'c1', name: 'danger', arguments: {} }, { id: 'c2', name: 'nope', arguments: {} }, { id: 'c3', name: 'echo', arguments: {} }] },
    { text: '好的' },
  ]);
  const r = await runToolLoop({ messages: [], tools, callModel: model, approve: async () => false });
  assert.equal(r.stopReason, 'end');
  assert.equal(ran, false, '被拒绝的工具不能执行');
  const results = model.seen[1].filter((m) => m.role === 'tool');
  assert.match(results[0].content, /拒绝/);
  assert.match(results[1].content, /没有名为 nope/);
  assert.match(results[2].content, /缺少必填参数 msg/);
  assert.ok(results.every((m) => m.isError));
});

test('tool-loop：步数上限与模型错误', async () => {
  const loop = scriptedModel([{ toolCalls: [{ id: 'c', name: 'echo', arguments: { msg: 'x' } }] }]);
  const r = await runToolLoop({ messages: [], tools: [echoTool], callModel: loop, approve: async () => true, maxSteps: 3 });
  assert.equal(r.stopReason, 'max_steps');
  assert.equal(loop.seen.length, 3);
  const bad = await runToolLoop({ messages: [], tools: [], callModel: scriptedModel([{ error: '上游 500' }]), approve: async () => true });
  assert.deepEqual([bad.stopReason, bad.error], ['error', '上游 500']);
});

test('tool-loop：审批等待中取消 → cancelled，工具不执行', async () => {
  const ac = new AbortController();
  let ran = false;
  const model = scriptedModel([{ toolCalls: [{ id: 'c1', name: 'danger', arguments: {} }] }]);
  const p = runToolLoop({
    messages: [], tools: [{ ...dangerTool, run: async () => { ran = true; } }], callModel: model, signal: ac.signal,
    approve: () => new Promise((res) => ac.signal.addEventListener('abort', () => res(false))),
  });
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  assert.equal(r.stopReason, 'cancelled');
  assert.equal(ran, false);
});

test('tool-loop：收尾正文进返回的 messages（不带工具调用的最终回答也在轨迹里）', async () => {
  const model = scriptedModel([
    { text: '查一下', toolCalls: [{ id: 'c1', name: 'echo', arguments: { msg: 'hi' } }] },
    { text: '最终回答' },
  ]);
  const r = await runToolLoop({ messages: [{ role: 'user', content: 'q' }], tools: [echoTool], callModel: model, approve: async () => true });
  assert.equal(r.stopReason, 'end');
  assert.deepEqual(r.messages.map((m) => [m.role, m.role === 'tool' ? m.toolCallId : m.content]), [
    ['user', 'q'],
    ['assistant', '查一下'],
    ['tool', 'c1'],
    ['assistant', '最终回答'],
  ]);
});

test('tool-loop：轨迹接力——上轮 max_steps 的 messages 喂下一轮，历史工具结果对模型可见', async () => {
  // 上轮：1 步上限，调了一次工具即暂停（用户看到的「已达到单轮最多 N 步」）
  const first = await runToolLoop({
    messages: [{ role: 'user', content: '长任务' }],
    tools: [echoTool],
    callModel: scriptedModel([{ toolCalls: [{ id: 'c1', name: 'echo', arguments: { msg: 'hi' } }] }]),
    approve: async () => true,
    maxSteps: 1,
  });
  assert.equal(first.stopReason, 'max_steps');
  assert.equal(first.messages.filter((m) => m.role === 'tool').length, 1);
  // 下轮（「继续」）：以上轮 messages 为起点，模型请求里必须带着 c1 的结果与调用记录
  const next = scriptedModel([{ text: '接着说' }]);
  const r2 = await runToolLoop({ messages: first.messages, tools: [echoTool], callModel: next, approve: async () => true });
  assert.equal(r2.stopReason, 'end');
  const seen = next.seen[0];
  assert.equal(seen.find((m) => m.role === 'tool')?.content, 'echo:hi');
  assert.equal(seen.find((m) => m.role === 'assistant')?.toolCalls?.[0]?.id, 'c1');
});

test('tool-loop：工具执行中途停止 → 轨迹里每个 toolCallId 都有结果消息（服务端 400 防线）', async () => {
  const ac = new AbortController();
  const events = [];
  // 模型一次发两个调用；第一个执行时就停止 → 第二个没机会跑，出口必须给它补结果
  const model = scriptedModel([{ toolCalls: [
    { id: 'a1', name: 'echo', arguments: { msg: 'x' } },
    { id: 'a2', name: 'echo', arguments: { msg: 'y' } },
  ] }]);
  const r = await runToolLoop({
    messages: [], tools: [{ ...echoTool, run: async () => { ac.abort(); return 'half'; } }],
    callModel: model, signal: ac.signal, onEvent: (e) => events.push(e),
  });
  assert.equal(r.stopReason, 'cancelled');
  assert.deepEqual(r.messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m.content]), [
    ['a1', 'half'],
    ['a2', '（本轮已停止，这个工具调用没有执行）'],
  ]);
  assert.equal(events.find((e) => e.kind === 'tool_call_update' && e.id === 'a2')?.status, 'cancelled');
});

test('repairToolTrail：残缺轨迹补「未执行」结果，完整轨迹不动', () => {
  // 旧版本停止轮存下的残缺轨迹：assistant 带工具调用，没有任何结果消息
  const dangling = [
    { role: 'user', content: '问' },
    { role: 'assistant', content: '我查查', toolCalls: [{ id: 'c1', name: 'fetch_url' }, { id: 'c2', name: 'echo' }] },
  ];
  assert.deepEqual(repairToolTrail(dangling).map((m) => [m.role, m.toolCallId ?? null]), [
    ['user', null], ['assistant', null], ['tool', 'c1'], ['tool', 'c2'],
  ]);
  // 两个调用只回了一个：只补缺的那个，已有的原样保留
  const partial = repairToolTrail([...dangling, { role: 'tool', toolCallId: 'c1', name: 'fetch_url', content: 'ok' }]);
  assert.deepEqual(partial.filter((m) => m.role === 'tool').map((m) => m.toolCallId), ['c1', 'c2']);
  assert.match(partial.at(-1).content, /没有执行/);
  // 完整轨迹（多轮）内容不变
  const complete = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'x1', name: 'echo' }] },
    { role: 'tool', toolCallId: 'x1', name: 'echo', content: 'r' },
    { role: 'assistant', content: 'done' },
  ];
  assert.deepEqual(repairToolTrail(complete), complete);
});

test('修复后的轨迹转 OpenAI wire 格式：每个 tool_calls 都有紧跟的 tool 响应', () => {
  const wire = toOpenAiMessages(repairToolTrail([
    { role: 'user', content: '问' },
    { role: 'assistant', content: '查', toolCalls: [{ id: 'c1', name: 'fetch_url', arguments: {} }] },
    { role: 'user', content: '请继续' },
  ]));
  // 模拟服务端校验（deepseek 实测报错规则）：assistant.tool_calls 之后必须紧跟
  // 覆盖每个 tool_call_id 的 tool 消息
  for (let i = 0; i < wire.length; i++) {
    const m = wire[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const need = new Set(m.tool_calls.map((c) => c.id));
    for (let j = i + 1; j < wire.length && need.size; j++) {
      if (wire[j].role !== 'tool') break;
      need.delete(wire[j].tool_call_id);
    }
    assert.equal(need.size, 0, `id ${[...need]} 没有工具响应消息`);
  }
});

test.after(() => mock.close());
