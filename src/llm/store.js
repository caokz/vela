// LLM 设置存储：chrome.storage.local 单 key 存全部供应商配置。
// 归一化增量契约 {text, finished, error} 与 UI 对接，UI 不感知供应商差异。

import { openAiAdapter } from './openai.js';
import { anthropicAdapter } from './anthropic.js';

const KEY = 'llmSettings';

export const DEFAULT_QUICK_ACTIONS = [
  { id: 'qa-translate', title: '翻译成中文', prompt: '把下面的内容翻译成简体中文，只输出译文：\n\n{text}' },
  { id: 'qa-explain', title: '解释一下', prompt: '解释下面这段内容的含义，用中文：\n\n{text}' },
  { id: 'qa-summary', title: '总结', prompt: '总结下面这段内容的要点，用中文：\n\n{text}' },
  { id: 'qa-rewrite', title: '改写', prompt: '改写下面的内容，使其更通顺清晰，保持原意，用中文输出：\n\n{text}' },
];

export const DEFAULT_SETTINGS = {
  providers: [],
  activeProviderId: '',
  defaults: { temperature: null, maxTokens: 0, systemPrompt: '' },
  agentBridge: { url: 'ws://127.0.0.1:39217', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces', permissionMode: 'default', model: '' },
  translation: {
    targetLang: 'zh-CN',
    mode: 'bilingual', // bilingual | immersive
    maxBlocks: 1500,
    maxChars: 300000,
    batchBlocks: 6,
  },
  quickActions: DEFAULT_QUICK_ACTIONS,
};

export function getAdapter(kind) {
  if (kind === 'anthropic') return anthropicAdapter;
  if (kind === 'openai') return openAiAdapter;
  throw new Error(`未知供应商类型: ${kind}`);
}

// baseUrl 归一：剥尾斜杠，剥已知的端点后缀。约定填到版本根。
export function normalizeBaseUrl(url) {
  let s = (url || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/(chat\/completions|messages|models)$/i, '');
  return s;
}

export function originPattern(baseUrl) {
  try {
    return new URL(baseUrl).origin + '/*';
  } catch {
    return null;
  }
}

export async function loadSettings() {
  const o = await chrome.storage.local.get(KEY);
  const saved = o[KEY] ?? {};
  const translation = { ...DEFAULT_SETTINGS.translation, ...(saved.translation ?? {}) };
  // 视口驱动改版前的旧默认值迁移：存量配置从未自定义过翻译参数时升级到新默认，
  // 否则旧的 400 段 / 60000 字符上限会继续压制翻译量。自定义过的配置不动。
  if (translation.maxBlocks === 400 && translation.maxChars === 60000 && translation.batchBlocks === 12) {
    translation.maxBlocks = DEFAULT_SETTINGS.translation.maxBlocks;
    translation.maxChars = DEFAULT_SETTINGS.translation.maxChars;
    translation.batchBlocks = DEFAULT_SETTINGS.translation.batchBlocks;
  }
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
    defaults: { ...DEFAULT_SETTINGS.defaults, ...(saved.defaults ?? {}) },
    agentBridge: { ...DEFAULT_SETTINGS.agentBridge, ...(saved.agentBridge ?? {}) },
    translation,
    quickActions: Array.isArray(saved.quickActions) && saved.quickActions.length
      ? saved.quickActions
      : structuredClone(DEFAULT_QUICK_ACTIONS),
  };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ [KEY]: settings });
}

export async function getActiveProvider() {
  const s = await loadSettings();
  return s.providers.find((p) => p.id === s.activeProviderId) ?? null;
}

// 顶层流式聊天入口：解析激活供应商 → 选适配器 → 注入全局参数。
// overrides：调用级参数覆盖（如翻译批次强制 temperature 0），优先于设置页默认值。
export async function streamChat({ messages, model, signal, onDelta, overrides }) {
  const provider = await getActiveProvider();
  if (!provider) {
    onDelta({ text: '', finished: true, error: { message: '未配置供应商，请先打开设置页添加' } });
    return;
  }
  const settings = await loadSettings();
  const adapter = getAdapter(provider.kind);
  const usedModel = model || provider.models[0] || '';
  if (!usedModel) {
    onDelta({ text: '', finished: true, error: { message: '未选择模型，请在设置页或顶栏选择' } });
    return;
  }
  // 全局 System Prompt：调用方未自带 system 时注入置顶
  const msgs = [...messages];
  if (settings.defaults.systemPrompt && !msgs.some((m) => m.role === 'system')) {
    msgs.unshift({ role: 'system', content: settings.defaults.systemPrompt });
  }
  const params = { ...settings.defaults, ...(overrides ?? {}) };
  try {
    await adapter.streamChat(normalizeBaseUrl(provider.baseUrl), provider.apiKey, {
      messages: msgs,
      model: usedModel,
      signal,
      onDelta,
      params,
    });
  } catch (err) {
    const msg = (await import('./sse.js')).httpErrorMessage(err);
    if (msg) onDelta({ text: '', finished: true, error: { message: msg } });
  }
}
