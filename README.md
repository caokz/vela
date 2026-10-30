# Vela

参考 Monica 架构自研的 Chrome AI 助手扩展（MV3，原创实现，不含 Monica 的任何代码或资源）。LLM 走自定义供应商设置：兼容 OpenAI 协议或 Anthropic 协议的任意 Base URL + API Key。另有可选的本地 Agent 引擎：通过伴生 bridge 进程调用本机 Claude Code 等 CLI agent（复用其登录态，无需再配 LLM Key）。所有数据存本地，无服务端。

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本目录（或解压 `dist/vela-0.5.0.zip` 后加载）
3. 从 v1 升级：权限有新增（scripting、`<all_urls>`），必须点「重新加载」并确认新权限
4. 工具栏图标 → 侧边栏打开；`Ctrl+M` 呼出侧边栏，`Ctrl+Shift+M` 打开独立聊天页

## 使用前提

聊天默认本地 Agent 引擎（启动 bridge 即用，无需任何 Key）：顶栏不设 LLM/Agent 切换框，新会话一律 Agent，历史 LLM 会话保留原引擎继续可用。网页总结、整页翻译、快捷动作仍需配置至少一个供应商（见下节），模型/语言/模式可点页面浮窗「翻译此页」按钮旁的小设置齿轮就地切换。

## 配置供应商

1. 顶栏 ⚙ 打开设置页
2. 添加供应商，选协议类型，填 Base URL 和 Key：

| 供应商 | 协议 | Base URL |
|---|---|---|
| OpenAI 官方 | OpenAI 兼容 | `https://api.openai.com/v1` |
| Anthropic 官方 | Anthropic | `https://api.anthropic.com` |
| Ollama 本地 | OpenAI 兼容 | `http://localhost:11434/v1` |
| OpenRouter 等中转 | OpenAI 兼容 | 见其文档的版本根 |

3. 模型栏手动填写，或点「测试连接」自动拉取（`GET /models`）合并
4. 勾选「默认」→「保存全部」。保存时浏览器会弹一次站点访问授权（必需，否则扩展页 fetch 被 CORS 拦）

## 功能

**聊天**

- 侧边栏 + 独立聊天页，同一套视图，会话记录共享（`chrome.storage.local` 本地存储）
- 面板只做聊天：顶栏是菜单/模型选择/设置齿轮/总结导出/重新生成/删除，不放页面动作（对齐 Monica）
- 会话侧栏：过滤、切换、悬停重命名（铅笔或双击标题）与删除，按活跃时间从新到旧排序；流式输出（SSE），可中途停止、重新生成
- 总结导出：顶栏下载按钮把当前会话导出成 Markdown——Agent 引擎按会话记录整理全部问答原文，经 bridge 写入文件（默认工作区 `docs/`，绑定项目目录时落项目 `docs/`，可选任意本机目录）；LLM 引擎总结生成后弹系统保存对话框；文件名 `YYYYMMDD-HHmm_主题.md`
- Markdown 渲染（代码块/列表/引用/链接/表格，先转义后转换，防注入）
- 多供应商配置，模型选择器按「供应商 / 模型」分组切换

**本地 Agent（默认聊天引擎）**

- 引擎是会话级记忆属性：新会话一律 Agent（本机 CLI agent），历史 LLM 会话保留原引擎；顶栏无切换框
- bridge 伴生进程（`bridge/`，Node）：扩展页面 ↔ 本机 agent CLI 的 WebSocket 桥，绑定 `127.0.0.1`，token 配对 + Origin 校验
- 当前支持 Claude Code（Agent SDK 驱动）：流式文本 + 思考、工具调用步骤卡（可展开看完整输入与工具结果，带每步耗时）、权限审批卡（允许/拒绝）、轮总耗时与费用统计
- 子智能体分组：agent 派出的子智能体（Task 工具）内部步骤折叠到对应 Task 步骤下，步骤区顶部汇总「运行了 N 个子智能体」；源码分析这类大任务建议把项目目录绑定为工作目录（知识库弹层），比仅加知识库引用探索路径更短
- 大任务自动拆分：新会话的 system prompt 追加引导——大范围源码探索优先拆 2–4 个并行子智能体而不是主线程逐文件搜（每路上下文小、墙钟时间除以并行度）；已 resume 的旧会话沿用创建时的 prompt，不重读该引导
- 权限模式（会话级）：输入框下方下拉切换 agent 工具审批策略——每步审批 / 自动接受编辑 / 自动放行；设置页配全局默认，切换下一轮生效
- 模型（会话级）：输入框下方下拉选择 agent 模型，选项经 bridge 从 agent 背后的 LLM 网关动态拉取（`GET /v1/models`，走中转时列出网关真实模型），拉不到回退 Opus / Sonnet / Haiku 别名；默认项显示真实落点（设置页默认 > CLI 默认 `ANTHROPIC_MODEL`），落点是 `[1M]` 1M 上下文变体时悬停有减速提示；设置页配全局默认，切换下一轮生效
- 会话工作区：每个对话在设置页「工作基础目录」（默认 `~/.vela-bridge/workspaces`）下自动建独立子目录作为 agent 工作目录，知识库与附件也存放在该子目录内；也可在知识库弹层把本机项目目录绑定为工作目录（agent 直接在项目里干活，上传件仍落独立工作区、按绝对路径引用）
- 知识库（会话级）：输入框上方书形按钮，角标显示条目数——浏览本机目录勾选真实路径零拷贝引用（agent 可直接读原文件）、选本地文件/目录上传进工作区 `knowledge/`、或手填本机绝对路径原地引用
- 附件：回形针按钮 / 拖放 / 粘贴，支持文件、图片、音视频（单个与累计 ≤100MB），发送时上传进工作区 `uploads/`，agent 用自己的工具读取分析
- agent 侧 session 跨轮续接（断线自动补帧，bridge 重启后仍记得上文）
- 事件流缓冲 500 帧，重连后 `events.replay` 补齐不丢渲染
- 运行中可发消息：agent 轮进行中发送即入队（消息先落盘，关页不丢），本轮结束自动逐条发出；composer 右侧独立「停止」按钮终止当前轮
- 跳到最新：流式期间上滚翻历史会浮出「最新」按钮，自动跟随暂停；点按回到底部恢复跟随

**网页功能**（页面浮窗 / 右键菜单入口，动作脚本按需注入）

- **页面浮窗**（主要入口）：http(s) 页面右侧常驻——深色圆形动作钮（总结/翻译/解释选中文字）+ 品牌紫胶囊。胶囊就地开关**页内聊天卡**（iframe 嵌扩展聊天页，贴右满高、与原生侧边栏同形态，打开时浮窗列左移让位，胶囊有按下态）；总结/解释点下后按钮紫色高亮到动作落定；翻译按钮是开关——点击就地启动翻译（不弹聊天卡），紫色高亮直到翻译落定，完成后带 ✓ 角标，再点一次还原原文，失败就地提示原因（未配供应商直接跳设置页），悬停亮出按钮旁的**小设置齿轮**、点击展开**网页翻译设置**（LLM 模型、目标语言、对照/沉浸模式，改动即存，无需进设置页）；「×」隐藏当前页浮窗并收起聊天卡，刷新页面自动恢复；翻译进行中浮窗自动让位给浮球。原生侧边栏没有关闭 API，故聊天开合走页内卡片，侧边栏保留给工具栏图标与右键菜单；打开侧边栏或独立聊天页时页内聊天卡自动收起，不会两个聊天窗并存
- **总结此页**：提取当前标签页正文（标题 + URL 随消息记录），流式总结，可追问
- **翻译此页**：视口驱动整页翻译（Monica 式），点浮窗按钮就地启动——
  - 先译当前视口（下方 1 屏预取），滚动到新内容自动续译；等待翻译的段落就地显示「翻译中」标记，译文逐段渐入，不再长时间无反馈后突然出现
  - 对照：译文插入原文段落下方（默认）；沉浸：译文替换原文，原文缓存本地，浮球菜单可还原
  - 翻译中浮球显示进度环，菜单支持 对照/沉浸/还原/关闭 切换；完成后浮球数秒后自动收起，还原走浮窗按钮（✓ 再点一次），切模式走设置齿轮（已译内容即时重铺，无需重译）
  - 自动跳过页眉页脚/代码/配置项/标识符/隐藏元素，标题内锚点链接、带链接的正文段落和侧边导航正常翻译；每页累计翻译上限可在设置页调整（默认 1500 块 / 300000 字符，只计已翻译量，不限制页面发现）
- **快捷动作**：选中网页文字 → 右键动作组（翻译成中文/解释/总结/改写，可在设置页增删改模板）

**设置页**

- 本地 Agent：bridge 地址、连通性测试（逐个显示 agent 登录态，并从 LLM 网关拉取模型列表补进预设）、启动/停止 bridge 按钮（Windows 走 `vela-bridge://` 协议拉起 / `bridge.shutdown` 优雅退出）+ 实时连接状态、默认 agent、权限模式全局默认（每步审批 / 自动接受编辑 / 自动放行）、模型（手填任意模型 id，留空用默认模型，测试连接后预设含网关真实模型）、工作基础目录（每对话自动建子目录，支持 `~`）。token 无需配置：扩展与 bridge 首次握手自动配对
- 网页翻译：供应商管理（多配置、连通性测试、默认模型）+ 全局参数 + 翻译参数（目标语言 11 种、默认模式、批次参数），总结/翻译/快捷动作与 LLM 引擎聊天共用
- 快捷动作编辑器：名称 + prompt 模板（`{text}` 占位符替换为选中文本）

## 启动 agent bridge（可选功能）

仅使用 LLM 引擎时无需本节。要用 Agent 引擎：

```cmd
cd /d E:\code\vela\bridge
npm install        # 仅首次
node index.js      # 默认监听 ws://127.0.0.1:39217
```

或者直接双击 `bridge\start.bat`（自动切目录、首次装依赖、启动；注意 cmd 的 `cd` 跨盘符必须带 `/d`，否则不切盘）。

**开机自启**（一次配置）：管理员权限不是必须，注册 HKCU Run 键即可，在 cmd 里执行：

```cmd
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v VelaBridge /t REG_SZ /d "wscript.exe \"E:\code\vela\bridge\bridge-hidden.vbs\"" /f
```

`bridge\bridge-hidden.vbs` 隐藏窗口启动（无控制台黑框），输出写 `bridge\bridge-autostart.log`。取消自启：`reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v VelaBridge /f`。注意 `.bat`/`.vbs` 里不要写中文注释——cmd/wscript 按 ANSI 解析 UTF-8 中文会语法错乱。

**设置页启停**：bridge 首次运行后在 Windows 注册 `vela-bridge://` URL 协议（HKCU 用户级，幂等覆盖刷新）；设置页「本地 Agent」的「启动 bridge」按钮通过该协议拉起进程（Chrome 首次会弹「打开 Vela Bridge？」确认框，勾选记住后免确认），「停止 bridge」按钮走 `bridge.shutdown` 指令让进程优雅退出，连接状态实时显示。不想注册协议时用 `VELA_NO_PROTOCOL_REGISTER=1 node index.js` 启动。

首次启动会在 `~/.vela-bridge/token.json` 生成配对 token（0600 权限），扩展与 bridge 首次握手时自动获取并存入本地设置，用户无需手动粘贴。之后新会话默认走 Agent 引擎。前提：本机已安装并登录 Claude Code（`claude` 命令可用）。

## 上架 Chrome 商店

host_permissions 与 Monica/MaxAI 等同类扩展一致，保留 `<all_urls>`（页面常驻浮窗、任意网页总结/翻译依赖它），审核时附用途说明即可。步骤：

1. 打包：`node scripts/package.mjs` → `dist/vela-<版本>.zip`（白名单制，只含 `manifest.json` / `src/` / `assets/`；bridge 是本机伴生进程，不进扩展包）。bridge 单独分发：`node scripts/package-bridge.mjs` → `dist/vela-bridge-<版本>.zip`，挂 GitHub Release，用户下载后 `npm i && node index.js`
2. 开发者账号一次性 $5 注册费，上传 zip 提审
3. 隐私政策链接（必填）：`<all_urls>` + 「读取和更改所有网站数据」权限会触发强制要求；个人可放 GitHub Pages 一页说明——数据全部本地存储（chrome.storage.local），网络请求只发用户配置的供应商端点与本地 bridge（127.0.0.1），无遥测无账号体系
4. 权限用途说明（提审表单里逐条写清）：
   - `<all_urls>`：任意网页的总结/翻译/划词动作与常驻浮窗；页面正文只用于构建当次 prompt
   - `scripting`：按需注入正文提取与译文回填脚本
   - `sidePanel` / `contextMenus` / `commands`：侧边栏入口、右键动作组、快捷键
   - `downloads`：会话总结导出为 Markdown 文件
   - `web_accessible_resources`（http/https 匹配）：页内聊天卡 iframe 与隐藏翻译 runner 页
5. 截图 1280×800 起（至少 1 张 1280×800 或 640×400），商店描述与隐私政策口径一致


## 目录结构

```
manifest.json                 MV3 清单：storage/sidePanel/contextMenus/scripting + <all_urls>
bridge/                       本地 agent bridge 伴生进程（Node，ws + Claude Agent SDK，不进扩展包）
bridge/workspace.js            工作区解析（baseDir/<会话 id>）+ 分块上传状态机（begin/chunk/end/cancel）
src/agent/
  client.js                   扩展页 WS 客户端：单例、重连退避、请求配对、事件回调分发
  render.js                   归一化事件 → 渲染状态（纯函数，支持离线重放）
  compose.js                  prompt 组装纯函数：知识库/附件以工作区相对路径附加
src/background/               service worker：右键菜单组、pendingTask 中转（不做网络请求）
src/llm/
  store.js                    设置存储（含翻译/快捷动作/agentBridge 配置）、streamChat 入口
  tasks.js                    纯函数：总结/翻译 prompt 构建、译文 JSON 容错解析、批次规划
  openai.js / anthropic.js    两协议 SSE 适配器
  sse.js                      共用 SSE 分帧解析 + HTTP 错误映射
src/storage/conversations.js  会话 CRUD（客户端生成 conv:/msg: ID，消息树字段）
src/ui/
  shell.js                    DOM 骨架（侧栏/主区/composer，面板与聊天页同构）
  chat-ui.js                  聊天交互（流式、会话、页面功能编排入口）
  chat.css / tokens.css       设计 token + 视图样式（暗色跟随系统）
  markdown.js                 极简渲染器
src/page/page-actions.js      页面功能编排：总结提取、视口驱动翻译调度（并发 2 + 重试退避）
src/page/tx-runner.html/.js   隐藏翻译编排页（浮窗就地启动，0×0 iframe 驻留滚动续译）
src/content/
  injected.js                 自包含提取函数（executeScript func 注入，ISOLATED world）
  bridge.js                   块发现 + 视口观察 + 译文回填 + Shadow DOM 浮球 + SPA 还原守卫（IIFE 注入）
  widget.js                   页面常驻浮窗（总结/解释交 SW 中转；翻译就地启动隐藏 runner）
src/sidepanel/  src/chatpage/  src/options/    三个页面
scripts/make-icons.mjs        图标生成（零依赖 PNG 编码）
scripts/package.mjs           打包 dist zip
docs/DESIGN.md                架构与协议设计
```

## 与 Monica 的差异（有意为之）

| Monica | 本项目 |
|---|---|
| 服务端持有 LLM 与配额，`oauth_session` 登录 | 本地配置直连供应商，无账号体系；Agent 引擎复用本机 CLI 登录态 |
| 流式在 service worker 内执行 | 流式 fetch 在面板/聊天页执行，规避 MV3 SW 30 秒回收 |
| Centrifugo WSS 做多端同步通知 | 无服务端；仅可选的本地 agent bridge（127.0.0.1 + token） |
| content.js 注入所有页面（28MB bundle） | 唯一常驻注入是 ~4KB 浮窗；提取/回填等功能脚本仍按需注入 |
| 埋点上报用户行为 | 无埋点 |
| 15 个功能模块配额 | 无配额，费用走自己的 Key |

## 安全说明

- API Key 明文存于 `chrome.storage.local`（仅本机可读）。个人使用可接受；共享机器建议用完移除供应商配置
- 会话记录同样明文本地存储，删除对话即从存储移除
- 不发起任何遥测请求；网络请求只有配置的供应商端点
- agent bridge 只监听 `127.0.0.1`，连接先校验 `chrome-extension://` Origin（网页无法接入）；token 落盘 `~/.vela-bridge/token.json`（0600），对通过 Origin 校验的扩展在握手时自动下发。token 防的是网页，本地恶意进程本就能直接读该文件。bridge 能以本机 CLI 登录态执行任意操作，不要把端口转发到外网
- `host_permissions: ["<all_urls>"]`：总结/翻译面向任意网页，页面浮窗也要常驻注入，逐站授权会在每个新站静默失败。安装时浏览器提示「读取和更改所有网站数据」——页面数据只用于构建当次 prompt，不落盘（除总结消息记录）、不上传（除供应商端点）。上架商店需回退 optional 授权流程

## 已知边界

- Markdown 不支持图片
- 流式期间锁定会话切换（防写交叉）
- `max_tokens` 默认不发送；Anthropic 协议必填，默认 4096。部分新模型不接受 temperature，留空即不发送
- 浮窗发起的翻译跑在页内隐藏 runner iframe（不弹聊天卡），页面导航即结束，浮球仍可本地还原；右键菜单发起的翻译跑在侧边栏/聊天页，关闭面板即终止
- 原生侧边栏无关闭 API（Chrome 限制）：页内开合由浮窗聊天卡承担，侧边栏只作工具栏/右键菜单入口
- 沉浸模式下含链接/代码/图片的段落自动降级为对照（防丢格式）
- 页面导航/SPA 路由变化自动还原，不做跨页续译（同页动态插入的内容会经 MutationObserver 续译）
- 上下文超限自动对半拆批重试；429 限流中止整轮，可稍后重试
