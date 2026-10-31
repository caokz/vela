// 品牌标识单一来源：Vela = 拉丁语「船帆」（亦是南天船帆座）。
// 图形：主帆 + 前帆 + 船身 + 右上一颗四角星（船帆座）。24 单位视口、填充路径，
// 只用绝对坐标 M / L / C / Z，供三处共用：
//   - scripts/make-icons.mjs 光栅化成 assets/icons/icon{16,32,48,128}.png（Node 直接 import 本文件）
//   - src/ui/shell.js 侧栏 logo（import 本文件）
//   - src/content/widget.js 页面浮窗胶囊（内容脚本禁 import，手抄同一组 d，改这里要同步改那里）

export const LOGO_SAIL_MAIN = 'M11.2 3.2 C15.6 6.6 18.3 11 18.8 15.8 L11.2 15.8 Z';
export const LOGO_SAIL_JIB = 'M9.6 6.4 L9.6 15.8 L4.4 15.8 C5.6 12.2 7.3 9 9.6 6.4 Z';
export const LOGO_HULL = 'M3.4 17.4 L20.6 17.4 C19.7 19.7 17.7 21 15.3 21 L8.7 21 C6.3 21 4.3 19.7 3.4 17.4 Z';
export const LOGO_STAR = 'M19.6 1.6 L20.15 3.35 L21.9 3.9 L20.15 4.45 L19.6 6.2 L19.05 4.45 L17.3 3.9 L19.05 3.35 Z';

export const LOGO_PATHS = [LOGO_SAIL_MAIN, LOGO_SAIL_JIB, LOGO_HULL, LOGO_STAR];

// 内联 SVG 片段（填充 currentColor），给 shell.js 的 ICONS 用
export const LOGO_SVG = LOGO_PATHS.map((d) => `<path d="${d}" fill="currentColor" stroke="none"/>`).join('');

// 品牌色：图标底的对角渐变（左上亮紫 → 右下深紫），与 tokens.css --om-brand 同色系
export const BRAND_GRADIENT = ['#8b6cff', '#5a32e0'];
