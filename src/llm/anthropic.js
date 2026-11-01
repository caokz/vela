// Anthropic 适配器：/v1/messages，system 是顶层字段，max_tokens 必填。
// 工具调用：tools 非空时下发；流式 content_block_start(tool_use) + input_json_delta 拼参数，
// 收尾时一次性回传 toolCalls。工具结果按协议放在 user 消息的 tool_result 块里。

import { consumeSse } from './sse.js';
import { parseToolArgs } from './openai.js';

// 统一消息形状 → Anthropic wire 格式（形状定义见 openai.js toOpenAiMessages）。
// 连续的 tool 结果合并进同一条 user 消息；相邻同角色消息合并，满足 user/assistant 交替约束。
export function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      // 附件（PDF / 图片）随 tool_result 一起给：document / image 块
      const content = m.attachments?.length
        ? [{ type: 'text', text: String(m.content ?? '') }, ...m.attachments.map((a) => ({
          type: a.kind === 'pdf' ? 'document' : 'image',
          source: { type: 'base64', media_type: a.mime, data: a.data },
        }))]
        : String(m.content ?? '');
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content, ...(m.isError ? { is_error: true } : {}) }]);
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} });
      if (blocks.length) push('assistant', blocks);
    } else {
      // user 消息可带附件（图片理解）：文本块 + image / document 块
      const blocks = [{ type: 'text', text: String(m.content ?? '') }];
      for (const a of m.attachments ?? []) blocks.push({
        type: a.kind === 'pdf' ? 'document' : 'image',
        source: { type: 'base64', media_type: a.mime, data: a.data },
      });
      push('user', blocks);
    }
  }
  // 纯文本单块消息还原成字符串，保持与旧请求体一致（部分兼容网关只认字符串）
  return out.map((m) => (m.content.length === 1 && m.content[0].type === 'text'
    ? { role: m.role, content: m.content[0].text }
    : m));
}

export function toAnthropicTools(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

export const anthropicAdapter = {
  async streamChat(base, key, { messages, model, signal, onDelta, params, tools }) {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const body = {
      model,
      max_tokens: params?.maxTokens > 0 ? params.maxTokens : 4096,
      messages: toAnthropicMessages(messages),
      stream: true,
    };
    if (system) body.system = system;
    if (params?.temperature != null) body.temperature = params.temperature;
    if (tools?.length) body.tools = toAnthropicTools(tools);
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // 浏览器直连 Anthropic 需要此头，规避 Origin 校验
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal,
    });
    const blocks = new Map(); // index -> {id, name, json}
    let stopReason = '';
    let failed = false;
    await consumeSse(res, (data) => {
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        return false;
      }
      if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
        blocks.set(j.index, { id: j.content_block.id, name: j.content_block.name, json: '' });
      } else if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
        onDelta({ text: j.delta.text, finished: false });
      } else if (j.type === 'content_block_delta' && j.delta?.type === 'input_json_delta') {
        const b = blocks.get(j.index);
        if (b) b.json += j.delta.partial_json || '';
      } else if (j.type === 'message_delta' && j.delta?.stop_reason) {
        stopReason = j.delta.stop_reason;
      } else if (j.type === 'message_stop') {
        return true;
      } else if (j.type === 'error') {
        failed = true;
        onDelta({ text: '', finished: true, error: j.error });
        return true;
      }
      return false;
    });
    if (failed) return;
    const toolCalls = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => ({ id: b.id, name: b.name, arguments: parseToolArgs(b.json) }));
    onDelta({ text: '', finished: true, stopReason, ...(toolCalls.length ? { toolCalls } : {}) });
  },

  // Anthropic 官方有 GET /v1/models；兼容网关不一定实现。
  async listModels(base, key) {
    const res = await fetch(`${base}/v1/models`, {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const j = await res.json();
    return (j.data ?? []).map((m) => m.id).filter(Boolean);
  },
};
