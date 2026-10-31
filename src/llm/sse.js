// 通用 SSE 消费器：按空行分帧（\r?\n\r?\n），拼接 data: 行，回调 JSON 字符串。
// 与 UI 无关，OpenAI / Anthropic 两个适配器共用。

export class ProviderHttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function consumeSse(res, onData, { firstTimeoutMs = 180000, idleTimeoutMs = 60000 } = {}) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderHttpError(res.status, body);
  }
  if (!res.body) throw new Error('响应无 body，无法流式读取');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let timer = 0;
  let gotData = false;
  // 空转看门狗：中转/上游挂死时连接还开着，reader.read() 永不落定——上层翻译批次
  // 会无限卡在「翻译中」（x.ai/pricing 顶部 hero 卡死即此）。首帧与帧间分别计时，
  // 超时主动断开报错；报错文案避开限流/上下文关键词，走普通重试路径
  const readOnce = () => {
    clearTimeout(timer);
    const ms = gotData ? idleTimeoutMs : firstTimeoutMs;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`流式响应超时：${Math.round(ms / 1000)} 秒未收到数据`)), ms);
    });
    return Promise.race([reader.read(), watchdog]);
  };
  try {
    for (;;) {
      const { value, done } = await readOnce();
      if (done) break;
      gotData = true;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split(/\r?\n\r?\n/);
      buf = frames.pop() ?? ''; // 末帧可能不完整，留到下轮
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        // onData 返回 true = 流已收尾（如 OpenAI 的 [DONE]）：主动断开，不等服务端关连接
        if (data && onData(data) === true) {
          reader.cancel().catch(() => {});
          return;
        }
      }
    }
  } catch (e) {
    reader.cancel().catch(() => {}); // 看门狗触发/读取异常：断开挂死的连接再抛
    throw e;
  } finally {
    clearTimeout(timer);
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
