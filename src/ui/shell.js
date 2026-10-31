// DOM 骨架：createElement 组装 侧边栏 + 主区 + composer + toast。
// 取代旧版 body.innerHTML 一把梭；id（om-topbar/om-messages/om-composer/om-input/om-send…）
// 与流式渲染类名（om-msg/om-body/om-error）保持不变，E2E 与 smoke-test 兼容。

import { LOGO_SVG } from './brand.js';

const I = (inner, size = 20) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = inner;
  return svg;
};

export const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  regen: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8l1.2 3 3.1-1 1.9 3.2-2.3 2.2 2.3 2.2-1.9 3.2-3.1-1-1.2 3h-0l-1.2-3-3.1 1-1.9-3.2 2.3-2.2-2.3-2.2 1.9-3.2 3.1 1z"/>',
  send: '<path d="M4.5 12L20 4l-4 16-4.5-6.5L4.5 12z"/><path d="M11.5 13.5L20 4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  // 船帆 logo：路径定义在 brand.js（扩展图标生成器同源）
  logo: LOGO_SVG,
  paperclip: '<path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
  folder: '<path d="M3 7h6l2 2h10v10H3z"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  download: '<path d="M12 3v12M6 11l6 6 6-6M4 21h16"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
  bash: '<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 8V4M9 4h6"/><path d="M9 13h.01M15 13h.01"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  arrowDown: '<path d="M12 5v13M6 12l6 6 6-6"/>',
  arrowUp: '<path d="M12 19V6M6 12l6-6 6 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
};

function el(tag, cls, children = []) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

function iconBtn(id, icon, title) {
  const b = el('button', 'om-icon-btn');
  b.id = id;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.appendChild(I(ICONS[icon]));
  return b;
}

export function buildShell({ variant = 'panel' }) {
  document.body.className = `om-app om-app--${variant}`;
  document.body.innerHTML = '';

  // ---- 侧边栏 ----
  const logo = el('a', 'om-logo', [
    I(ICONS.logo, 22),
    el('span', '', [document.createTextNode('Vela')]),
  ]);
  logo.href = '#';

  const newBtn = el('button', 'om-new-chat', [I(ICONS.plus, 18), el('span', '', [document.createTextNode('新对话')])]);
  newBtn.id = 'om-new';

  const filter = el('input', 'om-conv-filter');
  filter.id = 'om-conv-filter';
  filter.placeholder = '搜索对话';
  filter.type = 'search';

  const convList = el('nav', 'om-conv-list');
  convList.id = 'om-conv-list';

  const settingsBtn = el('button', 'om-side-settings', [I(ICONS.gear, 18), el('span', '', [document.createTextNode('设置')])]);
  settingsBtn.id = 'om-settings';

  const sidebar = el('aside', 'om-sidebar', [
    el('div', 'om-side-head', [logo, newBtn]),
    el('div', 'om-side-search', [I(ICONS.search, 16), filter]),
    convList,
    el('div', 'om-side-foot', [settingsBtn]),
  ]);
  sidebar.id = 'om-sidebar';

  const scrim = el('div', 'om-scrim');
  scrim.id = 'om-scrim';

  // ---- 主区 ----
  // 引擎（会话级）：Agent / LLM 问答 / LLM 任务；切换时空会话原地换，有消息则新建对话
  const engine = el('select', 'om-engine-select');
  engine.id = 'om-engine';
  engine.title = '聊天引擎：Agent 走本机 bridge；LLM 直连设置页的供应商（任务模式可调用浏览器工具）';
  engine.innerHTML = '<option value="agent">Agent</option>'
    + '<option value="llm">LLM 问答</option>'
    + '<option value="llm-tools">LLM 任务</option>';

  const model = el('select', 'om-model-select');
  model.id = 'om-model';
  model.title = '选择模型';

  const agentSelect = el('select', 'om-agent-select');
  agentSelect.id = 'om-agent';
  agentSelect.title = '选择 agent';
  agentSelect.style.display = 'none';

  const menuBtn = iconBtn('om-menu', 'menu', '会话列表');
  // 页面动作入口在页面浮窗与右键菜单；顶栏只留模型/agent 选择、设置、会话操作（默认 Agent，不放引擎切换）
  const topSettingsBtn = iconBtn('om-topbar-settings', 'gear', '设置供应商与翻译选项');
  const exportBtn = iconBtn('om-export', 'download', '导出会话为 Markdown');
  const regenBtn = iconBtn('om-regen', 'regen', '重新生成最后回复');
  const delBtn = iconBtn('om-del', 'trash', '删除当前对话');

  const topbar = el('header', 'om-topbar', [
    menuBtn,
    engine,
    model,
    agentSelect,
    el('div', 'om-top-spacer'),
    topSettingsBtn,
    exportBtn,
    regenBtn,
    delBtn,
  ]);
  topbar.id = 'om-topbar';

  const messages = el('div', 'om-messages');
  messages.id = 'om-messages';
  const column = el('div', 'om-msg-column');
  messages.appendChild(column);

  const input = el('textarea', 'om-input');
  input.id = 'om-input';
  input.rows = 1;
  input.placeholder = '输入消息，Enter 发送，Shift+Enter 换行';

  // 附件（回形针）与知识库（书）入口在 composer 左侧；待发附件 chips 在输入框上方
  const attachBtn = iconBtn('om-attach', 'paperclip', '附件（文件/图片/音视频）');
  const kbBtn = iconBtn('om-kb', 'book', '知识库（本对话）');
  const attachRow = el('div', 'om-attach-row');

  const send = el('button', 'om-send', [I(ICONS.send, 16), el('span', 'om-send-text', [document.createTextNode('发送')])]);
  send.id = 'om-send';

  // agent 轮运行中显示：停止当前轮。发送按钮保持「发送」——消息进队列，结束后自动发出
  const stopBtn = el('button', 'om-stop', [I(ICONS.stop, 12), el('span', '', [document.createTextNode('停止')])]);
  stopBtn.id = 'om-stop';
  stopBtn.title = '停止当前 agent 轮';
  stopBtn.hidden = true;

  // 会话级权限模式 + agent 模型：放输入框下方工具行（agent 会话才显示），切完下一轮生效
  const permSelect = el('select', 'om-perm-select');
  permSelect.id = 'om-perm';
  permSelect.title = '权限模式：agent 工具调用的审批策略，下一轮生效';
  permSelect.style.display = 'none';
  permSelect.innerHTML = '<option value="default">每步审批</option>'
    + '<option value="acceptEdits">自动接受编辑</option>'
    + '<option value="bypassPermissions">自动放行</option>';

  const agentModel = el('select', 'om-perm-select');
  agentModel.id = 'om-agent-model-sel';
  agentModel.title = 'agent 模型：默认模型用设置页配置，会话级覆盖下一轮生效';
  agentModel.style.display = 'none';

  const composer = el('footer', 'om-composer', [
    el('div', 'om-input-card', [
      attachRow,
      input,
      el('div', 'om-composer-bar', [
        attachBtn,
        kbBtn,
        permSelect,
        agentModel,
        el('span', 'om-composer-hint', [document.createTextNode('Enter 发送 · Shift+Enter 换行')]),
        stopBtn,
        send,
      ]),
    ]),
  ]);
  composer.id = 'om-composer';

  // 跳到最新：流式期间用户上滚翻历史时浮现，点按回到底部并恢复自动跟随
  const jump = el('button', 'om-jump', [I(ICONS.arrowDown, 13), el('span', '', [document.createTextNode('最新')])]);
  jump.id = 'om-jump';
  jump.title = '跳到最新消息';
  jump.hidden = true;

  const main = el('main', 'om-main', [topbar, messages, composer, jump]);

  const toast = el('div', 'om-toast');
  toast.id = 'om-toast';

  document.body.append(sidebar, scrim, main, toast);

  return {
    sidebar, scrim, convList, filter,
    topbar, menuBtn, topSettingsBtn,
    messages, column,
    composer, input, send, stop: stopBtn, jump,
    attachBtn, kbBtn, attachRow,
    model, engine, agentSelect, permSelect, agentModel,
    newBtn, settingsBtn, delBtn, regenBtn, exportBtn,
    toast,
  };
}

// 轻量 toast：3 秒自动消失，错误常显
export function showToast(toastEl, message, kind = 'info', sticky = false) {
  toastEl.textContent = message;
  toastEl.className = `om-toast om-toast--${kind} om-toast--show`;
  clearTimeout(showToast._t);
  if (!sticky) showToast._t = setTimeout(() => toastEl.classList.remove('om-toast--show'), 3000);
}
