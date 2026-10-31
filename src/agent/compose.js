// 发给 bridge 的 prompt 组装（纯函数）：用户原文不动，知识库上传件与本条消息
// 附件以工作区内相对路径附加（cwd 即工作区根，不暴露用户主目录前缀）。

// conv.knowledge 里 kind:'local' 的条目 → 去重后的绝对路径数组（additionalDirectories 用）
export function knowledgeLocalDirs(conv) {
  const dirs = (conv?.knowledge ?? [])
    .filter((k) => k && k.kind === 'local')
    .map((k) => String(k.path || '').trim())
    .filter(Boolean);
  return [...new Set(dirs)];
}

// 知识库上传件 + 本条消息附件 → 附加在用户文本后的清单块。
// 会话绑定项目目录时 cwd 是项目目录而非工作区：上传件改列绝对路径
// （opts.workspacePath 来自 session.new/resume 响应，工作区已自动加入 contextDirs）。
export function buildAgentPrompt(conv, userItem, opts = {}) {
  const kbUploads = (conv?.knowledge ?? []).filter((k) => k && k.kind === 'upload' && k.relPath);
  // 浏览器授权的本机文件夹 / 文件：发送前已增量同步到工作区 wsPath（kb/sync.js）
  const kbHandles = (conv?.knowledge ?? []).filter((k) => k && k.kind === 'handle' && k.wsPath);
  // bridge 管的本机路径：CLI 侧已进 additionalDirectories 可直接读，但模型不知道它们
  // 存在——不在 prompt 里点名，问起相关内容它会按先验去网上找（GitHub / 搜索）
  const kbLocals = (conv?.knowledge ?? []).filter((k) => k && k.kind === 'local' && k.path);
  const attachments = userItem?.meta?.attachments ?? [];
  const absolute = !!(conv?.projectDir && opts.workspacePath);
  const ref = (relPath) => (absolute ? `${opts.workspacePath}/${relPath}` : relPath);
  const blocks = [];
  // 网页上下文（页内聊天卡提炼的宿主页正文）：agent 会话有记忆，只在首条 prompt 注入一次
  // （chat-ui 在 prompt 送达后置 conv.pageCtxSent）
  if (conv?.pageCtx && !conv.pageCtxSent) {
    const ctx = conv.pageCtx;
    blocks.unshift(
      `当前网页上下文（用户正在浏览的页面正文，回答问题的背景参考，无关时忽略）：\n`
      + `网页标题：${ctx.title || '（无标题）'}\n网页地址：${ctx.url || '（未知）'}\n\n`
      + String(ctx.text || '').slice(0, 6000),
    );
  }
  if (kbUploads.length) {
    blocks.push((absolute
      ? '知识库文件（已上传到独立工作区目录，你有读取权限，按绝对路径读取）：\n'
      : '知识库文件（已放入本会话工作目录 knowledge/ 下，回答前可按需读取）：\n')
      + kbUploads.map((k) => `- ${ref(k.relPath)}`).join('\n'));
  }
  if (kbHandles.length) {
    // opts.syncedIds 是本轮真正同步（含增量跳过）的条目 id（chat-ui 传入）；
    // 授权失效被跳过的条目如实标注，别让模型拿着「已同步」的承诺去列空目录、再转头联网
    const mark = (k) => (opts.syncedIds && !opts.syncedIds.has(k.id) ? '（本轮未同步，内容可能过期或缺失）' : '');
    blocks.push('知识库本机文件夹 / 文件（已同步到工作目录，回答相关问题优先读本地内容，本地查不到再联网；文件夹请先列目录再细读）：\n'
      + kbHandles.map((k) => `- ${ref(k.wsPath)}${k.handleKind === 'dir' ? '/' : ''}（${k.name}）${mark(k)}`).join('\n'));
  }
  if (kbLocals.length) {
    blocks.push('知识库本机路径（已加入会话可读目录，可用文件工具直接读取；回答相关问题优先读这些本地内容，本地查不到再联网；文件夹请先列目录再细读）：\n'
      + kbLocals.map((k) => `- ${k.path}`).join('\n'));
  }
  if (attachments.length) {
    blocks.push((absolute
      ? '本次消息附件（已上传到独立工作区目录，你有读取权限，按绝对路径读取/查看）：\n'
      : '本次消息附件（已上传到本会话工作目录 uploads/ 下，请用工具读取/查看）：\n')
      + attachments.map((a) => `- ${ref(a.relPath || a.name)}（${a.name}）`).join('\n'));
  }
  return blocks.length ? `${userItem.content}\n\n${blocks.join('\n\n')}` : userItem.content;
}

// 会话导出：把整段会话逐轮整理成 Markdown（问题原文 + 回答原文）。
// 导出不能依赖 agent 的会话记忆——长会话在 agent 侧被自动压缩后记忆只剩尾部，
// 这里以扩展存储的会话记录为唯一来源，内容完整。
export function buildConversationMarkdown(conv, { exportedAt = new Date() } = {}) {
  const firstLine = (text) => {
    const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '（空）';
    return line.length > 40 ? `${line.slice(0, 40)}…` : line;
  };
  const lines = [
    `# ${conv?.title || '未命名会话'}`,
    '',
    `> 导出时间：${exportedAt.toLocaleString()}`,
    '',
  ];
  let n = 0;
  for (const item of conv?.items ?? []) {
    if (item.type === 'question') {
      n += 1;
      lines.push(`## ${n}. ${firstLine(item.content)}`, '', '**问：**', '', String(item.content || ''), '');
    } else if (item.type === 'answer' && (item.content || item.error)) {
      lines.push(`**答${item.model ? `（${item.model}）` : ''}：**`, '');
      if (item.content) lines.push(String(item.content), '');
      if (item.error) lines.push(`> 出错：${item.error}`, '');
      if (item.stopped) lines.push('> （本轮被手动停止）', '');
    }
  }
  return lines.join('\n');
}
