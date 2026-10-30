// 会话存储：chrome.storage.local 单 key。ID 全部客户端生成（沿用前缀惯例：
// conv:<uuid> / msg:<uuid>），消息树靠 parentItemId 串联，v1 UI 按线性渲染。

const KEY = 'conversations';

export function uuid() {
  return crypto.randomUUID();
}

export function newConversation(title) {
  return {
    id: `conv:${uuid()}`,
    title: title || '新对话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items: [],
  };
}

export function newUserItem(conversationId, content, parentItemId = '') {
  return {
    id: `msg:${uuid()}`,
    conversationId,
    type: 'question',
    parentItemId,
    content,
    createdAt: Date.now(),
  };
}

export function newAssistantItem(conversationId, parentItemId, model) {
  return {
    id: `msg:${uuid()}`,
    conversationId,
    type: 'answer',
    parentItemId,
    content: '',
    model: model || '',
    createdAt: Date.now(),
    stopped: false,
    error: '',
  };
}

export async function loadConversations() {
  const o = await chrome.storage.local.get(KEY);
  return Array.isArray(o[KEY]) ? o[KEY] : [];
}

export async function saveConversations(list) {
  await chrome.storage.local.set({ [KEY]: list });
}

// 原子追加一帧：读-改-写。单用户单面板场景不会并发。
export async function updateConversation(convId, fn) {
  const list = await loadConversations();
  const conv = list.find((c) => c.id === convId);
  if (!conv) return null;
  fn(conv);
  conv.updatedAt = Date.now();
  await saveConversations(list);
  return conv;
}

export async function deleteConversation(convId) {
  const list = await loadConversations();
  await saveConversations(list.filter((c) => c.id !== convId));
}

export function makeTitle(text) {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  return s.length > 24 ? s.slice(0, 24) + '…' : s || '新对话';
}
