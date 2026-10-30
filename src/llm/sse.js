// 通用 SSE 消费器：按空行分帧（\r?\n\r?\n），拼接 data: 行，回调 JSON 字符串。
// 与 UI 无关，OpenAI / Anthropic 两个适配器共用。

export class ProviderHttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function consumeSse(res, onData) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderHttpError(res.status, body);
  }
  if (!res.body) throw new Error('响应无 body，无法流式读取');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split(/\r?\n\r?\n/);
    buf = frames.pop() ?? ''; // 末帧可能不完整，留到下轮
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (data) onData(data);
    }
  }
}

export function httpErrorMessage(err) {
  if (err instanceof ProviderHttpError) {
    if (err.status === 401 || err.status === 403) return 'Key 无效或无权限';
    if (err.status === 404) return 'URL 不对（检查版本根，如漏了 /v1）';
    if (err.status === 429) return '触发限流 / 配额不足';
    if (err.status >= 500) return `上游服务错误（${err.status}）`;
    return `请求失败（HTTP ${err.status}）：${truncate(err.body, 200)}`;
  }
  if (err.name === 'AbortError') return null; // 用户主动停止，不算错误
  if (err instanceof TypeError) return '网络不通或 CORS 拦截：检查 Base URL、host 权限（设置页保存时需授权）';
  return err.message || String(err);
}

function truncate(s, n) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
