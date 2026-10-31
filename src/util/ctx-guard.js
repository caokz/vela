// 扩展上下文失效处理：开发者点「重新加载」/ 商店更新扩展后，已经打开的扩展页（尤其是嵌在网页里的
// 聊天卡 iframe）还在跑旧代码，但 chrome.* 已不可用，任何调用都抛 "Extension context invalidated."。
// 旧版里重连定时器等后台逻辑仍会调 chrome.storage，每次都抛未捕获的 Promise 异常，
// 被 Chrome 记进扩展「错误」页。这里统一识别这类错误，并让页面自行刷新到新版本。

export function ctxAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

export function isCtxInvalid(e) {
  return /Extension context invalidated/i.test(String(e?.message ?? e ?? ''));
}

let handled = false;

/**
 * 安装全局兜底：捕获未处理的「上下文失效」错误（吞掉，不再进错误页），并触发 onInvalid 一次。
 * 嵌在网页里的聊天卡可自动重载自身（新扩展同一 URL）；顶层页面只提示，避免打断用户。
 */
export function installCtxGuard(onInvalid) {
  const trip = () => {
    if (handled) return;
    handled = true;
    try { onInvalid?.(); } catch { /* 提示失败也不能再抛 */ }
  };
  window.addEventListener('unhandledrejection', (ev) => {
    if (isCtxInvalid(ev.reason)) { ev.preventDefault(); trip(); }
  });
  window.addEventListener('error', (ev) => {
    if (isCtxInvalid(ev.error ?? ev.message)) { ev.preventDefault(); trip(); }
  });
  // 兜底轮询：没有任何调用失败时（空闲的卡片）也能发现并刷新，不必等用户点一下才报错
  const t = setInterval(() => { if (!ctxAlive()) { clearInterval(t); trip(); } }, 3000);
  return t;
}
