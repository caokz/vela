// OpenAI 兼容适配器：官方 API、OpenRouter、Ollama(/v1)、one-api 等中转。
// baseUrl 约定填到版本根（如 https://api.openai.com/v1），本模块在其上拼路径。

import { consumeSse } from './sse.js';

export const openAiAdapter = {
  async streamChat(base, key, { messages, model, signal, onDelta, params }) {
    const body = { model, messages, stream: true };
    if (params?.temperature != null) body.temperature = params.temperature;
    if (params?.maxTokens > 0) body.max_tokens = params.maxTokens;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
    await consumeSse(res, (data) => {
      if (data === '[DONE]') {
        onDelta({ text: '', finished: true });
        return;
      }
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        return; // 忽略无法解析的帧（部分中转会夹杂注释帧）
      }
      if (j.error) {
        onDelta({ text: '', finished: true, error: j.error });
        return;
      }
      const choice = j.choices?.[0];
      const text = choice?.delta?.content ?? '';
      if (text) onDelta({ text, finished: false });
      if (choice?.finish_reason) onDelta({ text: '', finished: true });
    });
  },

  async listModels(base, key) {
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const j = await res.json();
    return (j.data ?? []).map((m) => m.id).filter(Boolean);
  },
};
