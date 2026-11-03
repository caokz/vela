# 上架 Chrome Web Store（维护者笔记）

面向商店发布流程的维护者备忘，不属于用户文档；`docs/` 不进扩展包（打包白名单只有 `manifest.json` / `src/` / `assets/`，见 `scripts/package.mjs`）。

host_permissions 保留 `<all_urls>`（页面常驻浮窗、任意网页总结 / 翻译依赖它），与主流 AI 助手类扩展一致，审核时附用途说明即可。步骤：

1. 打包：`node scripts/package.mjs` → `dist/vela-<版本>.zip`（白名单制，只含 `manifest.json` / `src/` / `assets/`；bridge 是本机伴生进程，不进扩展包）。bridge 单独分发：`node scripts/package-bridge.mjs`，挂 GitHub Release，用户下载后 `npm i && node index.js`
2. 开发者账号一次性 $5 注册费，上传 zip 提审
3. 隐私政策链接（必填）：`<all_urls>` + 「读取和更改所有网站数据」触发强制要求——数据全部本地存储，网络请求只发用户配置的供应商端点与本地 bridge（127.0.0.1），无遥测无账号体系
4. 权限用途说明（提审表单逐条写清）：`<all_urls>` 任意网页总结 / 翻译 / 划词动作与常驻浮窗；`scripting` 按需注入提取与回填脚本；`sidePanel` / `contextMenus` / `commands` 侧边栏、右键组、快捷键；`downloads` 会话导出与媒体下载；`web_accessible_resources` 页内聊天卡 iframe 与隐藏翻译 runner 页
5. 截图 1280×800 起，商店描述与隐私政策口径一致

备注：若日后为上架改为 optional host permissions，`src/options/options.js` 的 `ensureOriginPermission`（`permissions.contains` / `request` 流程）已保留——当前 manifest 声明 `<all_urls>` 时 contains 恒真、request 不会触发，属休眠路径。
