# 本地 Agent 桥接设计

目标版本：0.5.0。状态：B1 已实现——bridge 全链路（server/turn/token/claude 适配器）+ 扩展侧（client/render/引擎切换/事件渲染）+ 设置页 Agent 区；0.5.0 在协议上追加会话工作区（`cwdBase`/`workspaceId`）与分块上传（`upload.*`），并修复 resume 后 bridge 会话 id 丢失、`agentSessionId` 存错两个 bug；`bridge/turn.test.js`、`bridge/smoke.js`、`bridge/live-check.js`（真机 turn）全部通过。与设计的偏差：单实例锁用端口占用即退出实现；Origin 校验放宽为 `chrome-extension://` 前缀（不锁单扩展 id）。参考实现：Orca（`src/main/claude`、`src/main/codex`、`src/main/acp`）。

## 需求概述

聊天框从"直连 LLM 的输入输出框"升级为本地 agent 的前端：

1. 自动检测本机的 claude code / codex，用户按会话选择 agent；对话与工作流全部由 agent 执行，不再单独配 LLM key（复用 agent 自身登录态）。后续可扩展更多 agent。
2. 会话可绑定本地一个或多个目录作为 agent 上下文。
3. 会话可设置工作目录；会话可保存并恢复（agent 侧 resume + 本地 transcript 回放）。

硬约束：Chrome 扩展不能启动本地进程、不能枚举本地目录。必须新增一个本地伴生进程（bridge），扩展经 WebSocket 与它通信。这是本设计唯一的新架构件，其余是接线。

保留约束：直连 LLM 模式不删除。agent 模式要求装 CLI + bridge 常驻，轻量问答场景直连更合适。两种引擎做成会话级开关，共存于同一会话列表。

## 总体架构

```
chrome 扩展                                  本机
┌─────────────────────────────┐
│ 聊天卡 / 侧边栏 / 独立聊天页    │          ┌──────────────────────────────┐
│  ├─ llm/store.js  直连（不动） │          │ bridge（Node 进程，repo 内     │
│  └─ agent/client.js ─────────┼──WS──────▶ bridge/ npm 项目，非零依赖）   │
│     WS 客户端 + 事件渲染       │  127.0.0.1│  ├─ server    WS + token 鉴权 │
│ options 页                    │  :39217   │  ├─ registry  探测 + 适配器表  │
│  └─ bridge/agent 设置区       │           │  ├─ claude    Claude Agent SDK│
└─────────────────────────────┘           │  └─ codex     app-server(B2)  │
                                          └──────────────────────────────┘
SW 职责不变：右键菜单 / pendingTask / 浮窗注册。不碰 WS、不碰 agent。
```

与 Orca 的对应关系与选型依据：

| Orca | 本设计 | 依据 |
|---|---|---|
| Electron main 进程承载 agent 连接 | bridge 进程 | 扩展无 Node 环境等价物 |
| renderer 聊天 UI | 扩展页内聊天卡 / 侧边栏 | 同为纯事件消费者 |
| claude 走 Claude Agent SDK | 同（`@anthropic-ai/claude-agent-sdk`） | 权限审批（`canUseTool`）、resume、控制协议手写是维护坑；Orca 以 contract pin 测试锁 SDK 行为，佐证接口不稳定、不宜裸解析 |
| codex 走 `codex app-server` JSON-RPC | 同（B2） | Orca 的 `codex-app-server-client` 证明这是 codex 的维护接口；`exec --json` 面向一次性任务 |
| 其他 agent 走 ACP，launch spec 即数据 | B3 采纳：加 agent = 加一行适配器描述 | `acp-launch-specs.ts` 的做法 |
| 聊天 UI 只消费归一化 session update | 同，事件词汇直接沿用 ACP | 见"归一化事件" |

ACP 的 `session/new` 自带 `cwd` + `additionalDirectories`，与需求 2/3 一一对应；权限审批走 `session/request_permission`。归一化事件沿用 ACP 词汇，B3 接 ACP agent 时零翻译。

## 模块设计

### bridge/（repo 内 npm 项目）

独立 `package.json`，依赖 `@anthropic-ai/claude-agent-sdk`。扩展本体保持零依赖；bridge 只在本机 `npm i` 一次。

| 文件 | 职责 |
|---|---|
| `bridge/server.js` | 启动：生成/读取 token，绑 `127.0.0.1:39217`（`--port` 可配），单实例锁（端口占用即退出并提示）。每连接：校验 Origin（只放行 `chrome-extension://` 前缀），首条消息必须为 `hello`；token 匹配直接放行，缺失/不匹配自动配对（响应下发当前 token，客户端存下复用）。分发 `upload.*` 到上传管道，每分钟 sweep 闲置上传。 |
| `bridge/workspace.js` | 工作区解析（`baseDir/<workspaceId>`，mkdir recursive）与 `sanitizeRelPath` 清洗；`createUploadManager` 分块上传状态机（begin/chunk/end/cancel/sweep）。与 session 生命周期解耦。 |
| `bridge/registry.js` | 探测：对每个适配器跑其 `probe()`（如 `claude --version`，3s 超时）；返回 `[{id, name, version, authed}]`。`authed` 由适配器判定（claude：`~/.claude` 凭证存在；探测失败归为未安装）。 |
| `bridge/turn.js` | 会话与 turn 状态机：`sessions: Map<sessionId, {agentId, agentSessionId, cwd, contextDirs, busy}>`。spawn 归 bridge 管，记 pid；客户端断开不杀子进程，重连后事件按 `seq` 补发（每会话保留最近 500 条环形缓冲）。 |
| `bridge/agents/claude.js` | claude 适配器，包 Claude Agent SDK 的 `query()`。 |
| `bridge/agents/codex.js` | B2：`codex app-server` JSON-RPC stdio 客户端。实现前以实际 `--help` 与握手抓取一次 schema，不凭记忆写方法名。 |

### 扩展侧

| 文件 | 职责 |
|---|---|
| `src/agent/client.js` | WS 客户端：连接、`hello` 握手、请求/响应配对（id 关联）、事件分发、断线重连（指数退避，封顶 10s）、`seq` 缺口时 `events.replay`。运行在聊天卡/侧边栏/聊天页上下文，SW 不参与。 |
| `src/agent/render.js` | 归一化事件 → 渲染模型：文本增量并入当前消息；`agent_thought_chunk` 进可折叠"思考"；`tool_call`/`tool_call_update` 渲染为步骤行（工具名 + 状态 + 摘要 + 耗时），`parentId` 归组出子智能体折叠；`plan` 渲染为待办列表；`permission.request` 渲染为内联审批卡。 |
| `src/ui/chat-ui.js`（改） | engine=agent 时走 `agent/client.js`，engine=llm 走原 `streamChat`；输入框、会话列表、持久化逻辑共用。composer 左侧附件（回形针/拖放/粘贴）与知识库（书形按钮弹层）入口；每轮 turn 带 `cwdBase`/`workspaceId` 建会话。 |
| `src/agent/compose.js` | 纯函数：知识库 local 条目去重为 `contextDirs`；知识库上传件与本条消息附件以工作区相对路径附加进 prompt。 |
| `src/options/`（改） | 新增"本地 Agent"设置区：bridge URL、"检测 agent"按钮（展示版本/未登录及 `loginCommand` 引导）、默认 agent 选择、工作基础目录（baseDir）。token 首次握手自动配对，界面不出现。 |

manifest 不需要新权限：扩展页连 `ws://127.0.0.1` 不受 MV3 CSP 的 `connect-src` 限制；https 页面里的扩展源 iframe 连 localhost 属安全上下文豁免。

## 接口设计

### WS 协议

客户端 → bridge，请求/响应按 `id` 配对：

```
hello        {token}                                   → {ok, v, bridgeVersion；token 缺失/不匹配时附 token（自动配对）}
agents.list  {}                                        → {agents: [{id, name, version, authed, loginCommand}]}
models.list  {agentId}                                 → {models: [modelId, ...]}
session.new  {agentId, cwdBase, workspaceId, contextDirs[], permissionMode, projectDir, model} → {sessionId, cwd, workspacePath}
session.resume {agentId, agentSessionId, cwdBase, workspaceId, contextDirs[], permissionMode, projectDir, model} → {sessionId, cwd, workspacePath}
session.prompt {sessionId, text}                       → {accepted}（事件走 event 流）
session.cancel {sessionId}                             → {ok}
permission.respond {sessionId, requestId, outcome: 'allow'|'deny'} → {ok}
fs.check     {path}                                    → {exists, isDirectory, size, mtimeMs}
fs.list      {path, hidden?, stat?, limit?}            → {path, parent, entries:[{name,path,isDirectory,size?,mtimeMs?}], truncated}   // 默认过滤点号 / $ 开头；hidden 保留，stat 给文件附 size/mtimeMs；limit 默认 1000（浏览器 UI），封顶 50000（LLM 文件工具用）
fs.read      {path, maxBytes?}                         → {path, size, mtimeMs, b64}（默认上限 30MiB，封顶 64MiB；LLM 任务读知识库里的本机路径）
fs.write     {path | cwdBase+workspaceId+relPath, content} → {path, bytes}（≤10MiB，父目录自动创建，覆盖同名文件）
events.replay {sessionId, fromSeq}                     → {events: [...]}
upload.begin {cwdBase, workspaceId, relPath, overwrite?} → {uploadId, path, name}   // overwrite=true 原名覆盖（默认重名加 “ -2” 后缀）
upload.chunk {uploadId, b64}                           → {bytes}
upload.end   {uploadId}                                → {path, name, bytes}
upload.cancel {uploadId}                               → {ok}（幂等）
workspace.remove {cwdBase, workspaceId}                → {removed}（幂等；删除会话时清工作区）
bridge.shutdown {}                                     → {ok}（回 ok 后关连接并优雅退出进程）
```

- `bridge.shutdown`：设置页「停止 bridge」按钮。服务端先回 ok 响应再关 `wss`/`httpServer` 并退出（100ms 延时保证响应帧发出）；客户端发出后应预期断连，不当作错误。bridge 启动时在 Windows 注册 `vela-bridge://` URL 协议（`HKCU\Software\Classes`，幂等覆盖），设置页「启动」按钮导航 `vela-bridge://launch` 由 `launcher.vbs` 拉起进程（端口已占用时新实例自行退出，幂等）；`VELA_NO_PROTOCOL_REGISTER=1` 跳过注册。

工作区与上传语义（0.5.0）：

- `workspaceId` 存在时，cwd = `expandTilde(cwdBase || ~/.vela-bridge/workspaces)/<workspaceId>`，bridge `mkdirSync recursive` 创建后作为会话 cwd 返回；workspaceId 只放行 `[A-Za-z0-9:_-]{1,128}`，其余报 `bad-workspace`（id 中的 `:` 映射为 `-` 作目录名，Windows 不允许冒号）。无 `workspaceId` 时退回 `params.cwd`，兼容旧客户端。
- `projectDir`（会话绑定的项目目录）存在时覆盖 cwd（`resolve(expandTilde(...))`，不存在或不是目录报 `bad-path`）；工作区照常创建并作为 `workspacePath` 返回（上传/知识库仍落工作区），且自动追加进 `contextDirs`，agent 免审批读取上传件。无绑定时 `workspacePath` 即工作区根。`permissionMode` 会话级覆盖：扩展侧每轮 session.new/resume 带上 `conv.permissionMode || 设置页默认`，切模式无需新会话。
- `contextDirs` 逐条 `expandTilde` 后交给适配器作 `additionalDirectories`。
- `model`（可选字符串，trim 后截 100 字符）透传给适配器：claude-code 适配器非空时作 SDK `query()` 的 `model` 选项，空串用 SDK/CLI 默认模型。扩展侧来源两级：输入框下方的会话级下拉 `conv.model` 优先，回退设置页 agent 卡「模型」全局默认。
- `models.list` 由适配器向自己背后的 LLM 网关拉模型列表（claude-code：`GET {ANTHROPIC_BASE_URL || https://api.anthropic.com}/v1/models?limit=100`，鉴权用 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` 环境变量，8s 超时）。走中转网关时返回网关真实模型（如 glm-* 系列）；官方订阅登录没有 key，接口 401 报错，扩展侧捕获后回退预设别名 opus/sonnet/haiku，聊天不受影响。适配器未实现该方法的返回空列表。
- `upload.*` 与 session 生命周期解耦（知识库上传可能发生在首条消息之前）：`begin` 以 `wx` 独占创建落盘文件，重名自动加 ` -2`/` -3` 后缀（≤100 次，超过报 `file-exists`）；`chunk` 收 base64 块（单文件累计上限 200MB，超限报 `too-large` 并删除半成品）；`end` 落定返回绝对路径、实际落盘名与字节数；闲置 10 分钟的上传由每分钟一次的 sweep 清理。单块建议 ≤1MiB base64（ws maxPayload 100MiB）。
- `fs.list` 供知识库面板浏览本机目录：跳过 `.`/`$` 开头的隐藏与系统项，symlink 按 stat 结果归类，目录优先、字母序排序，超 1000 条截断（`truncated:true`）。Windows 盘根之上无父目录，在盘根额外列出所有存在的盘符作目录项并钉在列表最前（`localeCompare` 把 `:` 当可忽略标点，混排会被埋掉），跨盘浏览不被困在启动盘；盘符探测并行做且单盘 250ms 超时、结果缓存 60s——断连的网络映射盘/空读卡器单次 stat 可阻塞数秒，串行探测会拖住整个盘根列表，探测超时的盘不列出但仍可经路径跳转直达。symlink 归类（stat 目标）也并行做。读不到的路径报 `bad-path`。扩展页无本机 fs 权限，这是勾选真实路径零拷贝引用的唯一入口；面板头部另有路径跳转框，粘贴绝对路径回车直达。
- `fs.write` 会话导出等一次性小文件写入：`path` 为绝对/~ 路径，或走与 upload 一致的工作区三元组 `cwdBase+workspaceId+relPath`（relPath 过 `sanitizeRelPath`）。内容为 UTF-8 文本，上限 10MiB（超限报 `too-large`），父目录自动创建，同名文件直接覆盖。
- `workspace.remove` 删除 `expandTilde(cwdBase || 默认)/<workspaceId>`（id 校验与映射规则同 `resolveWorkspaceRoot`），目录不存在返回 `{removed:false}`，幂等。

bridge → 客户端，事件帧统一：

```
{type:'event', sessionId, seq, event}
{type:'error', id?, error: {code, message}}
```

### 归一化事件（对齐 ACP session update 词汇）

```
{kind:'message_chunk', text}                    文本增量
{kind:'thought_chunk', text}                    思考增量
{kind:'tool_call', id, title, kind, detail, parentId?}     工具调用开始（kind: read|edit|execute|...；detail: 完整输入键值行，≤1200 字符，assistant 消息回填补发；parentId: SDK 消息的 parent_tool_use_id，非空=子智能体内部的工具调用，前端按它折叠到对应 Task 步骤下）
{kind:'tool_call_update', id, status, title?, detail?, result?, summary?, durationMs?}  状态: pending|in_progress|completed|failed；result: 工具结果文本 ≤2500 字符，failed 带结果时红点；durationMs: 工具开始到结果的耗时（适配器按 tool_call/tool_result 时间戳差计算）。扩展侧在 turn_end 把遗留 in_progress 定格为 cancelled（仅 UI 态，协议无此事件）
{kind:'plan', entries:[{content, status}]}
{kind:'permission_request', requestId, title, detail}   暂停该 turn，等 permission.respond
{kind:'session_info', agentSessionId}           agent 侧会话 id，持久化用于 resume
{kind:'usage', costUSD?, durationMs?}           durationMs: 本轮总耗时（SDK result 消息的 duration_ms）
{kind:'turn_end', stopReason: 'end'|'cancelled'|'error', error?}
```

未知 `kind` 一律丢弃不报错（CLI 迭代快，容错优先；与现有 SSE 解析"非 JSON 帧静默跳过"同策略）。

### claude 适配器（SDK 映射）

| 协议面 | SDK 调用 |
|---|---|
| 发起 turn | `query({prompt: text, options})`，消费 async generator 消息流 |
| options.cwd / 附加目录 | spawn cwd；`additionalDirectories: contextDirs` |
| 续聊（记忆） | `options.resume: agentSessionId`（init 事件里的 `session_id`） |
| 增量文本 | `stream_event` → `content_block_delta`（text_delta / thinking_delta） |
| 工具调用 | assistant 消息 `tool_use` 块 → `tool_call`；对应 `tool_result` → `tool_call_update`。消息的 `parent_tool_use_id` 透传为 `parentId`（子智能体归组），两侧时间戳差透传为 `durationMs`（每步耗时） |
| 权限审批 | `options.canUseTool` 回调 → 发 `permission_request`、挂起等待 → 回 `{behavior:'allow'/'deny'}`；30 分钟无响应按 deny |
| 取消 | `AbortController` → `options.abortController`；bridge 侧兜底杀子进程树（记 pid） |
| 权限模式 | `permissionMode`：'default' / 'acceptEdits' / 'bypassPermissions'，来自 `session.new` 参数，默认 'default' |
| system prompt | `systemPrompt: {type:'preset', preset:'claude_code', append: LARGE_TASK_HINT}`——preset 后追加大任务引导（2–4 个并行 Task 子智能体拆分探索，替代主线程串行 Grep/Glob/Read）。SDK snapshot 语义：append 在会话首个请求固化进 transcript，旧会话 resume 不重读，只有新会话生效 |
| Windows | SDK 的 `pathToClaudeCodeExecutable` 指向解析后的真实入口（`where claude` 的结果，规避 `.cmd` 需 shell 展开的问题） |

### codex 适配器（B2，接口面待抓取后补全）

`codex app-server` 启动后按 JSON-RPC stdio 通信；映射关系同表结构：thread 创建/恢复 ↔ `session.new`/`session.resume`，turn 通知 ↔ 归一化事件，审批请求 ↔ `permission_request`。实现前先抓一次实际 schema 并在 `bridge/agents/codex.contract.test.js` 里 pin 关键帧。

## 数据模型

`chrome.storage.local`：

- `llmSettings` 增 `agentBridge: {url: 'ws://127.0.0.1:39217', token: '', defaultAgentId: '', baseDir: '~/.vela-bridge/workspaces'}`
- `conversations` 每会话增：
  - `engine: 'llm' | 'agent'`（缺省 'llm'，旧数据自然兼容）
  - `agentId`、`agentSessionId`（SDK 会话 id，由 `session_info` 事件回填，resume 时传回 bridge；0.5.0 前误存过 bridge 会话 id `s:<uuid>`，加载时清空）
  - `knowledge: [{id, kind: 'upload', name, relPath} | {id, kind: 'local', path}]`：upload 条目已拷入工作区 `knowledge/`；local 条目是本机绝对路径，每轮作为 `contextDirs` 传给 bridge
  - `cwd`、`contextDirs: string[]`（0.5.0 起只读遗留字段，工作目录由 baseDir/<会话 id> 生成）

transcript 照旧全量存 `conversations`：agent 模式下助手项 `content` 为最终文本，`meta.agent = {agentId, steps: [{title, status}]}` 存步骤摘要供离线回放（bridge 不在线时历史照常可见）。

`bridge` 侧不持久化会话（agent 自己持久化，claude 有 `--resume`/SDK resume，codex 有 thread 存储）；bridge 只存运行时 sessions 表与环形事件缓冲。

## 安全设计

1. bridge 只绑 `127.0.0.1`；token 首启生成（`crypto.randomBytes(32)` hex），写 `%USERPROFILE%/.vela-bridge/token.json`。扩展与 bridge 首次握手时自动获取 token 存 `storage.local`，用户无需手动粘贴。防的是任意网页打进 localhost（Origin 校验挡在前面）；本地恶意进程本就能直接读该文件。
2. Origin 校验：只放行本扩展 id 的 `chrome-extension://` Origin，防 DNS rebinding 与仿冒页。
3. 权限默认最小：`permissionMode` 默认 'default'（每次审批）；'bypassPermissions' 在设置页显式开启并标警告文案。
4. 目录白名单：`session.new` 的 cwd/contextDirs 先过 `fs.check`（存在且为目录）才 spawn；不引入静默越权。
5. 上传落盘约束在工作区内：`upload.begin` 的 `relPath` 经 `sanitizeRelPath` 清洗——拒绝绝对路径、盘符（`C:`）、`..` 段、反斜杠与空字节（报 `bad-path`），段内 Windows 保留字符替换 `_`；扩展侧先做一遍同规则清洗。workspaceId 校验拒绝 `/`、`..` 等路径段注入（报 `bad-workspace`）。单文件 200MB、单次 200 个文件、闲置 10 分钟清理，全部在 bridge 侧强制。

## 异常处理

| 场景 | 行为 |
|---|---|
| bridge 未启动 | 聊天卡 agent 引擎下发消息 → 顶栏显示"未连接"，附启动命令提示；自动重连后台跑 |
| token 缺失/不匹配 | 不再断开：Origin 校验通过即自动配对，hello 响应下发当前 token |
| agent 未登录 | `agents.list` 的 `authed:false` → 选择器禁用该项并展示 `loginCommand`（如 `claude login`） |
| turn 中 WS 断开 | bridge 不杀子进程，任务继续；重连后 `events.replay` 补帧 |
| turn 中 bridge 崩溃 | 子进程树随进程组终止；会话恢复后 `session.resume` 续聊 |
| 未知事件/字段 | 丢弃，不报错 |
| 审批无响应 | 30 分钟超时按 deny，turn 结束 |

## 部署与安装

- bridge 随 repo 分发：双击 `bridge\start.bat`（自动切目录、首次装依赖、启动），或手动 `cd /d bridge && npm i && node index.js`。开机自启：注册 HKCU Run 键指向 `bridge\bridge-hidden.vbs`（隐藏窗口，输出记 `bridge-autostart.log`；schtasks 的 onlogon 触发器需要管理员权限，Run 键不需要，见 README 命令）。B2 起提供 `npm i -g` 包装。
- 端口默认 39217，被占即退出提示 `--port`；设置页 URL 与端口对应可改。
- 升级扩展不要求升级 bridge；WS 协议带 `v:1` 字段（`hello` 时交换），不兼容时明确报"bridge 版本过旧/过新"。

## 分期

| 期 | 内容 | 验收 |
|---|---|---|
| B1（0.4.0） | bridge 骨架（WS/token/状态机/重连补帧）+ claude 适配器（流式/审批/resume/取消）+ 设置页 Agent 区 + 聊天卡引擎切换与事件渲染（消息/思考/工具步骤/审批卡/plan）+ cwd/附加目录手输 + 会话记忆 | 配好 bridge 后：选 agent 发消息流式回复；工具步骤可见、审批可批；关卡重开 resume 续聊；直连 LLM 会话不受影响 |
| 0.5.0 | 会话工作区（设置页 baseDir，bridge 按 baseDir/<会话 id> 建目录并设为 cwd）+ 知识库（`fs.list` 本机目录浏览器零拷贝引用 / 上传进工作区 knowledge/ / 手填本地路径）+ 附件（文件/图片/音视频上传进 uploads/，prompt 以相对路径引用）+ 删除会话时清工作区（`workspace.remove`）+ 多视图 conversations 同步（storage.onChanged）+ resume 会话 id 修复 | 发消息即建工作区；知识库三种方式均可用；附件上传后 agent 能读取；删除会话后工作区目录消失、其他视图会话列表即时刷新；bridge 重启后同会话续聊仍记得上文 |
| B2 | codex 适配器（app-server）+ 最近目录列表 | codex 会话与 claude 会话同一套 UI |
| B3 | ACP 通用适配器（加 agent = 一行 launch spec：hermes、pi 等）+ 权限模式设置页 + 工具渲染细化 + 项目级 CLAUDE.md 注入提示 | 新增一个 ACP agent 只改 launch-spec 数据不改协议代码 |

## 边界（暂不做）

bridge 常驻安装包与自动更新、多 agent 并行会话的算力调度、agent 会话的服务端同步、移动端、远程 agent（SSH/容器）、音视频内容的直接理解（附件落盘可引用，Claude 原生不能听/看，需本机 ffmpeg 等工具由 agent 调用）。
