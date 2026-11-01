// 适配器注册表：B3 起 ACP 通用适配器也是加一行。
// 协议面见 agents/claude.js 头注：probe() + startTurn(session, text, ctx)。

import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';

export const ADAPTERS = [claudeAdapter, codexAdapter];

export function getAdapter(agentId) {
  return ADAPTERS.find((a) => a.id === agentId) ?? null;
}

export async function listAgents() {
  return Promise.all(ADAPTERS.map((a) => a.probe()));
}
