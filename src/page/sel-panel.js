// 划词就地结果面板（Monica 式）：翻译 / 解释代码 / 总结不走聊天卡，直接调 LLM 流式渲染。
// 由 selection-popup 在宿主页里开的固定定位 iframe 加载本页；LLM 调用与 markdown 渲染
// 都在扩展源里跑（内容脚本受页面 CORS 约束不能直连供应商）。与宿主页通信走 postMessage：
// 收 om:sel-panel-run 跑一轮；发 om:sel-panel-height / -close / -ask 给宿主页内容脚本。
import { loadSettings, streamChat } from '../llm/store.js';
import { renderMarkdown } from '../ui/markdown.js';

const LANG_NAMES = {
  'zh-CN': '简体中文', 'zh-TW': '繁体中文', en: '英文', ja: '日文', ko: '韩文',
  fr: '法文', de: '德文', es: '西班牙文', ru: '俄文', pt: '葡萄牙文', it: '意大利文',
};

const ACTS = {
  translate: { title: '翻译', icon: '<path d="M3 5h9M7.5 5c0 4.5-2 8.5-4.5 10.5M4.5 9.5c1.6 3 4 5.2 7 6"/><path d="M12.5 19.5l4-10 4 10M14 16.5h5"/>' },
  explain: { title: '解释代码', icon: '<path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/>' },
  summary: { title: '总结', icon: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>' },
};

const job = { act: '', text: '', result: '', ac: null, running: false };

function post(type, extra = {}) {
  try { parent.postMessage({ type, ...extra }, '*'); } catch { /* 宿主页环境异常时忽略 */ }
}

function svg(icon) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', '15');
  el.setAttribute('height', '15');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.8');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.innerHTML = icon;
  return el;
}

// ---- DOM 骨架 ----
const header = document.createElement('header');
const titleEl = document.createElement('span');
titleEl.className = 'om-title';
const closeBtn = document.createElement('button');
closeBtn.title = '关闭';
closeBtn.textContent = '×';
header.append(svg(''), titleEl, closeBtn);

const srcDet = document.createElement('details');
srcDet.className = 'src';
const srcSum = document.createElement('summary');
const srcPre = document.createElement('pre');
srcDet.append(srcSum, srcPre);

const body = document.createElement('div');
body.className = 'om-body';

const footer = document.createElement('footer');
const follow = document.createElement('div');
follow.className = 'om-follow';
const followIn = document.createElement('textarea');
followIn.rows = 1;
followIn.placeholder = '针对结果继续追问（转入对话，走 agent 分析）…';
const followBtn = document.createElement('button');
followBtn.textContent = '追问';
follow.append(followIn, followBtn);
const tools = document.createElement('div');
tools.className = 'om-tools';
const hint = document.createElement('span');
hint.className = 'om-hint';
const copyBtn = document.createElement('button');
copyBtn.textContent = '复制';
const retryBtn = document.createElement('button');
retryBtn.textContent = '重新生成';
tools.append(hint, copyBtn, retryBtn);
footer.append(follow, tools);

document.body.append(header, srcDet, body, footer);

// 高度自适应：宿主页按上报值调 iframe 高度（自身再夹在视口内）
const postHeight = () => post('om:sel-panel-height', { h: Math.ceil(document.documentElement.getBoundingClientRect().height) });
new ResizeObserver(postHeight).observe(document.documentElement);

// ---- 一轮生成 ----
function setRunning(on) {
  job.running = on;
  retryBtn.disabled = on;
  copyBtn.disabled = on || !job.result;
}

function renderBody() {
  if (job.result) body.innerHTML = renderMarkdown(job.result);
  else {
    body.innerHTML = '<p class="om-empty">正在生成</p>';
    return;
  }
  if (job.running) body.insertAdjacentHTML('beforeend', '<p class="om-empty" style="margin:0"></p>');
  body.scrollTop = body.scrollHeight;
}

function buildPrompt(act, text, settings) {
  if (act === 'translate') {
    const lang = LANG_NAMES[settings?.translation?.targetLang] || '简体中文';
    return `把下面的内容翻译成${lang}，只输出译文，保留原文的段落与格式，不要任何解释：\n\n${text}`;
  }
  if (act === 'explain') {
    return [
      '请解释下面这段代码：先用一句话概括作用，再分要点说明关键逻辑（数据流、依赖、边界条件），',
      '最后指出潜在问题或改进点。用简体中文回答：',
      '',
      '```',
      text,
      '```',
    ].join('\n');
  }
  return `总结下面这段内容的要点，用中文：\n\n${text}`;
}

async function run() {
  const settings = await loadSettings();
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId) || settings.providers[0];
  if (!provider?.models?.length) {
    body.innerHTML = '<p class="om-error">请先在设置页配置供应商并保存</p>';
    return;
  }
  job.ac?.abort();
  job.ac = new AbortController();
  job.result = '';
  hint.textContent = '';
  setRunning(true);
  renderBody();
  let finished = false;
  try {
    await streamChat({
      messages: [{ role: 'user', content: buildPrompt(job.act, job.text, settings) }],
      model: provider.models[0],
      signal: job.ac.signal,
      onDelta: (d) => {
        if (d.error) {
          job.result = '';
          const msg = String(d.error.message || '请求失败').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          body.innerHTML = `<div class="om-error">${msg}</div>`;
          finished = true;
          return;
        }
        if (d.text) {
          job.result += d.text;
          renderBody();
        }
        if (d.finished) finished = true;
      },
    });
  } catch (e) {
    if (e?.name !== 'AbortError') {
      job.result = '';
      body.innerHTML = `<p class="om-error">出错了：${e.message || e}</p>`;
    }
  }
  if (!job.result && !body.querySelector('.om-error')) body.innerHTML = '<p class="om-error">没有收到内容，可点「重新生成」重试</p>';
  setRunning(false);
  postHeight();
  void finished;
}

// ---- 交互 ----
closeBtn.addEventListener('click', () => post('om:sel-panel-close'));
retryBtn.addEventListener('click', () => { if (!job.running) run(); });
copyBtn.addEventListener('click', async () => {
  if (!job.result) return;
  // 面板是嵌在宿主页里的扩展源 iframe：宿主页 Permissions-Policy 挡掉
  // Clipboard API 时退回 execCommand
  const copyText = async (t) => {
    try { await navigator.clipboard.writeText(t); return true; } catch { /* 走兜底 */ }
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  };
  if (await copyText(job.result)) {
    hint.textContent = '已复制';
    setTimeout(() => { if (hint.textContent === '已复制') hint.textContent = ''; }, 1500);
  } else hint.textContent = '复制失败（页面限制剪贴板）';
});

function submitFollow() {
  const q = followIn.value.trim();
  if (!q || !job.result) return;
  post('om:sel-panel-ask', { question: q, act: job.act, text: job.text, result: job.result });
  followIn.value = '';
  followIn.style.height = 'auto';
  hint.textContent = '已转入对话窗口，可继续在这里追问';
}
followBtn.addEventListener('click', submitFollow);
followIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitFollow(); }
});
followIn.addEventListener('input', () => {
  followIn.style.height = 'auto';
  followIn.style.height = Math.min(followIn.scrollHeight, 96) + 'px';
});

// 只认宿主页内容脚本发来的任务
window.addEventListener('message', (ev) => {
  if (ev.source !== parent) return;
  const d = ev.data;
  if (d?.type !== 'om:sel-panel-run') return;
  const cfg = ACTS[d.act] ? d.act : 'translate';
  job.act = cfg;
  job.text = String(d.text || '');
  header.replaceChild(svg(ACTS[cfg].icon), header.querySelector('svg'));
  titleEl.textContent = ACTS[cfg].title;
  srcSum.textContent = job.text.replace(/\s+/g, ' ').slice(0, 60) + (job.text.length > 60 ? '…' : '');
  srcPre.textContent = job.text;
  srcDet.open = false;
  copyBtn.disabled = true;
  followIn.placeholder = `针对${ACTS[cfg].title}结果继续追问（转入对话，走 agent 分析）…`;
  postHeight();
  run();
});

post('om:sel-panel-ready');
