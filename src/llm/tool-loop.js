// LLM 任务模式的工具循环：请求模型 → 有工具调用则校验参数、（需要时）征得用户同意、执行、
// 把结果按协议回填 → 再请求模型，直到模型不再调用工具或步数用尽。
// 纯逻辑零 DOM / chrome 依赖：模型调用与工具执行都由调用方注入，Node 下可直接单测。
// 事件沿用 agent 归一化词汇（message_chunk / tool_call / tool_call_update / turn_end），
// UI 直接复用 agent/render.js 的状态归并与步骤渲染。

const RESULT_LIMIT = 24000; // 回填给模型的单个工具结果上限（字符）
const DISPLAY_LIMIT = 2000; // 步骤卡片里展示的结果上限

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}\n…（已截断，原长 ${s.length} 字符）` : s;
}

// 轨迹修复（纯函数）：assistant.toolCalls 里没有等到 tool 结果消息的调用，就地补一条
// 「未执行」。旧版本停止的工具轮存过这种残缺轨迹——OpenAI / Anthropic 协议要求每个
// tool_call_id 都有响应，缺了的话这条轨迹每次回传都会被服务端 400 拒掉
// （「An assistant message with 'tool_calls' must be followed by tool messages…」）。
// 完整轨迹原样返回（新建数组，内容不变）。
export function repairToolTrail(messages) {
  const out = [];
  let pending = null; // [id, name]：最近一条 assistant.toolCalls 中尚无结果消息的调用
  const flush = () => {
    if (!pending) return;
    for (const [id, name] of pending) out.push({ role: 'tool', toolCallId: id, name, content: '（本轮已停止，这个工具调用没有执行）' });
    pending = null;
  };
  for (const m of messages) {
    if (m?.role === 'assistant' && m.toolCalls?.length) {
      flush(); // 上一组若有缺口，先在其后补齐（tool 消息滞后到别的轮次救不了协议校验）
      out.push(m);
      pending = m.toolCalls.map((c) => [c.id, c.name]);
    } else if (m?.role === 'tool' && pending) {
      pending = pending.filter(([id]) => id !== m.toolCallId);
      out.push(m);
    } else {
      flush();
      out.push(m);
    }
  }
  flush();
  return out;
}

// 极简 JSON Schema 校验：只覆盖工具定义里用到的 type/required/enum，够挡住模型乱填
export function validateArgs(schema, args) {
  if (!schema || schema.type !== 'object') return '';
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '参数必须是 JSON 对象';
  if (args.__invalid !== undefined) return `参数不是合法 JSON：${truncate(args.__invalid, 200)}`;
  for (const k of schema.required ?? []) {
    if (args[k] === undefined || args[k] === null || args[k] === '') return `缺少必填参数 ${k}`;
  }
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties?.[k];
    if (!p) continue;
    const t = Array.isArray(v) ? 'array' : typeof v;
    const want = p.type === 'integer' ? 'number' : p.type;
    if (want && t !== want) return `参数 ${k} 类型应为 ${p.type}`;
    if (p.type === 'integer' && !Number.isInteger(v)) return `参数 ${k} 应为整数`;
    if (p.enum && !p.enum.includes(v)) return `参数 ${k} 取值应为 ${p.enum.join(' / ')}`;
  }
  return '';
}

// 步骤标题：「工具名: 关键参数摘要」，与 agent 适配器同格式（步骤渲染按冒号前取工具名）
function stepTitle(tool, args) {
  const brief = tool?.summarize?.(args) || '';
  return brief ? `${tool?.name || '?'}: ${brief}` : tool?.name || '?';
}

/**
 * @param {object} o
 * @param {Array} o.messages 统一消息形状（见 openai.js toOpenAiMessages）
 * @param {Array} o.tools [{name, description, parameters, needsApproval?, summarize?, run(args,{signal})}]
 * @param {Function} o.callModel ({messages, tools, signal, onText}) => Promise<{toolCalls?, error?}>
 * @param {Function} o.approve ({tool, args, title}) => Promise<boolean>
 * @param {Function} o.onEvent 归一化事件回调
 * @param {AbortSignal} o.signal
 * @param {number} o.maxSteps 最多请求模型的轮数
 * @returns {Promise<{stopReason:'end'|'cancelled'|'max_steps'|'error', error?:string, messages}>}
 */
export async function runToolLoop({ messages, tools, callModel, approve, onEvent, signal, maxSteps = 12 }) {
  const history = [...messages];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const emit = (e) => { try { onEvent?.(e); } catch { /* 渲染异常不打断循环 */ } };
  let wroteText = false;
  const end = (stopReason, error = '') => {
    // 协议完整性收尾：assistant.toolCalls 的每个 id 都必须有对应的 tool 消息（OpenAI /
    // Anthropic 都硬性要求）。停止 / 出错可能落在某个工具中途，剩余调用没有回填——这样的
    // 轨迹一旦落库，本会话之后的每次请求都会被服务端 400 拒掉。就地补「未执行」结果
    const last = [...history].reverse().find((m) => m.role === 'assistant' && m.toolCalls?.length);
    if (last) {
      const answered = new Set(history.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
      for (const c of last.toolCalls) {
        if (answered.has(c.id)) continue;
        emit({ kind: 'tool_call_update', id: c.id, status: 'cancelled', result: '本轮已停止，未执行', durationMs: 0 });
        history.push({ role: 'tool', toolCallId: c.id, name: c.name, content: '（本轮已停止，这个工具调用没有执行）' });
      }
    }
    emit({ kind: 'turn_end', stopReason, ...(error ? { error } : {}) });
    return { stopReason, ...(error ? { error } : {}), messages: history };
  };

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return end('cancelled');
    let text = '';
    let sep = wroteText; // 多步之间的正文用空行隔开
    const r = await callModel({
      messages: history,
      tools,
      signal,
      onText: (t) => {
        if (!t) return;
        if (sep) { emit({ kind: 'message_chunk', text: '\n\n' }); sep = false; }
        text += t;
        wroteText = true;
        emit({ kind: 'message_chunk', text: t });
      },
    });
    if (signal?.aborted) {
      // 中断前已流出的正文也要进返回的 messages：调用方持久化整条轨迹，继续轮才不丢这段
      if (text) history.push({ role: 'assistant', content: text });
      return end('cancelled');
    }
    if (r?.error) {
      if (text) history.push({ role: 'assistant', content: text });
      return end('error', r.error);
    }
    const calls = r?.toolCalls ?? [];
    if (!calls.length) {
      // 收尾正文同样入轨：不带工具调用的最终回答只存在于这里，不落轨迹下一轮就看不到
      if (text) history.push({ role: 'assistant', content: text });
      return end('end');
    }

    history.push({ role: 'assistant', content: text, toolCalls: calls });
    for (const call of calls) {
      if (signal?.aborted) return end('cancelled');
      const tool = byName.get(call.name);
      const id = call.id;
      const args = call.arguments ?? {};
      const title = stepTitle(tool || { name: call.name }, args);
      const detail = JSON.stringify(args, null, 2);
      emit({ kind: 'tool_call', id, title, detail });
      const t0 = Date.now();
      // attachments：PDF / 图片等原文件（base64），由适配器按协议放进工具结果或随后的用户消息
      const finish = (status, content, isError = false, attachments = null) => {
        emit({ kind: 'tool_call_update', id, status, result: truncate(content, DISPLAY_LIMIT), durationMs: Date.now() - t0 });
        history.push({
          role: 'tool', toolCallId: id, name: call.name, content: truncate(content, RESULT_LIMIT),
          ...(isError ? { isError: true } : {}),
          ...(attachments?.length ? { attachments } : {}),
        });
      };
      if (!tool) { finish('failed', `错误：没有名为 ${call.name} 的工具`, true); continue; }
      const bad = validateArgs(tool.parameters, args);
      if (bad) { finish('failed', `参数错误：${bad}`, true); continue; }
      if (tool.needsApproval) {
        let ok = false;
        try { ok = await approve({ tool, args, title }); } catch { ok = false; }
        if (signal?.aborted) { finish('cancelled', '用户已停止'); return end('cancelled'); }
        if (!ok) { finish('failed', '用户拒绝了这个操作。请不要重试同一操作，改用其他方式或直接回答。', true); continue; }
      }
      try {
        const out = await tool.run(args, { signal });
        // 工具可返回字符串，或 { text, attachments } 带原文件附件
        if (out && typeof out === 'object' && typeof out.text === 'string') finish('completed', out.text, false, out.attachments);
        else finish('completed', typeof out === 'string' ? out : JSON.stringify(out, null, 2));
      } catch (e) {
        if (signal?.aborted) { finish('cancelled', '用户已停止'); return end('cancelled'); }
        finish('failed', `执行失败：${e?.message || e}`, true);
      }
    }
  }
  return end('max_steps');
}
