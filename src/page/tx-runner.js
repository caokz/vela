// 隐藏翻译编排页：浮窗「翻译此页」在宿主页面内开一个 0×0 iframe 加载本页，
// 翻译管线在此驻留（视口驱动 + 滚动续译），不弹聊天卡。
// 进度与状态由浮球 / om:tx-state 呈现；收场时 postMessage 通知宿主页浮窗清理。
import { loadSettings } from '../llm/store.js';
import { translateCurrentTab, cancelTranslate } from './page-actions.js';

function post(type, message) {
  try { parent.postMessage({ type, message }, '*'); } catch { /* 宿主页环境异常时忽略 */ }
}

// 浮窗开关复位（再点一次还原原文）：宿主页移除本 iframe 前先取消在途请求
window.addEventListener('message', (ev) => {
  if (ev.data?.type === 'om:tx-cancel') cancelTranslate();
});

(async () => {
  const settings = await loadSettings();
  console.info('[Vela] 翻译编排启动：mode =', settings.translation.mode, '，lang =', settings.translation.targetLang);
  if (!settings.providers.length) {
    post('om:tx-failed', '请先在设置页配置供应商并保存');
    return;
  }
  try {
    await translateCurrentTab(settings);
    post('om:tx-done'); // 页面侧还原/关闭/导航后的静默收场
  } catch (e) {
    if (e?.name === 'AbortError' || e?.message === '用户关闭翻译') {
      post('om:tx-done');
      return;
    }
    post('om:tx-failed', e.message || String(e));
  }
})();
