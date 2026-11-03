# Vela

**简体中文** | [English](README.en.md)

自研的 Chrome AI 助手扩展（MV3）。零构建、零第三方依赖，纯 ES module 由 Chrome 直加载。LLM 走自定义供应商：兼容 OpenAI 协议或 Anthropic 协议的任意 Base URL + API Key；另有本地 Agent 引擎，通过伴生 bridge 进程调用本机 Claude Code / Codex CLI（复用其登录态，无需再配 Key）。所有数据存本地，无服务端、无遥测、无账号体系。

## 效果预览

| 页内聊天卡 · 页面上下文追问 | 整页翻译 · 英中对照 |
|---|---|
| ![页内聊天卡](docs/screenshots/chat-card.png) | ![整页翻译](docs/screenshots/translate.png) |
| 划词思维导图 · 高亮素材生成 | Agent 引擎 · 思考与工具步骤 |
| ![划词思维导图](docs/screenshots/mindmap.png) | ![Agent 引擎](docs/screenshots/agent.png) |

## 核心差异

与账号制、按次配额的联网 AI 助手不同，Vela 把控制权与成本都留给用户：

- **数据不出本机**——无账号、无遥测、无服务端。会话与配置全存浏览器本地存储，网络请求只发你配置的供应商端点与本地 bridge
- **复用本机 CLI 登录态**——Agent 引擎经本地 bridge 直接驱动你已登录的 Claude Code / Codex，不用另买 API Key，用的是已有订阅
- **自带 Key，无配额**——任何 OpenAI / Anthropic 兼容端点即插即用；没有「每日 N 次」限制，费用走你自己的 Key
- **轻量常驻**——全站常驻注入的只有浮窗与划词工具条两个脚本（约 100KB 未压缩源码），正文提取、翻译回填等重脚本全部按需注入，不拖慢日常浏览
- **长回答不断流**——流式请求全部在扩展页执行，规避 MV3 service worker 30 秒回收，长总结与整页翻译不会被中途掐断
- **源码可审计**——零构建、零第三方依赖，纯 ES module 直加载，装的就是你能读到的代码

## 功能总览

| 能力 | 说明 |
|---|---|
| 三形态聊天 | 原生侧边栏（`Ctrl+M`）、独立聊天页（`Ctrl+Shift+M`）、页内聊天卡（浮窗胶囊就地开合，跟随宿主页上下文） |
| 三引擎 | **Agent**（本机 CLI，默认）· **LLM 问答**（直连供应商流式聊天）· **LLM 任务**（模型驱动工具循环） |
| 网页总结 | 提取正文流式总结，可追问 |
| 整页翻译 | 视口驱动、对照 / 沉浸双模式，滚动续译，浮球菜单切模式 / 还原 |
| 划词动作 | 划词工具条 + 右键菜单组（翻译 / 解释 / 总结 / 改写，模板可编辑） |
| 划词思维导图 | 高亮素材攒批生成 + 整页正文生成，双模式；导出 Markdown / FreeMind |
| 媒体理解 | 悬停网页图片 / 视频浮出弹层：分析、提取文案、进导图、下载、视频关键帧分析 |
| 连续阅读 | 从当前文档页自动跟随「下一页」逐页读完，逐页小结 + 跨页总览 |
| 知识库 | 会话级授权本机文件夹 / 文件（三种来源：零拷贝句柄 / 只读快照 / bridge 路径），三引擎共用 |

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本仓库根目录（或解压 `dist/vela-<版本>.zip` 后选择解压目录）
3. 升级 / 改代码后：在扩展页点「重新加载」（改浮窗等注册式内容脚本后必须重新加载才在页面生效）

## 配置供应商（LLM 引擎需要，Agent 引擎不需要）

1. 顶栏 ⚙ 打开设置页
2. 添加供应商，选协议类型，填 Base URL 和 Key：

| 供应商 | 协议 | Base URL |
|---|---|---|
| OpenAI 官方 | OpenAI 兼容 | `https://api.openai.com/v1` |
| Anthropic 官方 | Anthropic | `https://api.anthropic.com` |
| Ollama 本地 | OpenAI 兼容 | `http://localhost:11434/v1` |
| OpenRouter 等中转 | OpenAI 兼容 | 见其文档的版本根 |
| 智谱 / DeepSeek / Kimi 等 | OpenAI 兼容 | 见各官方文档 |

3. 模型栏手动填写，或点「测试连接」自动拉取（`GET /models`）合并
4. 勾选「默认」→「保存全部」。保存时浏览器会弹一次站点访问授权（必需，否则扩展页 fetch 被 CORS 拦）

## 三引擎

引擎是会话级属性，顶栏切换（选择会记为新会话默认）；在已有消息的会话上切换会自动新建对话。

- **Agent（新会话默认）**：经 bridge 调用本机 Claude Code（Agent SDK）或 Codex（`codex app-server`）。前提：启动 bridge + 本机已安装并登录对应 CLI。流式文本 + 思考、工具调用步骤卡（可展开看输入与结果、带耗时）、权限审批卡、费用统计、子智能体分组。
- **LLM 问答**：直连供应商 SSE 流式聊天，会话记住所选「供应商 / 模型」精确路由；图片附件走视觉理解（OpenAI `image_url` / Anthropic `image` 块）。
- **LLM 任务**：模型驱动工具循环——7 个浏览器工具（读当前页 / 选中 / 标签页、联网读取、开标签、下载）+ 知识库文件工具（list / search / read / write / edit / load_skill）。联网读取 / 开标签 / 下载先弹审批卡，写文件先弹 diff 审批；步数上限（默认 12）用尽自动暂停，回「继续」接力。

## 聊天

- 三个视图同构（同一套代码经 variant 区分），会话记录共享、多视图自动同步
- 会话侧栏：过滤、切换、悬停重命名与删除，按活跃时间排序；流式输出可中途停止、重新生成
- 运行中可发消息：agent 轮进行中发送即入队（先落盘，关页不丢），本轮结束自动逐条发出；流式期间上滚翻历史浮出「最新」按钮，点按回到底部恢复跟随
- 总结导出：当前会话导出 Markdown——Agent 引擎经 bridge 写入工作区 `docs/`（可选任意本机目录）；LLM 引擎弹系统保存对话框；文件名 `YYYYMMDD-HHmm_主题.md`
- Markdown 渲染（代码块 / 列表 / 引用 / 链接 / 表格，先转义后转换防注入）

## 本地 Agent 引擎细节

- **bridge 伴生进程**（`bridge/`，Node ≥18）：扩展页 ↔ 本机 agent CLI 的 WebSocket 桥，只绑 `127.0.0.1`，token 首次握手自动配对 + Origin 校验（网页无法接入）
- **子智能体**：agent 派出的子智能体（Task 工具）内部步骤折叠到对应 Task 步骤下；大范围源码探索建议把项目目录绑定为工作目录（知识库弹层）
- **权限模式（会话级）**：输入框下方下拉——每步审批 / 自动接受编辑 / 自动放行；设置页配全局默认
- **模型（会话级）**：输入框下方下拉，选项经 bridge 从 agent 背后的 LLM 网关动态拉取，拉不到回退 Opus / Sonnet / Haiku 别名；默认项显示真实落点
- **会话工作区**：每个对话在「工作基础目录」（默认 `~/.vela-bridge/workspaces`）下自动建独立子目录；也可在知识库弹层把本机项目目录绑定为工作目录（agent 直接在项目里干活）
- **知识库与附件**：见下节；附件支持文件、图片、音视频（单个与累计 ≤100MB），发送时上传进工作区 `uploads/`
- agent 侧 session 跨轮续接：断线自动补帧（500 帧缓冲），bridge 重启后仍记得上文

## 知识库（会话级，三引擎共用一个入口）

输入框上方书形按钮，角标显示条目数。四种来源：

| 来源 | 适用 | 特性 |
|---|---|---|
| 本机目录勾选（句柄） | 侧边栏 / 聊天页 / 设置页 | File System Access 零拷贝引用，按需读原文件，agent / LLM 任务直接读 |
| 授权文件夹 / 文件（快照） | 页内聊天卡 | 跨源 iframe 弹不出系统选择框，自动降级：字节复制进扩展 IndexedDB 只读快照（上限 200 个 / 单个 50MB / 合计 200MB），重载后仍可读 |
| 本机绝对路径（bridge 路径） | 装了 bridge 的机器 | LLM 任务直接读写本机路径，零拷贝 |
| 上传进工作区 | Agent 引擎 | 增量同步到会话工作区 `knowledge/` |

格式支持：文本带行号（UTF-8 失败退 GBK）、docx / xlsx / pptx 转 Markdown、PDF / 图片作为工具结果附件交给模型原生读取。说明型 skill 放在知识库目录 `.vela/skills/<名>/SKILL.md`。

## 网页功能（浮窗 / 划词工具条 / 右键菜单入口）

- **页面浮窗**（主要入口）：http(s) 页面右侧常驻——深色圆形动作钮（总结 / 翻译 / 解释选中文字 / 连读 / 导图）+ 品牌紫胶囊。胶囊就地开关**页内聊天卡**；「×」隐藏当前页浮窗，刷新自动恢复；翻译按钮是开关（就地启动不弹聊天卡，完成带 ✓，再点还原），悬停亮出小设置齿轮（翻译模型 / 目标语言 / 对照 / 沉浸，改动即存）
- **总结此页**：提取当前标签页正文（标题 + URL 随消息记录），流式总结，可追问
- **翻译此页**：视口驱动整页翻译——先译当前视口（下方 1 屏预取），滚动自动续译，等待段落就地显示「翻译中」；对照（默认）/ 沉浸可切；自动跳过页眉页脚 / 代码 / 标识符；每页翻译上限可在设置页调整（默认 1500 块 / 300000 字符）
- **快捷动作**：选中文字 → 工具条或右键动作组，模板可在设置页增删改（`{text}` 占位符）
- **划词思维导图**：高亮只记录、生成永远显式——「高亮」把选中文本攒进素材库，「思维导图」钮显式生成（高亮素材 / 整页正文双模式，同页同模式内容没变重开零调用）；支持就地改名、编辑大纲往返、折叠 / 平移缩放、导出 .md / FreeMind .mm
- **媒体理解**：鼠标停在 ≥80px 的图片 / 视频上 200ms，右上角浮出品牌紫圆钮，点击就地弹单媒体弹层。图片四动作：分析 / 提取文案 / 进导图 / 下载；视频取关键帧做视觉分析
- **连续阅读（连读）**：从当前文档页自动跟随「下一页」（确定性打分不烧 LLM：`rel=next` > 整段文本 > 前缀 > 纯箭头），**只跟同源**、防回环，上限 30 页，页间 800ms 礼貌间隔；逐页小结流式汇入同一回答 + 收尾总览，随时可停，页清单与停止原因记在消息里

## 启动 agent bridge（可选功能）

仅使用 LLM 引擎时无需本节。要用 Agent 引擎：

```cmd
cd /d <仓库路径>\bridge
npm install        # 仅首次
node index.js      # 默认监听 ws://127.0.0.1:39217
```

或直接双击 `bridge\start.bat`（自动切目录、首次装依赖、启动）。前提：本机已安装并登录 Claude Code（`claude` 命令可用）或 Codex（`codex` 命令可用）。

**开机自启**（一次配置）：管理员权限不是必须，注册 HKCU Run 键即可：

```cmd
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v VelaBridge /t REG_SZ /d "wscript.exe \"<仓库路径>\bridge\bridge-hidden.vbs\"" /f
```

`bridge-hidden.vbs` 隐藏窗口启动，输出写 `bridge\bridge-autostart.log`。取消自启：`reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v VelaBridge /f`。

**设置页启停**：bridge 首次运行后在 Windows 注册 `vela-bridge://` URL 协议；设置页「启动 bridge」按钮经该协议拉起进程，「停止 bridge」走优雅退出，连接状态实时显示。首次启动会在 `~/.vela-bridge/token.json` 生成配对 token（0600 权限），扩展与 bridge 首次握手自动配对，无需手动粘贴。

## 上架 Chrome 商店

host_permissions 保留 `<all_urls>`（页面常驻浮窗、任意网页总结 / 翻译依赖它），与主流 AI 助手类扩展一致，审核时附用途说明即可。步骤：

1. 打包：`node scripts/package.mjs` → `dist/vela-<版本>.zip`（白名单制，只含 `manifest.json` / `src/` / `assets/`；bridge 是本机伴生进程，不进扩展包）。bridge 单独分发：`node scripts/package-bridge.mjs`，挂 GitHub Release，用户下载后 `npm i && node index.js`
2. 开发者账号一次性 $5 注册费，上传 zip 提审
3. 隐私政策链接（必填）：`<all_urls>` + 「读取和更改所有网站数据」触发强制要求——数据全部本地存储，网络请求只发用户配置的供应商端点与本地 bridge（127.0.0.1），无遥测无账号体系
4. 权限用途说明（提审表单逐条写清）：`<all_urls>` 任意网页总结 / 翻译 / 划词动作与常驻浮窗；`scripting` 按需注入提取与回填脚本；`sidePanel` / `contextMenus` / `commands` 侧边栏、右键组、快捷键；`downloads` 会话导出与媒体下载；`web_accessible_resources` 页内聊天卡 iframe 与隐藏翻译 runner 页
5. 截图 1280×800 起，商店描述与隐私政策口径一致

## 目录结构

```
manifest.json                 MV3 清单（storage/sidePanel/contextMenus/scripting/downloads + <all_urls>，Chrome ≥116）
bridge/                       本地 agent bridge 伴生进程（Node ≥18，ws + Claude Agent SDK，不进扩展包）
  server.js / workspace.js    WS 服务（token 配对、Origin 校验）；工作区解析 + 分块上传状态机
  turn.js                     会话 hub：seq、500 帧缓冲、权限请求 / 应答
  agents/claude.js            Claude Code 适配器（Agent SDK 消息流 → 归一化事件）
  agents/codex.js             Codex 适配器（codex app-server JSON-RPC → 同一事件词汇表）
src/background/               service worker：右键菜单、pendingTask 中转、快捷键（不做网络请求）
src/agent/                    扩展侧 agent 客户端（WS 单例、重连补帧、分块上传）、事件渲染纯函数、prompt 组装
src/llm/                      LLM 引擎：streamChat、openai/anthropic SSE 适配器、sse 分帧、
                              tool-loop 工具循环、browser-tools 浏览器工具、fs-tools 知识库文件工具、prompt 纯函数
src/kb/                       知识库：句柄 / 快照存取（IndexedDB）、格式读取（文本/docx/xlsx/pptx/PDF/图片）、
                              bridge 路径虚拟句柄、Agent 同步上传
src/read/series.js            连读：下一页打分 / 抓取 / 解析
src/mindmap/                  划词思维导图（素材库、大纲解析与导出、查看页）
src/media/                    网页媒体悬停理解弹层
src/common/html.js            抓取 HTML 统一解析（字符串层剥内联事件处理器，防 CSP 违例噪音）
src/page/                     页面功能编排（总结 / 翻译 / 连读调度）、隐藏翻译 runner、划词面板
src/content/                  常驻浮窗、划词工具条、翻译回填 + 浮球 + SPA 守卫、正文提取注入
src/ui/                       侧边栏与聊天页同构视图（shell / chat-ui / markdown / 样式）
src/sidepanel/ src/chatpage/ src/options/    三个页面文档
scripts/                      测试（单元 + 浏览器 e2e）、打包、图标生成
docs/DESIGN.md                扩展架构与协议设计
docs/agent-bridge.md          bridge WS 协议与事件词汇表
```

## 安全说明

- API Key 明文存于 `chrome.storage.local`（仅本机可读）。个人使用可接受；共享机器建议用完移除供应商配置
- 会话记录同样明文本地存储，删除对话即从存储移除
- 不发起任何遥测请求；网络请求只有配置的供应商端点
- agent bridge 只监听 `127.0.0.1`，连接先校验 `chrome-extension://` Origin（网页无法接入）；token 落盘 `~/.vela-bridge/token.json`（0600），对通过 Origin 校验的扩展在握手时自动下发。bridge 能以本机 CLI 登录态执行任意操作，不要把端口转发到外网
- `host_permissions: ["<all_urls>"]`：总结 / 翻译面向任意网页，页面浮窗常驻注入，逐站授权会在每个新站静默失败。页面数据只用于构建当次 prompt，不落盘（除总结消息记录）、不上传（除供应商端点）

## 已知边界

- Markdown 不支持图片
- 流式期间锁定会话切换（防写交叉）
- `max_tokens` 默认不发送；Anthropic 协议必填，默认 4096。部分新模型不接受 temperature，留空即不发送
- 浮窗发起的翻译跑在页内隐藏 runner iframe，页面导航即结束；右键菜单发起的翻译跑在侧边栏 / 聊天页，关闭面板即终止
- 原生侧边栏无关闭 API（Chrome 限制）：页内开合由浮窗聊天卡承担
- 沉浸模式下含链接 / 代码 / 图片的段落自动降级为对照（防丢格式）
- 连读只跟同源「下一页」，不跨站；单次上限 30 页（`llmSettings.readSeries.maxPages`）
- 聊天卡里的知识库授权是只读快照（浏览器对跨源 iframe 的限制），要零拷贝句柄请在侧边栏 / 聊天页里授权
- 上下文超限自动对半拆批重试；429 限流中止整轮，可稍后重试

## 许可证

[AGPL-3.0](LICENSE)——修改并分发本项目的衍生作品须以同等许可开源。版权为单一作者持有，未来可能在此基础上另行提供商业授权（双许可）。
