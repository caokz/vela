// 抓回来的远程 HTML 统一从这里解析（fetch_url 工具 / 连读共用）。
// 为什么不直接 DOMParser.parseFromString：解析出的文档虽然惰性（不会执行脚本），
// 但会继承创建文档（扩展页）的 CSP——MV3 扩展页禁止内联脚本，带内联事件处理器
// （on*=）的页面在解析时就会往控制台刷「Executing inline event handler violates…」
// 违例（新 Chrome 一次违例按两条策略各报一条）。功能不受影响、纯噪音，但用户会当成
// 报错。我们只提取正文与链接，on*= 属性不参与任何提取，在字符串层剥掉零损失。
// 只在真实标签内部匹配：正文里 HTML 转义过的代码示例（&lt;button onclick=…&gt;）不受影响。

const TAG_RE = /<[a-z][^>]*>/gi; // 开始标签（</闭合>、<!--注释-->、<!doctype> 不含属性，跳过）
const ON_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi; // on*= 内联事件处理器属性（含未加引号 / 大写）

// 剥掉 HTML 里所有标签上的内联事件处理器属性，其余内容原样保留
export function stripInlineHandlers(html) {
  return String(html ?? '').replace(TAG_RE, (tag) => tag.replace(ON_ATTR_RE, ''));
}

// fetch 回来的 HTML → Document。相对链接按页面地址解析需在取 anchors 时显式传 baseUrl
export function parseFetchedHtml(html) {
  return new DOMParser().parseFromString(stripInlineHandlers(html), 'text/html');
}
