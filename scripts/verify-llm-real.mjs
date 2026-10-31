// 真实供应商 e2e（会产生真实调用与费用，不进默认测试）：对每个已配置供应商的首个模型，
// 验证 LLM 问答能流式出字、LLM 任务模式能真的调用 get_current_page 读到网页里的标记。
// 设置来源：VELA_LLM_SETTINGS 指向的 JSON，或 %TEMP%/vela-llm-settings.json
// （node scripts/tmp-extract-llm.mjs 从已安装扩展提取；key 不打印）。
// 用法：node scripts/verify-llm-real.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch, sleep, waitFor, createChecker, seedStorage } from './lib/cdp.mjs';

const { check, summary } = createChecker();
const file = process.env.VELA_LLM_SETTINGS || join(process.env.TEMP || tmpdir(), 'vela-llm-settings.json');
if (!existsSync(file)) {
  console.log(`FAIL 找不到真实供应商设置 ${file}：先运行 node scripts/tmp-extract-llm.mjs，或设 VELA_LLM_SETTINGS`);
  process.exit(1);
}
const real = JSON.parse(readFileSync(file, 'utf8'));
const providers = (real.providers || []).filter((p) => p.models?.length && p.apiKey);
if (!providers.length) { console.log('FAIL 设置里没有带 key 和模型的供应商'); process.exit(1); }

const MARKER = `VELA-REAL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const web = createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(`<!doctype html><title>真实供应商测试页</title><article><h1>测试页</h1><p>本页的校验标记是 ${MARKER}。${'这是一段填充正文。'.repeat(20)}</p></article>`);
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${web.address().port}/`;

const b = await launch({ port: 9368, url: PAGE });
try {
  const sw = await b.sw();
  await seedStorage(sw, {
    llmSettings: { ...real, agentBridge: { ...(real.agentBridge || {}), url: 'ws://127.0.0.1:39299' } },
    conversations: [],
  });
  sw.close();
  const chat = await b.openTab(`chrome-extension://${b.extId}/src/chatpage/chat.html`, { wait: 2000 });
  const E = (x) => chat.evaluate(x);
  const setSel = (id, v) => E(`(() => { const s = document.getElementById('${id}'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
  const last = () => E(`(() => { const a = [...document.querySelectorAll('.om-msg-answer')].at(-1); return JSON.stringify({ text: a?.querySelector('.om-body')?.innerText || '', err: a?.querySelector('.om-error')?.textContent || '', steps: [...(a?.querySelectorAll('.om-agent-step-title') || [])].map((x) => x.textContent) }); })()`).then(JSON.parse);
  const idle = () => E(`!document.getElementById('om-send').classList.contains('om-streaming')`);
  const ask = async (text) => {
    await E(`(() => { const i = document.getElementById('om-input'); i.value = ${JSON.stringify(text)}; document.getElementById('om-send').click(); return 1; })()`);
    await sleep(800);
    await waitFor(idle, { timeout: 120000, interval: 500 });
    return last();
  };
  for (const p of providers) {
    const label = `${p.name || p.id}（${p.kind} / ${p.models[0]}）`;
    await setSel('om-engine', 'llm');
    await sleep(400);
    await setSel('om-model', JSON.stringify([p.id, p.models[0]]));
    let r = await ask('只回复两个字母：OK');
    check(`${label} LLM 问答出字`, !r.err && r.text.trim().length > 0, r.err || r.text.slice(0, 80));
    await setSel('om-engine', 'llm-tools');
    await sleep(400);
    await setSel('om-model', JSON.stringify([p.id, p.models[0]]));
    r = await ask('请调用工具读取我当前打开的网页，然后只告诉我页面里以 VELA-REAL- 开头的校验标记。');
    check(`${label} 任务模式调用 get_current_page`, r.steps.some((s) => /get_current_page|read_tab/.test(s)), r.steps);
    check(`${label} 任务模式回答含网页标记`, r.text.includes(MARKER), r.err || r.text.slice(0, 200));
  }
} catch (e) {
  check('执行异常', false, e.stack || e.message);
} finally {
  await b.close();
  web.close();
}
process.exit(summary());
