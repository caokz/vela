// OpenAI 兼容适配器：官方 API、OpenRouter、Ollama(/v1)、one-api 等中转。
// baseUrl 约定填到版本根（如 https://api.openai.com/v1），本模块在其上拼路径。
// 工具调用（function calling）：tools 非空时随请求下发，流式 delta.tool_calls 按 index 拼接，
// 收尾时一次性回传 toolCalls（arguments 已解析成对象）。

import { consumeSse } from './sse.js';

// 统一消息形状 → OpenAI wire 格式。
// 统一形状：{role:'system'|'user', content} | {role:'assistant', content, toolCalls?:[{id,name,arguments}]}
//          | {role:'tool', toolCallId, name, content, isError?, attachments?:[{kind:'pdf'|'image', mime, name, data(base64)}]}
export function toOpenAiMessages(messages) {
  const out = [];
  let pending = []; // 本组工具结果里的附件：tool 角色只收文本，紧随其后补一条 user 消息携带
  const flush = () => {
    if (!pending.length) return;
    out.push({
      role: 'user',
      content: [
        { type: 'text', text: `以下是上面工具结果附带的文件原件：${pending.map((a) => a.name).join('、')}` },
        ...pending.map((a) => (a.kind === 'pdf'
          ? { type: 'file', file: { filename: a.name, file_data: `data:${a.mime};base64,${a.data}` } }
          : { type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } })),
      ],
    });
    pending = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flush();
    out.push(toOpenAiMessage(m));
    if (m.role === 'tool' && m.attachments?.length) pending.push(...m.attachments);
  }
  flush();
  return out;
}

function toOpenAiMessage(m) {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      })),
    };
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
  return { role: m.role, content: m.content };
}

export function toOpenAiTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// arguments 流式拼完后解析；模型偶发输出非法 JSON 时保留原文，交给运行时按参数错误回传
export function parseToolArgs(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { __invalid: String(raw) };
  } catch {
    return { __invalid: String(raw) };
  }
}

export const openAiAdapter = {
  async streamChat(base, key, { messages, model, signal, onDelta, params, tools }) {
    const body = { model, messages: toOpenAiMessages(messages), stream: true };
    if (params?.temperature != null) body.temperature = params.temperature;
    if (params?.maxTokens > 0) body.max_tokens = params.maxTokens;
    if (tools?.length) body.tools = toOpenAiTools(tools);
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
    const calls = []; // index -> {id, name, args}
    let stopReason = '';
    let failed = false;
    await consumeSse(res, (data) => {
      if (data === '[DONE]') return true;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        return false; // 忽略无法解析的帧（部分中转会夹杂注释帧）
      }
      if (j.error) {
        failed = true;
        onDelta({ text: '', finished: true, error: j.error });
        return true;
      }
      const choice = j.choices?.[0];
      const text = choice?.delta?.content ?? '';
      if (text) onDelta({ text, finished: false });
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        const c = (calls[i] ??= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      return false;
    });
    if (failed) return;
    const toolCalls = calls.filter((c) => c && c.name).map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.name,
      arguments: parseToolArgs(c.args),
    }));
    onDelta({ text: '', finished: true, stopReason, ...(toolCalls.length ? { toolCalls } : {}) });
  },

  async listModels(base, key) {
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const j = await res.json();
    return (j.data ?? []).map((m) => m.id).filter(Boolean);
  },
};
