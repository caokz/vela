// 本页思维导图查看页。网页上划词点「高亮」时内容已由 SW 收进素材库（omMindmapInbox，
// 按页 key 聚合，另存打开查看页时带回的页面正文快照）；工具条「思维导图」钮与浮窗
// 「导图」钮（无需选中文字）都只负责开本页（SW 把 {view,url,title} 暂存 storage.session
// 的 omMindmapJob:<id> 后跳转）。顶栏「高亮导图 / 整页导图」随时切换双模式：有旧图
// 直接打开（零调用），没有则点击即生成；「新导图」清空另起一张，「‹ 返回导图」回到前一张。
// 生成永远由用户显式点击（素材卡「生成思维导图」/顶栏模式钮/「重新生成」），LLM 按网页正文
// 上下文 + 全部高亮片段整理；高亮随时增删不会触发生成，只在状态里提示「素材有更新」。
// 同页导图在历史里原位更新。本页是扩展页上下文：流式 LLM 调用在这里跑（MV3 约束，
// 不进 SW），与 sel-panel 同款走激活供应商；流式期间渐进解析渲染，完成后存
// chrome.storage.local（omMindmaps，最多 50 份，#id=<mm:> 重新打开不调 LLM）。
// 编辑：双击节点就地改名，「编辑大纲」直接改 markdown（增删节点 / 调结构）后应用重渲染，
// 改动即时回存。渲染是零依赖 SVG 双侧树：根居中、一级分支左右分列，节点点击折叠，
// 画布拖拽平移与滚轮缩放。导出：.md（规范 markdown 大纲，与解析格式同构）与 .mm（FreeMind XML）。
// 注意：svg 显隐必须用 toggleAttribute('hidden')——SVGElement 没有 hidden IDL 属性，
// 赋值 svg.hidden 只是 JS 属性，真属性摘不掉，画布会一直 display:none（0.9.1 前的空白根因）。
import { loadSettings, streamChat } from '../llm/store.js';
import { buildMindmapPrompt, buildMindmapFullPrompt, MINDMAP_MAX_CHARS } from '../llm/tasks.js';
import { parseOutline, outlineToMarkdown, outlineToFreemind, countNodes, splitRef } from './outline.js';
import { DRAFT_KEY, pageKeyOf, assembleDraftText, draftSig, textSig } from './draft.js';

const $ = (id) => document.getElementById(id);
const svgEl = $('om-mm-svg');
const inputView = $('om-mm-input');
const editorView = $('om-mm-editor');
const titleEl = $('om-mm-title');
const statusEl = $('om-mm-status');
const stopBtn = $('om-mm-stop');
const backBtn = $('om-mm-back');
const modeMatBtn = $('om-mm-mode-mat');
const modeFullBtn = $('om-mm-mode-full');
const regenBtn = $('om-mm-regen');
const editBtn = $('om-mm-edit');
const fitBtn = $('om-mm-fit');
const foldBtn = $('om-mm-fold');
const unfoldBtn = $('om-mm-unfold');
const expMdBtn = $('om-mm-exp-md');
const expMmBtn = $('om-mm-exp-mm');
const newBtn = $('om-mm-new');
const matBtn = $('om-mm-mat');
const matCard = $('om-mm-page-card');
const matList = $('om-mm-mat-list');
const matRun = $('om-mm-mat-run');
const fullRun = $('om-mm-full-run');
const matErr = $('om-mm-mat-err');
const matHint = $('om-mm-mat-hint');
const edText = $('om-mm-ed-text');
const edApply = $('om-mm-ed-apply');
const edCancel = $('om-mm-ed-cancel');
const edErr = $('om-mm-ed-err');
const inTitle = $('om-mm-in-title');
const inText = $('om-mm-in-text');
const inRun = $('om-mm-in-run');
const inErr = $('om-mm-in-err');
const historyEl = $('om-mm-history');

const HISTORY_KEY = 'omMindmaps';
const HISTORY_MAX = 50;

const state = {
  md: '',                 // 当前大纲 markdown（权威，来自流式或历史记录）
  root: null,             // 渲染树 {label, children}，节点带布局字段（_x/_y/_m）
  meta: { title: '', url: '' },
  jobText: '',            // 待整理的高亮片段（生成中用）
  pageCtx: '',            // 页面正文快照（生成时作 LLM 上下文）
  draftKey: '',           // 页面模式的素材页 key（素材卡/重新生成可见；同页导图原位更新）
  draftSig: '',           // 最近一次生成（或打开的旧图）对应的素材/正文指纹
  genMode: 'material',    // 生成模式：material=高亮素材 / full=整页正文（同页两种导图各存一条）
  matCount: 0,             // 素材段数（顶栏素材按钮角标）
  running: false,
  ac: null,
  folded: new Set(),      // 折叠节点 id 集合
  savedId: null,          // 已保存/要更新的历史记录 id（编辑与重新生成走原位更新）
  backId: null,           // 「新导图」清空前的导图 id：「‹ 返回导图」的退路
  hadError: false,
  genSeq: 0,              // 生成轮次：新视图接管后旧轮收尾不再覆盖界面
};

const view = { tx: 0, ty: 0, k: 1 };

// ---------- 布局与渲染（零依赖 SVG 双侧树） ----------
const NS = 'http://www.w3.org/2000/svg';
const FONT_BODY = '13px system-ui, "Segoe UI", sans-serif';
const FONT_REF = '11px system-ui, "Segoe UI", sans-serif'; // 出处角标小字
const LINE_H = 19;
const PAD_X = 10;
const PAD_Y = 6;
const MAX_LABEL_W = 230; // 节点标签最大宽度，超出折行
const MAX_LINES = 5;     // 单节点最多行数，超出截断加省略号（防超长标签撑爆画布）
const GAP_SIB = 12;      // 兄弟节点纵向间距
const GAP_LEVEL = 56;    // 层级横向间距
const BRANCH_COLORS = ['#6841EA', '#0E7CE4', '#0E9F6E', '#E4810E', '#D6409F', '#0F9EB5', '#C2410C', '#6D7180'];
const ROOT_BG = '#3a3450';

const mctx = document.createElement('canvas').getContext('2d');

// 度量：主体按 13px 折行截断；标签尾部的出处标注（〔片段n〕/〔§小节名〕，splitRef
// 拆出）以 11px 小字渲染——与末行同排放得下就同行（refW 记入该行宽），放不下另起一行。
// lines 是 {text, isRef}，draw() 据此给角标 tspan 加 class 换样式。
function measureNode(n) {
  if (n._m) return n._m;
  const { main, ref } = splitRef(n.label);
  mctx.font = FONT_BODY;
  const lines = [];
  let cur = '';
  for (const ch of [...(main || '')]) {
    if (cur && mctx.measureText(cur + ch).width > MAX_LABEL_W) { lines.push(cur); cur = ch; }
    else cur += ch;
    if (lines.length === MAX_LINES) break;
  }
  if (lines.length === MAX_LINES) {
    // 截断行补省略号并压回最大宽度内
    let last = (cur || lines[MAX_LINES - 1]) + '…';
    while (last.length > 1 && mctx.measureText(last).width > MAX_LABEL_W) last = last.slice(0, -2) + '…';
    lines[MAX_LINES - 1] = last;
  } else if (cur) lines.push(cur);
  if (!lines.length) lines.push('　');
  const out = lines.map((text) => ({ text, isRef: false, refW: 0 }));
  if (ref) {
    mctx.font = FONT_REF;
    const rw = Math.ceil(mctx.measureText(ref).width) + 4; // +4：同行时与主体留一点间距
    mctx.font = FONT_BODY;
    const lastLine = out[out.length - 1];
    if (mctx.measureText(lastLine.text).width + rw <= MAX_LABEL_W) lastLine.refW = rw;
    else out.push({ text: ref, isRef: true, refW: 0 });
  }
  const lineW = (l) => {
    mctx.font = l.isRef ? FONT_REF : FONT_BODY;
    return mctx.measureText(l.text).width + l.refW;
  };
  const w = Math.max(40, Math.ceil(Math.max(...out.map(lineW))) + PAD_X * 2);
  n._m = { lines: out, ref, w, h: out.length * LINE_H + PAD_Y * 2 };
  return n._m;
}

// 一次性编号（折叠状态跨渲染稳定）与分支配色（一级分支一色，子树继承）
function prepTree(root) {
  let i = 0;
  const walk = (n, depth, color) => {
    n.id = `n${i++}`;
    n.depth = depth;
    n._m = null;
    n.color = depth === 1 ? BRANCH_COLORS[(n.branchIndex ?? 0) % BRANCH_COLORS.length] : color;
    for (const c of n.children || []) walk(c, depth + 1, n.color);
  };
  root.color = ROOT_BG;
  (root.children || []).forEach((c, idx) => { c.branchIndex = idx; });
  walk(root, 0, ROOT_BG);
}

const visibleChildren = (n) => (state.folded.has(n.id) ? [] : n.children || []);

// 经典整洁树布局：子树高度自下而上取 max(自身, 子块和)，父级在自身跨度内垂直居中；
// 一级分支前一半排右侧、后一半排左侧，根居中。x 按层取该层最大节点宽累进，两侧对称。
function layout(root) {
  const subH = (n) => {
    const kids = visibleChildren(n);
    if (!kids.length) return measureNode(n).h;
    const kh = kids.reduce((s, c) => s + subH(c), 0) + GAP_SIB * (kids.length - 1);
    return Math.max(measureNode(n).h, kh);
  };
  const levelW = new Map();
  const scan = (n, depth) => {
    const m = measureNode(n);
    levelW.set(depth, Math.max(levelW.get(depth) ?? 0, m.w));
    for (const c of visibleChildren(n)) scan(c, depth + 1);
  };
  scan(root, 0);
  const kids = root.children || [];
  const nRight = Math.ceil(kids.length / 2);
  const right = kids.slice(0, nRight);
  const left = kids.slice(nRight);
  right.forEach((n) => scan(n, 1));
  left.forEach((n) => scan(n, 1));
  const xAt = [0];
  let x = measureNode(root).w / 2 + GAP_LEVEL;
  for (let d = 1; levelW.has(d); d++) {
    xAt[d] = x;
    x += levelW.get(d) + GAP_LEVEL;
  }
  const stackH = (nodes) => (nodes.length
    ? nodes.reduce((s, n) => s + subH(n), 0) + GAP_SIB * (nodes.length - 1)
    : 0);
  const place = (n, depth, top, sign) => {
    const h = subH(n);
    const m = measureNode(n);
    n._x = sign > 0 ? xAt[depth] : -xAt[depth] - m.w;
    n._y = top + h / 2;
    const cs = visibleChildren(n);
    if (cs.length) {
      const ch = cs.reduce((s, c) => s + subH(c), 0) + GAP_SIB * (cs.length - 1);
      let ct = top + (h - ch) / 2;
      for (const c of cs) { place(c, depth + 1, ct, sign); ct += subH(c) + GAP_SIB; }
    }
  };
  const rootM = measureNode(root);
  root._x = -rootM.w / 2;
  root._y = 0;
  let top = -stackH(right) / 2;
  for (const n of right) { place(n, 1, top, 1); top += subH(n) + GAP_SIB; }
  top = -stackH(left) / 2;
  for (const n of left) { place(n, 1, top, -1); top += subH(n) + GAP_SIB; }
}

function el(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

let rootG = null;
let panning = false; // 本轮按下是否已发生拖拽（区分节点点击与平移）

function draw() {
  if (!state.root) return;
  layout(state.root);
  svgEl.replaceChildren();
  rootG = el('g', { id: 'om-mm-g' });
  const edges = el('g');
  const nodes = el('g');
  rootG.append(edges, nodes);

  const walkEdge = (n) => {
    for (const c of visibleChildren(n)) {
      const toRight = c._x >= n._x;
      const sx = toRight ? n._x + n._m.w : n._x;
      const ex = toRight ? c._x : c._x + c._m.w;
      const mx = sx + (ex - sx) / 2;
      edges.appendChild(el('path', {
        d: `M ${sx} ${n._y} C ${mx} ${n._y}, ${mx} ${c._y}, ${ex} ${c._y}`,
        fill: 'none',
        stroke: c.depth === 1 ? c.color : 'var(--om-mm-edge, #b9b9c6)',
        'stroke-width': c.depth === 1 ? 1.8 : 1.2,
        'stroke-linecap': 'round',
      }));
      walkEdge(c);
    }
  };
  walkEdge(state.root);

  const walkNode = (n) => {
    const g = el('g', {
      class: 'om-mm-node' + (n.depth === 0 ? ' om-mm-root' : n.depth === 1 ? ' om-mm-branch' : ''),
      transform: `translate(${Math.round(n._x)} ${Math.round(n._y - n._m.h / 2)})`,
    });
    if (n.children?.length) {
      g.classList.add('om-mm-foldable');
      g.dataset.folded = state.folded.has(n.id) ? '1' : '0';
      const tip = el('title');
      tip.textContent = state.folded.has(n.id) ? '展开子节点' : '折叠子节点';
      g.appendChild(tip);
    }
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const bg = n.depth === 0 ? ROOT_BG : dark ? '#26272c' : '#fff';
    g.appendChild(el('rect', {
      width: n._m.w, height: n._m.h, rx: n.depth <= 1 ? 9 : 7,
      fill: bg, stroke: n.depth === 0 ? ROOT_BG : n.color, 'stroke-width': n.depth <= 1 ? 1.6 : 1,
    }));
    const text = el('text', { x: PAD_X, y: PAD_Y + 14 });
    n._m.lines.forEach((line, i) => {
      const ts = el('tspan', { x: PAD_X, y: PAD_Y + 14 + i * LINE_H, ...(line.isRef ? { class: 'om-mm-ref' } : {}) });
      ts.textContent = line.text;
      text.appendChild(ts);
      if (line.refW) { // 出处角标与主体同行：紧接其后（无 x/y，承接前一个 tspan）
        const rs = el('tspan', { dx: 4, class: 'om-mm-ref' });
        rs.textContent = n._m.ref;
        text.appendChild(rs);
      }
    });
    g.appendChild(text);
    // 折叠时外侧贴子节点数徽标（直接子节点数）
    if (n.children?.length && state.folded.has(n.id)) {
      const total = n.children.length;
      const bx = n._m.w + 8;
      const badge = el('g', { transform: `translate(${bx} ${n._m.h / 2})` });
      badge.appendChild(el('circle', { r: 9, fill: n.color }));
      const bt = el('text', { 'text-anchor': 'middle', y: 4, style: 'fill:#fff;font-size:11px;font-weight:600' });
      bt.textContent = String(total);
      badge.appendChild(bt);
      g.appendChild(badge);
    }
    g.addEventListener('pointerdown', (e) => e.stopPropagation());
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.detail >= 2) return; // 双击的第二次点击是改名意图，不触发折叠闪动
      if (panning || !n.children?.length) return;
      if (state.folded.has(n.id)) state.folded.delete(n.id);
      else state.folded.add(n.id);
      draw();
    });
    g.addEventListener('dblclick', (e) => { e.stopPropagation(); openRename(n, g); });
    nodes.appendChild(g);
    for (const c of visibleChildren(n)) walkNode(c);
  };
  walkNode(state.root);

  svgEl.appendChild(rootG);
  applyView();
  syncButtons();
}

// ---------- 双击节点就地改名（HTML 浮层按节点当前屏幕矩形摆放） ----------
let renameBox = null;
function closeRename(commitVal) {
  const box = renameBox;
  renameBox = null;
  if (!box) return null;
  const node = box._node;
  const val = commitVal === undefined ? null : String(commitVal || '').trim();
  box.remove();
  if (node && val && val !== node.label) {
    node.label = val;
    node._m = null; // 重新量宽
    draw();
    setStatus(`已改名 · 共 ${countNodes(state.root)} 节点`);
    saveMap(); // 原位更新（savedId 有值时）
  }
  return val;
}
function openRename(n, nodeG) {
  closeRename();
  const r = nodeG.getBoundingClientRect();
  renameBox = document.createElement('div');
  renameBox.id = 'om-mm-rename';
  renameBox._node = n;
  renameBox.style.left = `${Math.round(r.left)}px`;
  renameBox.style.top = `${Math.round(r.top)}px`;
  const inp = document.createElement('input');
  inp.value = n.label;
  inp.style.width = `${Math.max(90, Math.round(r.width))}px`;
  inp.style.fontSize = `${Math.max(11, Math.round((n.depth === 0 ? 14 : 13) * view.k))}px`;
  let done = false;
  const finish = (commitVal) => {
    if (done) return;
    done = true;
    if (commitVal === null) closeRename(); // 取消
    else closeRename(commitVal);
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(inp.value);
    else if (e.key === 'Escape') finish(null);
  });
  inp.addEventListener('blur', () => finish(inp.value));
  renameBox.appendChild(inp);
  document.body.appendChild(renameBox);
  inp.focus();
  inp.select();
}

function applyView() {
  rootG?.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.k})`);
}

function fitView() {
  if (!state.root || !rootG) return;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  const walk = (n) => {
    minX = Math.min(minX, n._x);
    maxX = Math.max(maxX, n._x + n._m.w);
    minY = Math.min(minY, n._y - n._m.h / 2);
    maxY = Math.max(maxY, n._y + n._m.h / 2);
    visibleChildren(n).forEach(walk);
  };
  walk(state.root);
  const vw = svgEl.clientWidth || 800;
  const vh = svgEl.clientHeight || 600;
  const k = Math.min((vw - 60) / (maxX - minX), (vh - 60) / (maxY - minY), 1.4);
  view.k = Math.max(0.1, k);
  view.tx = vw / 2 - view.k * (minX + maxX) / 2;
  view.ty = vh / 2 - view.k * (minY + maxY) / 2;
  applyView();
}

// 画布平移（拖拽）与缩放（滚轮，光标为锚点）
let panPt = null;
svgEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  panPt = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  panning = false;
  try { svgEl.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针时忽略 */ }
});
svgEl.addEventListener('pointermove', (e) => {
  if (!panPt) return;
  const dx = e.clientX - panPt.x;
  const dy = e.clientY - panPt.y;
  if (!panning && Math.hypot(dx, dy) > 4) {
    panning = true;
    svgEl.classList.add('om-mm-panning');
  }
  if (!panning) return;
  view.tx = panPt.tx + dx;
  view.ty = panPt.ty + dy;
  applyView();
});
const endPan = () => { panPt = null; panning = false; svgEl.classList.remove('om-mm-panning'); };
svgEl.addEventListener('pointerup', endPan);
svgEl.addEventListener('pointercancel', endPan);
svgEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k2 = Math.min(2.5, Math.max(0.1, view.k * Math.exp(-e.deltaY * 0.0016)));
  const r = svgEl.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  view.tx = cx - (cx - view.tx) * (k2 / view.k);
  view.ty = cy - (cy - view.ty) * (k2 / view.k);
  view.k = k2;
  applyView();
}, { passive: false });

// ---------- 状态切换 ----------
function setStatus(text, isErr = false) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('om-mm-err', isErr);
}

// 顶栏按钮可见性：「素材 / 重新生成 / 双模式切换」只在页面模式出现，「编辑大纲」
// 有图即可用；生成中一律让位给「停止」。双模式切换：正在看的模式高亮（primary）
// 且禁用，另一颗点击 = 打开旧图（零调用）或显式生成。
function syncButtons() {
  matBtn.hidden = !state.draftKey;
  matBtn.textContent = state.matCount ? `素材（${state.matCount}）` : '素材';
  regenBtn.hidden = !(state.draftKey && state.root && !state.running);
  editBtn.hidden = !(state.root && !state.running);
  backBtn.hidden = !(state.backId && !state.running);
  modeMatBtn.hidden = modeFullBtn.hidden = !(state.draftKey && !state.running);
  modeMatBtn.disabled = !!state.root && state.genMode === 'material';
  modeFullBtn.disabled = !!state.root && state.genMode === 'full';
  modeMatBtn.classList.toggle('om-mm-primary', modeMatBtn.disabled);
  modeFullBtn.classList.toggle('om-mm-primary', modeFullBtn.disabled);
}

function showInput(msg) {
  state.running = false;
  stopBtn.hidden = true;
  editorView.hidden = true;
  inputView.hidden = false;
  svgEl.toggleAttribute('hidden', true); // svg 是 SVGElement，没有 hidden IDL 属性，必须动真属性
  if (msg) {
    inErr.textContent = msg;
    inErr.hidden = false;
  }
  syncButtons();
  renderMaterial();
  renderHistory();
}

function showMap() {
  inputView.hidden = true;
  editorView.hidden = true;
  svgEl.toggleAttribute('hidden', false);
  expMdBtn.disabled = expMmBtn.disabled = !state.root;
  syncButtons();
}

// 把当前 state.md 解析成树并渲染。返回是否成功。
function renderFromMd() {
  const forest = parseOutline(state.md);
  if (!forest) return false;
  state.root = { label: state.meta.title || '思维导图', children: forest };
  prepTree(state.root);
  showMap();
  draw();
  return true;
}

// 流式期间渐进渲染：节流 250ms，折叠状态清空（树每次都是新的）
let renderTimer = 0;
function scheduleProgressive() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = 0;
    if (state.running) renderFromMd();
  }, 250);
}

// ---------- 生成 ----------
function genError(msg) {
  state.hadError = true;
  if (!state.root) showInput(`生成失败：${msg}`);
  else setStatus(`生成失败：${msg}`, true);
}

async function runGeneration() {
  const settings = await loadSettings();
  // 与 sel-panel 同款：模型与供应商必须一起传（激活供应商缺失时落到首个）
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId) || settings.providers[0];
  if (!provider?.models?.length) {
    showInput('请先在设置页配置 LLM 供应商并保存，再生成思维导图');
    return;
  }
  state.running = true;
  state.hadError = false;
  state.md = '';
  state.root = null;
  state.folded = new Set();
  const seq = ++state.genSeq;
  state.ac = new AbortController();
  stopBtn.hidden = false;
  syncButtons();
  expMdBtn.disabled = expMmBtn.disabled = true;
  setStatus('生成中…');
  showMap();
  try {
    // 双模式：整页正文走 buildMindmapFullPrompt（不依赖高亮素材）；高亮素材 / 手动粘贴
    // 走 buildMindmapPrompt（手动粘贴 jobText 无片段编号，prompt 侧已声明此时不标出处）
    const prompt = state.genMode === 'full'
      ? buildMindmapFullPrompt({ title: state.meta.title, text: state.pageCtx })
      : buildMindmapPrompt({ title: state.meta.title, text: state.pageCtx, highlights: state.jobText });
    await streamChat({
      messages: [{ role: 'user', content: prompt }],
      model: provider.models[0],
      providerId: provider.id,
      signal: state.ac.signal,
      onDelta: (d) => {
        if (d.error) { genError(String(d.error.message || '请求失败')); return; }
        if (d.text) { state.md += d.text; scheduleProgressive(); }
      },
    });
  } catch (e) {
    if (e?.name !== 'AbortError') genError(e.message || String(e));
  }
  if (seq !== state.genSeq) return; // 中途被「新导图」等接管：收尾不覆盖新视图
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
  const stopped = !!state.ac?.signal?.aborted;
  state.running = false;
  stopBtn.hidden = true;
  syncButtons();
  if (state.hadError) return; // genError 已展示
  if (renderFromMd()) {
    setStatus(`完成 · ${countNodes(state.root)} 节点${stopped ? '（已停止，保留已生成部分）' : ''}`);
    fitView();
    saveMap();
  } else {
    setStatus(stopped ? '已停止（尚未生成有效大纲）' : '没有收到可整理的大纲，可重试', !stopped);
    if (!state.root) showInput(stopped ? '已停止：尚未生成有效大纲' : '没有收到可整理的大纲，请检查供应商配置后重试');
  }
}

// ---------- 持久化与历史 ----------
// 生成完成存档。素材页（draftKey 非空）在历史里原位更新：同页同模式导图各一份
// （mode: material/full），记录当时的素材/正文指纹（sig），查看页据此判断
// 「内容没变 → 直接看旧图」。
async function saveMap() {
  if (!state.root || !state.md.trim()) return;
  const o = await chrome.storage.local.get(HISTORY_KEY);
  const list = o[HISTORY_KEY] || [];
  const old = state.savedId ? list.find((r) => r.id === state.savedId) : null;
  const rec = {
    ...(old || {}),
    id: old?.id || `mm:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: state.meta.title || old?.title || '未命名导图',
    url: state.meta.url || old?.url || '',
    key: state.draftKey || old?.key || '',
    mode: state.genMode === 'full' ? 'full' : 'material', // 老记录无此字段按 material 认领
    sig: state.draftSig || old?.sig || '',
    md: outlineToMarkdown(state.root), // 存规范化的 markdown（解析树重排后稳定）
    nodes: countNodes(state.root),
    at: Date.now(),
  };
  const next = old ? list.map((r) => (r.id === old.id ? rec : r)) : [rec, ...list].slice(0, HISTORY_MAX);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  state.savedId = rec.id;
}

async function openSaved(id) {
  const o = await chrome.storage.local.get(HISTORY_KEY);
  const rec = (o[HISTORY_KEY] || []).find((r) => r.id === id);
  if (!rec) { showInput('要打开的导图不存在（可能已被删除）'); return; }
  await openSavedRecord(rec);
}

async function openSavedRecord(rec, note = '') {
  state.savedId = rec.id; // 重开不重复保存；编辑/重新生成走原位更新
  state.backId = null;    // 直接打开了某张图，「返回导图」退路不再需要
  state.draftKey = rec.key || '';
  state.draftSig = rec.sig || '';
  state.genMode = rec.mode === 'full' ? 'full' : 'material'; // 重新生成沿用该记录的模式
  state.md = rec.md;
  state.meta = { title: rec.title, url: rec.url || '' };
  state.folded = new Set();
  titleEl.textContent = rec.title || '思维导图';
  const forest = parseOutline(rec.md);
  // 存档 markdown 以「# 标题」开头（outlineToMarkdown 回环）：单一顶层节点本身就是根，
  // 直接采用，不再包第二层（否则标题会重复出现一次）
  if (forest?.length === 1) state.root = forest[0];
  else if (forest?.length) state.root = { label: rec.title || '思维导图', children: forest };
  else state.root = null;
  if (state.root) {
    state.meta.title = state.root.label || rec.title;
    titleEl.textContent = state.meta.title;
    prepTree(state.root);
    showMap();
    draw();
    setStatus(`历史导图 · ${countNodes(state.root)} 节点${note}`);
    fitView();
  } else {
    showInput('这份导图的大纲无法解析，可能已损坏');
  }
}

// 同页同模式的历史记录查找（老记录无 key 按 url 兜底、无 mode 按 material 认领）
const findPageRec = (list, key, mode) => (list || [])
  .find((r) => key && (r.key || pageKeyOf(r.url)) === key && (r.mode || 'material') === mode);

// 查看本页导图（工具条「思维导图」钮入口）。只看不生成：有旧图直接渲染（素材/正文
// 有更新只在状态里提示，等用户点「重新生成」）；没有旧图落到输入视图的素材卡，用户
// 点「生成思维导图」/「用整页正文生成」才调 LLM。生成永远显式，高亮增删不触发。
async function openPageView(job) {
  const key = pageKeyOf(job.url);
  state.draftKey = key; // 页面模式：素材卡 / 素材按钮 / 重新生成可见
  state.meta = { title: String(job.title || ''), url: key };
  titleEl.textContent = state.meta.title || '思维导图';
  const o = await chrome.storage.local.get([DRAFT_KEY, HISTORY_KEY]);
  const page = o[DRAFT_KEY]?.[key];
  state.pageCtx = page?.text || '';
  const items = page?.items || [];
  state.matCount = items.length;
  const matRec = findPageRec(o[HISTORY_KEY], key, 'material');
  const fullRec = findPageRec(o[HISTORY_KEY], key, 'full');
  // 默认展示：有高亮素材优先高亮导图（用户的主工作流），素材已清空时看整页导图
  const show = items.length && matRec ? matRec : (fullRec || matRec);
  if (show) {
    let note = '';
    if (show === matRec && items.length && show.sig !== draftSig(items)) note = ` · 素材有更新（${items.length} 段），可点「重新生成」`;
    if (show === fullRec && state.pageCtx && show.sig !== textSig(state.pageCtx)) note = ' · 网页正文有更新，可点「重新生成」';
    await openSavedRecord(show, note);
    // openSavedRecord 会按记录把 draftKey 清掉：保持页面模式
    //（素材 / 重新生成按钮可见，重新生成时会补写 key）
    state.draftKey = key;
    state.matCount = items.length;
    syncButtons();
    return;
  }
  showInput(items.length ? '' : '本页还没有高亮素材：在网页上划词点「高亮」收集素材；也可以直接点「用整页正文生成」，把整篇网页整理成思维导图。');
}

// 用户显式触发的页面生成（素材卡两颗按钮 / 顶栏重新生成）。
// material：按当前高亮素材现取现组装；full：整页正文快照（不需要高亮）。
// 两种模式同页各存一条历史记录，重新生成沿用当前模式。
async function pageGenerate(mode = state.genMode || 'material') {
  const o = await chrome.storage.local.get([DRAFT_KEY, HISTORY_KEY]);
  const page = o[DRAFT_KEY]?.[state.draftKey] || {};
  const items = page.items || [];
  state.pageCtx = page.text || '';
  if (mode === 'full') {
    if (!state.pageCtx.trim()) {
      // 从顶栏「重新生成」进来时可能停在画布视图：切回输入视图让错误能被看见
      showInput();
      matErr.textContent = '还没有本页正文快照：回到网页点工具条的「思维导图」按钮重新打开即可带上';
      matErr.hidden = false;
      return;
    }
    matErr.hidden = true;
    state.genMode = 'full';
    state.jobText = '';
    state.meta.title = page.title || state.meta.title || '';
    state.draftSig = textSig(state.pageCtx);
    state.savedId = findPageRec(o[HISTORY_KEY], state.draftKey, 'full')?.id ?? null;
  } else {
    if (!items.length) {
      showInput();
      matErr.textContent = '本页还没有高亮素材：先去网页划词点「高亮」，或改用「用整页正文生成」';
      matErr.hidden = false;
      return;
    }
    matErr.hidden = true;
    state.genMode = 'material';
    state.jobText = assembleDraftText(items, MINDMAP_MAX_CHARS);
    state.meta.title = page.title || state.meta.title || '';
    state.draftSig = draftSig(items);
    state.savedId = findPageRec(o[HISTORY_KEY], state.draftKey, 'material')?.id ?? null;
  }
  state.matCount = items.length;
  titleEl.textContent = state.meta.title || '思维导图';
  await runGeneration();
}

// ---------- 本页高亮素材卡（预览 + 单段删除；生成按钮在卡尾） ----------
async function renderMaterial() {
  const hasPage = !!state.draftKey;
  matCard.hidden = !hasPage;
  if (!hasPage) { state.matCount = 0; return; }
  const o = await chrome.storage.local.get([DRAFT_KEY, HISTORY_KEY]);
  const page = o[DRAFT_KEY]?.[state.draftKey];
  const items = page?.items || [];
  state.pageCtx = page?.text || '';
  state.matCount = items.length;
  if (items.length) matErr.hidden = true;
  const rec = findPageRec(o[HISTORY_KEY], state.draftKey, 'material');
  matList.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'om-mm-empty';
    li.textContent = '还没有高亮素材：去网页上划词，点工具条的「高亮」按钮即可收集';
    matList.appendChild(li);
  } else {
    for (const it of items) {
      const li = document.createElement('li');
      const txt = document.createElement('span');
      txt.className = 'om-mm-m-text';
      txt.textContent = it.text;
      txt.title = it.text;
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = '删除这段素材';
      del.addEventListener('click', () => removeMaterialItem(it.id));
      li.append(txt, del);
      matList.appendChild(li);
    }
  }
  matRun.disabled = !items.length;
  matRun.textContent = rec ? '重新生成（用当前素材）' : '生成思维导图';
  fullRun.disabled = !state.pageCtx.trim();
  const fullRec = findPageRec(o[HISTORY_KEY], state.draftKey, 'full');
  fullRun.textContent = fullRec ? '重新生成（用整页正文）' : '用整页正文生成';
  fullRun.title = '不看高亮，把整篇网页正文整理成思维导图（与本页高亮导图分开保存）';
  const stale = rec && rec.sig !== draftSig(items);
  matHint.textContent = `${stale ? '高亮素材较上次生成有更新。' : ''}高亮素材是重点：LLM 结合网页正文理解，按原文结构把下列片段归纳成图（不逐段硬拆）；可先删除不需要的段落。没有高亮时用整页正文生成也可以。`;
  syncButtons();
}

async function removeMaterialItem(id) {
  const o = await chrome.storage.local.get(DRAFT_KEY);
  const all = o[DRAFT_KEY] || {};
  const page = all[state.draftKey];
  if (!page) return;
  page.items = (page.items || []).filter((it) => it.id !== id);
  if (page.items.length) all[state.draftKey] = page;
  else delete all[state.draftKey]; // 清空即删条目
  await chrome.storage.local.set({ [DRAFT_KEY]: all });
  renderMaterial();
}

async function renderHistory() {
  const o = await chrome.storage.local.get(HISTORY_KEY);
  const list = o[HISTORY_KEY] || [];
  historyEl.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'om-mm-empty';
    li.textContent = '还没有生成过思维导图';
    historyEl.appendChild(li);
    return;
  }
  for (const rec of list) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'om-mm-h-name';
    name.textContent = rec.title || '未命名导图';
    name.title = rec.url || rec.title || '';
    const meta = document.createElement('span');
    meta.className = 'om-mm-h-meta';
    // 页面导图带模式标签（高亮素材 / 整页），手动粘贴的独立导图不带
    const modeTag = rec.key ? (rec.mode === 'full' ? '整页 · ' : '高亮 · ') : '';
    meta.textContent = `${rec.nodes ?? '?'} 节点 · ${modeTag}${new Date(rec.at).toLocaleString()}`;
    const open = document.createElement('button');
    open.textContent = '打开';
    open.addEventListener('click', () => openSaved(rec.id));
    const del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      const o2 = await chrome.storage.local.get(HISTORY_KEY);
      await chrome.storage.local.set({ [HISTORY_KEY]: (o2[HISTORY_KEY] || []).filter((r) => r.id !== rec.id) });
      renderHistory();
    });
    li.append(name, meta, open, del);
    historyEl.appendChild(li);
  }
}

// ---------- 编辑大纲视图（markdown 文本往返：outlineToMarkdown ↔ parseOutline） ----------
function showEditor() {
  if (!state.root) return;
  closeRename();
  inputView.hidden = true;
  svgEl.toggleAttribute('hidden', true);
  editorView.hidden = false;
  edErr.hidden = true;
  edText.value = outlineToMarkdown(state.root).replace(/\n$/, '');
  edText.focus();
}

edApply.addEventListener('click', () => {
  const forest = parseOutline(edText.value);
  if (!forest?.length) {
    edErr.textContent = '没解析出有效大纲：至少要有一个「- 」列表条目（首行「# 」是中心标题）';
    edErr.hidden = false;
    return;
  }
  edErr.hidden = true;
  // 单一顶层节点（「# 标题」存档回环形态）本身就是根；多个顶层包一层中心节点
  state.root = forest.length === 1 ? forest[0] : { label: state.meta.title || '思维导图', children: forest };
  state.meta.title = state.root.label || state.meta.title;
  titleEl.textContent = state.meta.title;
  state.md = outlineToMarkdown(state.root);
  state.folded = new Set();
  prepTree(state.root);
  editorView.hidden = true;
  showMap();
  draw();
  fitView();
  setStatus(`已编辑 · 共 ${countNodes(state.root)} 节点`);
  saveMap(); // 原位更新（savedId 有值时）
});
edCancel.addEventListener('click', () => {
  editorView.hidden = true;
  if (state.root) { showMap(); draw(); }
  else showInput();
});

// ---------- 导出 ----------
function fileBase() {
  const base = (state.meta.title || 'mindmap')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 60);
  return base || 'mindmap';
}

function download(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

expMdBtn.addEventListener('click', () => {
  if (state.root) download(`${fileBase()}.md`, outlineToMarkdown(state.root), 'text/markdown;charset=utf-8');
});
expMmBtn.addEventListener('click', () => {
  if (state.root) download(`${fileBase()}.mm`, outlineToFreemind(state.root), 'application/x-freemind;charset=utf-8');
});

// ---------- 顶栏按钮 ----------
stopBtn.addEventListener('click', () => state.ac?.abort());
fitBtn.addEventListener('click', fitView);
regenBtn.addEventListener('click', () => { if (!state.running) pageGenerate(); }); // 默认沿用当前模式
matBtn.addEventListener('click', () => { closeRename(); showInput(); });
backBtn.addEventListener('click', async () => {
  if (!state.backId || state.running) return;
  const id = state.backId;
  state.backId = null;
  await openSaved(id); // 记录已不存在时 openSaved 自带提示
});

// 顶栏双模式切换（页面模式）：目标模式有旧图直接打开（零 LLM 调用），没有就显式
// 生成（pageGenerate 同一套 prompt 与原位更新）。打开旧图后补齐素材页上下文
//（正文快照 / 素材角标），「重新生成」与素材卡状态才对得上。
async function switchPageMode(mode) {
  if (!state.draftKey || state.running) return;
  if (state.root && state.genMode === mode) return; // 已在该模式的图上
  const o = await chrome.storage.local.get(HISTORY_KEY);
  const rec = findPageRec(o[HISTORY_KEY], state.draftKey, mode);
  if (rec) {
    await openSavedRecord(rec);
    const d = await chrome.storage.local.get(DRAFT_KEY);
    const page = d[DRAFT_KEY]?.[state.draftKey];
    state.pageCtx = page?.text || '';
    state.matCount = (page?.items || []).length;
    syncButtons();
  } else {
    await pageGenerate(mode);
  }
}
modeMatBtn.addEventListener('click', () => switchPageMode('material'));
modeFullBtn.addEventListener('click', () => switchPageMode('full'));
editBtn.addEventListener('click', showEditor);
matRun.addEventListener('click', () => { if (!state.running) pageGenerate('material'); });
fullRun.addEventListener('click', () => { if (!state.running) pageGenerate('full'); });
foldBtn.addEventListener('click', () => {
  if (!state.root) return;
  (state.root.children || []).forEach((c) => c.children?.length && state.folded.add(c.id));
  draw();
});
unfoldBtn.addEventListener('click', () => {
  if (!state.root) return;
  state.folded = new Set();
  draw();
});
newBtn.addEventListener('click', () => {
  state.ac?.abort();
  state.genSeq++; // 旧生成轮收尾时不再覆盖界面
  closeRename();
  state.backId = state.savedId; // 「‹ 返回导图」一键回到刚才那张（没有则不亮）
  state.root = null;
  state.md = '';
  state.savedId = null;
  state.draftKey = '';
  state.draftSig = '';
  state.genMode = 'material';
  state.matCount = 0;
  state.pageCtx = '';
  state.meta = { title: '', url: '' };
  titleEl.textContent = '思维导图';
  setStatus('');
  showInput();
});

// ---------- 手动输入生成（与素材库无关，存成独立导图） ----------
inRun.addEventListener('click', async () => {
  const text = inText.value.trim();
  if (!text) { inErr.textContent = '请先输入要整理的内容'; inErr.hidden = false; return; }
  inErr.hidden = true;
  state.jobText = text.slice(0, MINDMAP_MAX_CHARS);
  state.pageCtx = ''; // 手动生成不带网页上下文
  state.meta = { title: inTitle.value.trim() || '', url: '' };
  state.savedId = null;
  state.draftKey = '';
  state.draftSig = '';
  state.genMode = 'material'; // 手动粘贴与高亮素材共用 prompt（无片段编号，不标出处）
  titleEl.textContent = state.meta.title || '思维导图';
  await runGeneration();
});

// ---------- 启动：#job=<查看本页任务> / #id=<历史导图> / 空白输入视图 ----------
(async function init() {
  const params = new URLSearchParams(location.hash.slice(1));
  const jobId = params.get('job');
  const savedId = params.get('id');
  if (jobId) {
    const key = `omMindmapJob:${jobId}`;
    const o = await chrome.storage.session.get(key);
    const job = o[key];
    await chrome.storage.session.remove(key); // 一次性消费
    history.replaceState(null, '', location.pathname);
    if (job?.view) {
      await openPageView(job);
      return;
    }
    showInput('任务已过期（session 不跨浏览器重启），请回网页重新打开本页导图，或在下面粘贴内容');
    return;
  }
  if (savedId) {
    history.replaceState(null, '', location.pathname);
    await openSaved(decodeURIComponent(savedId));
    return;
  }
  showInput();
})();
