// 适配器注册表：B1 只有 claude；B2 加 codex，B3 起 ACP 通用适配器也是加一行。
// 协议面见 agents/claude.js 头注：probe() + startTurn(session, text, ctx)。

import { claudeAdapter } from './claude.js';

export const ADAPTERS = [claudeAdapter];

export function getAdapter(agentId) {
  return ADAPTERS.find((a) => a.id === agentId) ?? null;
}

export async function listAgents() {
  return Promise.all(ADAPTERS.map((a) => a.probe()));
}
