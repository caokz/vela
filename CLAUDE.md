# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目构成

一个仓库两个独立交付物：

- **扩展本体**：Chrome MV3 扩展（`manifest.json` 在仓库根）。零构建、零第三方依赖，纯 ES module 由 Chrome 直加载。功能：聊天（原生侧边栏 / 独立聊天页 / 页内聊天卡）、网页总结、整页翻译、划词动作。
- **bridge/**：Node ≥18 伴生进程，独立 npm 项目（依赖 `ws` + `@anthropic-ai/claude-agent-sdk`）。WS 服务监听 `127.0.0.1:39217`，把本机 Claude Code CLI 经 Agent SDK 暴露给扩展页。不进扩展包，单独分发。

设计文档是权威参考，改协议或架构前先读：`docs/DESIGN.md`（扩展架构 / 数据模型 / 翻译协议 / 并发一致性）、`docs/agent-bridge.md`（WS 协议全部 op、归一化事件词汇表、bridge 模块职责）。

## 常用命令

扩展无构建步骤：`chrome://extensions` 开发者模式加载仓库根目录，改代码后在扩展页点「重新加载」。

```bash
# bridge 启动（首次先 npm install）
cd /d E:\code\vela\bridge && node index.js    # 或双击 bridge\start.bat；--port 可改端口

# bridge 测试（都在 bridge/ 目录下跑）
npm test                    # = node turn.test.js，hub 纯逻辑自测
node smoke.js               # 协议冒烟：进程内起 server + ws 客户端走关键 op（需先 npm i）
node claude-options.test.js
node live-check.js          # 真实 claude turn，产生真实调用，不进 CI

# 扩展全量自动化测试（仓库根）：单元 → 打包 → 浏览器 e2e，串行；需要 bridge 的项自动拉起
node scripts/test-all.mjs              # 离线全量（LLM 走本地 mock，不产生真实调用）
node scripts/test-all.mjs --network    # 追加真实网页车道；--real-llm 追加真实供应商/agent 调用
node scripts/test-all.mjs --only=llm   # 按名称过滤
node scripts/test-kb-unit.mjs          # 本机知识库 / 文件工具单元（内存假文件系统）
node --experimental-vm-modules scripts/check-syntax.mjs  # 全部 ES module 语法检查
node scripts/test-llm-unit.mjs         # LLM 适配器 / 路由 / 工具循环单元（node:test，无浏览器）

# 打包
node scripts/package.mjs         # → dist/vela-<manifest 版本>.zip（白名单：manifest.json/src/assets）
node scripts/package-bridge.mjs  # → dist/vela-bridge-<版本>.zip

# 辅助
node scripts/restart-bridge.mjs  # 杀 39217 监听进程并隐藏窗口重启 bridge
node scripts/make-icons.mjs      # 图标生成（零依赖 PNG 编码）
```

`scripts/verify-*.mjs` 是 e2e / 诊断脚本，用本机 Playwright Chromium 驱动真实浏览器（`scripts/lib/chrome.mjs` 自动挑 `%LOCALAPPDATA%\ms-playwright` 下最新的 chromium-*，`VELA_CHROME` 可覆盖；品牌版 Chrome 137+ 已禁用 `--load-extension`）。新写的 e2e 用 `scripts/lib/cdp.mjs`（拉起浏览器 / 连 target / 真实鼠标）与 `scripts/lib/mock-llm.mjs`（OpenAI + Anthropic 双协议 SSE mock，含工具调用）。真供应商类脚本先跑 `node scripts/tmp-extract-llm.mjs`（从已安装扩展的 LevelDB 提取 llmSettings 到 `%TEMP%/vela-llm-settings.json`，key 不落日志）。

## 架构

### MV3 生命周期约束（决定所有网络代码的落点）

- 流式 fetch 一律在扩展页（sidepanel / chatpage / 聊天卡 iframe）执行，不进 service worker——MV3 SW 空闲约 30 秒回收，挂起的流式响应不可靠。
- `src/background/service-worker.js` 只做路由：右键菜单组、pendingTask 中转、浮窗注册、快捷键，不做任何网络请求。
- 页面功能编排（`src/page/page-actions.js`）也在扩展页：翻译是长任务（多批次 × 流式），同样不能进 SW。
- pendingTask 管线：SW 把动作（quick-action / page-summary / translate-page）写 `storage.session.pendingTask`，聊天卡 / 面板监听 `storage.session.onChanged` 消费执行。

### 视图与数据模型

- 三个页面：`src/sidepanel/sidepanel.html`（原生侧边栏与页内聊天卡 iframe 复用同一文档）、`src/chatpage/`、`src/options/`。
- 侧边栏与聊天页同构：`shell.js`（DOM 骨架）+ `chat-ui.js`（交互与编排，最大文件），差异经 variant（panel/wide）区分。
- 数据全在 `chrome.storage.local`：`llmSettings`（供应商、翻译参数、quickActions、agentBridge 配置）与 `conversations`。ID 客户端生成（`conv:` / `msg:` 前缀），消息树靠 `parentItemId` 串联。
- 多视图会话同步：各视图持有内存 conversations，经 `storage.onChanged`（200ms 防抖、内容比对去自写）互相刷新。

### 双引擎聊天（engine 是会话级字段；顶栏 `#om-engine` 切换：Agent / LLM 问答 / LLM 任务）

- `engine:'llm'`：`streamChat`（`src/llm/store.js`）→ `openai.js` / `anthropic.js` 两协议 SSE 适配器，UI 只见归一化增量 `{text, finished, error, toolCalls?}`（每次请求 finished 只发一次）；`sse.js` 共用分帧解析。`tasks.js` 是总结 / 翻译 prompt 构建纯函数。会话记 `llmProviderId`/`llmModel`，发送时按 providerId 精确路由（不传则用激活供应商，翻译等页面功能走这条）。
- `llmMode:'tools'`（LLM 任务）：`tool-loop.js` 纯逻辑工具循环（参数校验、审批、步数上限、取消），`browser-tools.js` 7 个浏览器工具（读当前页 / 选中 / 标签页、联网读取、开标签、下载；后三个先弹审批卡）。事件复用 agent 归一化词汇，步骤存 `answer.meta.tools.steps`，与 agent 步骤同款渲染。
- 聊天卡的网页上下文（`conv.pageCtx`）跟随宿主页：加载时与同标签页 SPA 换页时 widget 回传正文，`reconcileHostCtx`（chat-ui.js）空会话原地换、有消息的会话新建对话；`pendingTask` 只由可见实例消费。细节见 `docs/DESIGN.md`。
- 知识库（会话级，三种引擎共用一个入口）：除 bridge 类条目（上传 / 本机路径，仅 Agent）外，新增 `kind:'handle'`——浏览器 File System Access 授权的本机文件夹 / 文件，句柄存 IndexedDB（`src/kb/store.js`，chrome.storage 存不了句柄），会话只记 `{id, name, handleKind, wsPath}`。发送时在用户手势内补授权（浏览器重启后会回到「询问」）。LLM 任务经 `src/llm/fs-tools.js` 读写（list / search / read / write / edit / load_skill，写入先弹 diff 审批）；LLM 问答把授权的单个文件附进 system；Agent 发送前由 `src/kb/sync.js` 增量上传到工作区 `wsPath`（bridge `upload.begin` 的 `overwrite`）。`src/kb/files.js` 按格式读取：文本带行号（UTF-8 失败退 GBK）、docx/xlsx/pptx 经 `zip.js` + `office.js` 转 Markdown、PDF / 图片作为工具结果附件交给模型原生读取。说明型 skill 放在知识库目录 `.vela/skills/<名>/SKILL.md`（只支持文档，MV3 禁止执行外部脚本）。
- LLM 引擎的知识库也能用 bridge 路径（`kind:'local'`）：聊天卡里浏览器弹不了文件选择框，`src/kb/bridge-fs.js` 把 bridge `fs.*` 包成与 File System Access 同形的虚拟句柄，`fs-tools.js` 共用；bridge `fs.read` / `fs.list{hidden,stat}` / `fs.check{size,mtimeMs}` 是为此新增（bridge 0.4.2）。
- `search_files` 先遍历全树再并发读内容，结果末尾必须说明没搜全的原因；不要把遍历 / 读取上限改回静默截断（会让模型误判「知识库里没有」）。`node scripts/test-search-unit.mjs` 覆盖。
- `engine:'agent'`（新会话默认；顶栏切换后的选择记入 `llmSettings.chat.defaultEngine`）：`src/agent/client.js` 单例 WS 客户端（重连退避、seq 缺口补帧、768KiB 分块上传）→ bridge → Claude Agent SDK。`render.js` 纯函数把归一化事件折叠成渲染状态（离线可从 `answer.meta.agent` 重放）；`compose.js` 纯函数组装 prompt（知识库 / 附件以工作区相对路径附加）。

### bridge 内部链路

`index.js`（启动 / 端口 / 单实例锁）→ `server.js`（token 自动配对、Origin 必须以 `chrome-extension://` 开头、id 配对请求 / 响应、分发 `upload.*`）→ `workspace.js`（工作区 `baseDir/<workspaceId>` 解析 + 分块上传状态机）→ `turn.js`（会话 hub：seq、500 帧环形缓冲、权限请求 / 应答）→ `agents/claude.js`（SDK 适配器，把 SDK 消息流归一化为事件）。新增 agent 只加 `bridge/agents/` 适配器，协议不动。

事件帧 `{type:'event', sessionId, seq, event}`；事件 kind 词汇表（`message_chunk` / `thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `permission_request` / `session_info` / `usage` / `turn_end`）见 `docs/agent-bridge.md`。未知 kind 丢弃不报错——CLI 迭代快，容错优先。

### 页面功能层

- `src/content/widget.js` + `selection-popup.js`：常驻浮窗与划词工具条，经 `scripting.registerContentScripts` 注册（http/https，persistAcrossSessions）。
- `src/content/bridge.js`：翻译回填 + 浮球 + SPA 守卫，按需 files 注入（IIFE，禁 import）。
- `src/content/injected.js`：自包含正文提取函数（executeScript func 注入，ISOLATED world）。
- 翻译协议走 Port `'om-tx'`（`om:tx_start` / `om:tx_need` / `om:tx_batch` …），视口驱动：IntersectionObserver 上报进视口的块，编排页分批流式翻译后回填，滚动续译。编排页在扩展页或隐藏 runner iframe（`src/page/tx-runner.html`）。

## 约定与红线

- **命名前缀 `om-` / `om:`**：DOM id/class、runtime 消息类型、storage 键、菜单 id 全用（历史沿用，别引入新前缀）。
- **零依赖**：扩展 `src/` 只用 chrome.\* API，不引入 npm 包；`bridge/` 是唯一 npm 项目。不引入打包器 / 转译器，代码直加载。
- 注释与 UI 文案用中文，标识符用英文。
- **流式持久化模型**：内存 `localContent` 是权威值，写入经 promise 链串行化、全量覆盖，500ms 节流；流式期间锁定会话切换。改持久化逻辑时保持这套模型，防读-改-写交错丢字。
- **上传路径双侧清洗**：扩展侧 `sanitizeName`（chat-ui.js）+ bridge 侧 `sanitizeRelPath`（workspace.js），落盘约束在工作区内。
- bridge 只绑 `127.0.0.1`，不转发到外网；token 首次握手自动配对，无手工配置环节。
- **注册式内容脚本的坑**：persistAcrossSessions 注册在扩展重载后仍用缓存旧脚本注入，`onInstalled` 里每次 `updateContentScripts` 强制按磁盘文件重读——改浮窗代码后必须重新加载扩展才在页面生效。
- Windows 环境：cmd 的 `cd` 跨盘符必须带 `/d`；`.bat` / `.vbs` 里不要写中文注释（按 ANSI 解析 UTF-8 中文会语法错乱）。
- 版本各自独立：`manifest.json` 的 version 驱动扩展包名与打包产物，`bridge/package.json` 单独维护。
