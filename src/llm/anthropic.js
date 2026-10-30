// Anthropic 适配器：/v1/messages，system 是顶层字段，max_tokens 必填。

import { consumeSse } from './sse.js';

export const anthropicAdapter = {
  async streamChat(base, key, { messages, model, signal, onDelta, params }) {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const body = {
      model,
      max_tokens: params?.maxTokens > 0 ? params.maxTokens : 4096,
      messages: messages.filter((m) => m.role !== 'system'),
      stream: true,
    };
    if (system) body.system = system;
    if (params?.temperature != null) body.temperature = params.temperature;
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
    await consumeSse(res, (data) => {
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
        onDelta({ text: j.delta.text, finished: false });
      } else if (j.type === 'message_stop') {
        onDelta({ text: '', finished: true });
      } else if (j.type === 'error') {
        onDelta({ text: '', finished: true, error: j.error });
      }
    });
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
