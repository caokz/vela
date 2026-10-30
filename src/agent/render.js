// agent turn 状态归并：事件流 → 可渲染/可持久化的单一状态。
// 纯逻辑零 DOM 依赖；chat-ui.js 消费变更标志做 rAF 节流渲染。

export function createTurnState() {
  return {
    content: '',
    thought: '',
    steps: new Map(), // id -> {title, status, detail, result, parentId, durationMs}
    agentSessionId: '',
    costUSD: null,
    durationMs: null, // 轮总耗时（result 消息的 duration_ms）
    stopReason: '',
    error: '',
    changed: { content: false, thought: false, steps: false, meta: false },
  };
}

// 消费一帧；changed 标志由调用方读取后重置（markRendered）。
export function applyEvent(state, event) {
  const c = state.changed;
  switch (event.kind) {
    case 'message_chunk':
      state.content += event.text || '';
      c.content = true;
      break;
    case 'thought_chunk':
      state.thought += event.text || '';
      c.thought = true;
      break;
    case 'tool_call': {
      // 回填/重放可能晚于原事件到达：保留已有 status 与 detail，只补缺
      const prev = state.steps.get(event.id);
      state.steps.set(event.id, {
        title: event.title || prev?.title || event.id,
        status: prev?.status || 'in_progress',
        detail: event.detail || prev?.detail || '',
        parentId: event.parentId || prev?.parentId || '',
        durationMs: prev?.durationMs ?? null,
      });
      c.steps = true;
      break;
    }
    case 'tool_call_update': {
      const step = state.steps.get(event.id);
      if (step) {
        if (event.status) step.status = event.status;
        if (event.title) step.title = event.title;
        if (event.detail && !step.detail) step.detail = event.detail;
        if (event.result !== undefined) step.result = event.result;
        if (event.durationMs != null) step.durationMs = event.durationMs;
        if (event.parentId && !step.parentId) step.parentId = event.parentId;
        if (event.summary) step.title = `${step.title.split(':')[0]}: ${event.summary}`;
        c.steps = true;
      }
      break;
    }
    case 'plan':
      state.plan = event.entries ?? [];
      c.meta = true;
      break;
    case 'session_info':
      state.agentSessionId = event.agentSessionId || '';
      c.meta = true;
      break;
    case 'permission_request':
      state.permission = { requestId: event.requestId, title: event.title, detail: event.detail };
      c.meta = true;
      break;
    case 'permission_settled':
      if (state.permission?.requestId === event.requestId) state.permission = null;
      c.meta = true;
      break;
    case 'usage':
      state.costUSD = event.costUSD ?? state.costUSD;
      state.durationMs = event.durationMs ?? state.durationMs;
      c.meta = true;
      break;
    case 'turn_end':
      state.stopReason = event.stopReason || 'end';
      if (event.error) state.error = event.error;
      // 轮已结束（含取消/中断）：没等到结果的工具步骤定格为 cancelled，
      // 否则 in_progress 呼吸灯永远闪（取消时最后一个工具不会有 tool_call_update）
      for (const step of state.steps.values()) {
        if (step.status === 'in_progress') { step.status = 'cancelled'; c.steps = true; }
      }
      c.meta = true;
      break;
    default:
      break; // 未知事件丢弃
  }
}

export function markRendered(state) {
  state.changed = { content: false, thought: false, steps: false, meta: false };
}

// 持久化到消息项的 meta.agent 形状（离线回放用）
export function turnStateToMeta(state, agentId) {
  return {
    agentId,
    agentSessionId: state.agentSessionId,
    // 值里带 id：离线回放用合成 key 重建 Map，parentId 引用原始 id，需要它重映射
    steps: [...state.steps.entries()].map(([id, s]) => ({ ...s, id })),
    thought: state.thought,
    ...(state.costUSD != null ? { costUSD: state.costUSD } : {}),
    ...(state.durationMs != null ? { durationMs: state.durationMs } : {}),
  };
}

// 离线回放：把持久化的 meta.agent 恢复为可渲染状态
export function stateFromMeta(agentMeta) {
  const state = createTurnState();
  if (!agentMeta) return state;
  state.agentSessionId = agentMeta.agentSessionId || '';
  state.thought = agentMeta.thought || '';
  const idMap = new Map(); // 原始 tool_use id -> 合成 key
  for (const s of agentMeta.steps ?? []) {
    // 持久化的必然是已结束轮次：旧数据里遗留的 in_progress 同样收口，离线回放不再闪
    if (s.status === 'in_progress') s.status = 'cancelled';
    const key = `m${state.steps.size}`;
    if (s.id) idMap.set(s.id, key);
    // 值上的 id 也统一成合成 key：前端的归组比较 parentId === id，两边必须同一套 id
    s.id = key;
    state.steps.set(key, s);
  }
  for (const s of state.steps.values()) {
    if (s.parentId && idMap.has(s.parentId)) s.parentId = idMap.get(s.parentId);
  }
  state.costUSD = agentMeta.costUSD ?? null;
  state.durationMs = agentMeta.durationMs ?? null;
  return state;
}
