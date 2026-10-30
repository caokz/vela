// 页面功能编排器（扩展页面侧）：总结与翻译。
// 提取/分批/LLM 调用/回填都在这里驱动，SW 不参与——天然规避 MV3 SW 30 秒回收。

import { streamChat } from '../llm/store.js';
import {
  buildSummaryPrompt, buildTranslateBatchPrompt, buildTranslateRetryPrompt,
  parseTranslationArray,
} from '../llm/tasks.js';
import * as injected from '../content/injected.js';

const NON_INJECTABLE = /^(chrome|edge|about|devtools|view-source|chrome-extension|https:\/\/chrome\.google\.com\/webstore|https:\/\/chromewebstore\.google\.com)/i;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id == null) throw new Error('找不到活动标签页');
  if (NON_INJECTABLE.test(tab.url || '')) throw new Error('此页面（浏览器内置页）无法注入脚本');
  return tab;
}

async function runInjected(tabId, fn, args = []) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args });
    return results?.[0]?.result;
  } catch (e) {
    throw new Error(`无法在此页面执行脚本（${e.message}）`);
  }
}

// ---- 网页总结 ----
// 返回 { prompt, meta }，由聊天视图组装成用户消息发送；不足 80 字符视为提取失败。
export async function summarizeCurrentTab() {
  const tab = await activeTab();
  const article = await runInjected(tab.id, injected.extractArticle);
  if (!article || (article.text || '').trim().length < 80) {
    throw new Error('没能从页面提取到足够的正文内容（页面可能是空白、框架结构或需要登录）');
  }
  return {
    prompt: buildSummaryPrompt({ title: article.title, url: article.url, text: article.text }),
    meta: { kind: 'page-summary', url: article.url, title: article.title },
  };
}

// ---- 网页翻译 ----
// 视口驱动（Monica 式）：bridge 在页面里发现并观察文本块，进视口才上报 om:tx_need；
// 这里按需小批量翻译、译完一批回填一批，滚动出现新内容继续译，直到还原/关闭/导航。
// 编排可跑在隐藏 runner iframe 或聊天卡里：全程不依赖可见 UI，进度由浮球呈现。

let txAbort = null; // 正在进行的翻译的 AbortController
export function cancelTranslate() {
  txAbort?.abort();
}

// 借 streamChat 跑一批翻译：返回与 items 对齐的 (string|null)[]。
// 429/限流抛 RateLimitError；其余错误向上抛由调用方决定重试。
class RateLimitError extends Error {}

async function translateBatch(items, targetLang, attempt, signal) {
  let out = '';
  let failed = null;
  await streamChat({
    messages: [{
      role: 'user',
      content: attempt > 0
        ? buildTranslateRetryPrompt({ items, targetLang })
        : buildTranslateBatchPrompt({ items, targetLang }),
    }],
    signal,
    overrides: { temperature: 0 },
    onDelta: (d) => {
      if (d.error) { failed = new Error(d.error.message || '翻译请求失败'); return; }
      if (d.text) out += d.text;
    },
  });
  if (failed) {
    if (/429|限流|rate.?limit/i.test(failed.message)) throw new RateLimitError(failed.message);
    throw failed;
  }
  return parseTranslationArray(out, items.length);
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

const TX_CSS = [
  '.om-tx-dst { opacity: 0.94; border-left: 2px solid rgba(104,65,234,.4); padding-left: 10px; margin: 6px 0 10px; animation: om-tx-in .28s ease; }',
  '@keyframes om-tx-in { from { opacity: 0; transform: translateY(3px); } }',
  '[data-om-tx].om-tx-wait::after { content: \'翻译中\'; margin-left: 8px; color: #d93025; font-size: 12px; font-weight: 500; line-height: 1; vertical-align: 1px; animation: om-tx-blink 1.2s ease infinite; }',
  '@keyframes om-tx-blink { 50% { opacity: .35; } }',
  '[data-om-tx].om-tx-failed { border-bottom: 1px dotted rgba(217,48,37,.65); }',
  '@media (prefers-color-scheme: dark) { .om-tx-dst { border-left-color: rgba(152,128,248,.5); } [data-om-tx].om-tx-wait::after { color: #f0883a; } }',
].join('\n');

// 全流程：注入 bridge → bridge 视口上报待译块 → 小批量并发翻译 → 逐批回填。
// onEvent 上报 {phase}；promise 直到取消/出错/页面导航才落定（滚动续译期间保持驻留）。
export async function translateCurrentTab(settings, onEvent = () => {}) {
  if (txAbort) txAbort.abort(); // 上一轮未结束：先停
  const ac = new AbortController();
  txAbort = ac;
  const signal = ac.signal;
  const tab = await activeTab();
  const tabId = tab.id;
  const cfg = { ...settings.translation };
  const targetLang = langName(cfg.targetLang);
  let port = null;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/bridge.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, css: TX_CSS });

    port = chrome.tabs.connect(tabId, { name: 'om-tx' });

    const queue = []; // 待译 { id, text }
    const seen = new Set(); // 已受理（含在途/已完成）的块 id
    let seenChars = 0; // 已受理块累计字符：上限只管翻译量，不管页面发现量
    const settled = new Set(); // 已回填/已失败的块 id
    const results = { translated: 0, failed: 0 };
    let inflight = 0;
    let workersActive = 0;
    let doneSent = false;

    const maybeDone = () => {
      // 已受理全部落定且无在途：当前可见范围译完。滚动会有新 om:tx_need 重新激活。
      if (doneSent || inflight || queue.length || settled.size < seen.size) return;
      doneSent = true;
      port.postMessage({ type: 'om:tx_progress', phase: 'done' });
      onEvent({ phase: 'done', translated: results.translated, failed: results.failed });
    };

    const checkDoneArrived = () => { if (doneSent) doneSent = false; };

    async function runItems(items) {
      let arr = null;
      for (let attempt = 0; attempt <= 2; attempt++) {
        try {
          arr = await translateBatch(items, targetLang, attempt, signal);
          break;
        } catch (e) {
          if (signal.aborted) return null;
          if (e instanceof RateLimitError) throw new Error('供应商限流（429），翻译已中止，可稍后重试');
          // 上下文溢出：对半拆批递归重试（拆到单块仍失败则记失败）
          if (/context length|maximum context|上下文长度/i.test(e.message || '')) {
            if (items.length > 1) {
              const mid = Math.ceil(items.length / 2);
              const a = await runItems(items.slice(0, mid));
              if (a == null) return null;
              const b = await runItems(items.slice(mid));
              if (b == null) return null;
              return [...a, ...b];
            }
            arr = null;
            break;
          }
          if (attempt === 2) { arr = null; break; }
          await sleep(attempt === 0 ? 1000 : 3000, signal); // 退避 1s / 3s
        }
      }
      return arr;
    }

    async function worker() {
      workersActive++;
      try {
        while (!signal.aborted) {
          // 从队头攒一小批：块数或字符先到为准
          const items = [];
          let chars = 0;
          while (queue.length && items.length < Math.max(1, cfg.batchBlocks)) {
            const it = queue[0];
            if (items.length && chars + it.text.length > 1600) break;
            items.push(queue.shift());
            chars += it.text.length;
          }
          if (!items.length) break;
          checkDoneArrived();
          inflight++;
          const arr = await runItems(items);
          if (signal.aborted) return;
          port.postMessage({
            type: 'om:tx_batch',
            items: items.map((it, i) => ({ id: it.id, text: arr ? arr[i] : null })),
          });
          items.forEach((it, i) => {
            settled.add(it.id);
            if (arr && arr[i] != null) results.translated += 1;
            else results.failed += 1;
          });
          inflight--;
          onEvent({ phase: 'translating', translated: results.translated, failed: results.failed });
          maybeDone();
        }
      } catch (e) {
        finish(e); // 限流等致命错误：整体收场
      } finally {
        workersActive--;
      }
    }

    const kickWorkers = () => {
      while (workersActive < 2 && queue.length) void worker();
    };

    let ended = false;
    const finish = (err) => {
      if (ended) return;
      ended = true;
      if (err) ac.abort(err);
    };

    port.onMessage.addListener((msg) => {
      if (msg.type === 'om:tx_need') {
        const skipped = [];
        for (const it of msg.items || []) {
          if (seen.has(it.id) || it.text == null) continue;
          // 段数/字符数到顶：后续需求拒收（当前已受理的批次仍会译完），
          // 回告 bridge 撤掉「翻译中」标记，别让被拒块永久闪烁
          if (seen.size >= cfg.maxBlocks || seenChars + it.text.length > cfg.maxChars) {
            skipped.push(it.id);
            continue;
          }
          seen.add(it.id);
          seenChars += it.text.length;
          queue.push(it);
        }
        if (skipped.length) {
          try { port.postMessage({ type: 'om:tx_skip', ids: skipped }); } catch { /* 端口已断 */ }
        }
        kickWorkers();
      } else if (msg.type === 'om:tx_error' && msg.fatal) {
        finish(new Error(msg.message));
      } else if (msg.type === 'om:tx_ended') {
        finish(); // 页面侧已还原（用户开关/浮球菜单）：编排静默收场
      }
    });
    port.onDisconnect.addListener(() => finish()); // 页面导航/刷新：按取消处理

    port.postMessage({
      type: 'om:tx_start',
      mode: cfg.mode,
      targetLang,
    });
    onEvent({ phase: 'started' });

    // 驻留直到取消/出错/端口关闭（signal.reason 携带致命错误）
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        const reason = signal.reason;
        if (reason instanceof Error && reason.name !== 'AbortError') reject(reason);
        else resolve({ translated: results.translated, failed: results.failed });
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    });
    return { translated: results.translated, failed: results.failed };
  } finally {
    if (txAbort === ac) txAbort = null;
    try { port?.disconnect(); } catch { /* 已断开 */ }
  }
}

function langName(code) {
  const names = {
    'zh-CN': '简体中文', 'zh-TW': '繁体中文', en: '英文', ja: '日文', ko: '韩文',
    fr: '法文', de: '德文', es: '西班牙文', ru: '俄文', pt: '葡萄牙文', it: '意大利文',
  };
  return names[code] || code;
}
