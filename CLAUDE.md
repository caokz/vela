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

# 打包
node scripts/package.mjs         # → dist/vela-<manifest 版本>.zip（白名单：manifest.json/src/assets）
node scripts/package-bridge.mjs  # → dist/vela-bridge-<版本>.zip

# 辅助
node scripts/restart-bridge.mjs  # 杀 39217 监听进程并隐藏窗口重启 bridge
node scripts/make-icons.mjs      # 图标生成（零依赖 PNG 编码）
```

`scripts/verify-*.mjs` 是一次性 e2e / 诊断脚本，用本机 Playwright Chromium（`%LOCALAPPDATA%\ms-playwright\chromium-1208`）驱动真实浏览器。真供应商类脚本先跑 `node scripts/tmp-extract-llm.mjs`（从已安装扩展的 LevelDB 提取 llmSettings 到 `%TEMP%/vela-llm-settings.json`，key 不落日志）。

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

### 双引擎聊天（engine 是会话级字段，不设全局切换）

- `engine:'llm'`：`streamChat`（`src/llm/store.js`）→ `openai.js` / `anthropic.js` 两协议 SSE 适配器，UI 只见归一化增量 `{text, finished, error}`；`sse.js` 共用分帧解析。`tasks.js` 是总结 / 翻译 prompt 构建纯函数。
- `engine:'agent'`（新会话默认）：`src/agent/client.js` 单例 WS 客户端（重连退避、seq 缺口补帧、768KiB 分块上传）→ bridge → Claude Agent SDK。`render.js` 纯函数把归一化事件折叠成渲染状态（离线可从 `answer.meta.agent` 重放）；`compose.js` 纯函数组装 prompt（知识库 / 附件以工作区相对路径附加）。

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
