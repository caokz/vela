// claude code 适配器：包 Claude Agent SDK 的 query()。
// 映射：stream_event 增量 → message_chunk/thought_chunk；tool_use → tool_call；
// tool_result → tool_call_update；canUseTool → permission_request（挂起等 respond）。
// SDK 未公开子进程 pid，取消统一走 AbortController，SDK 自己负责杀子进程。

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const PROBE_TIMEOUT_MS = 3000;

// SDK 自带捆绑的 CLI；VELA_CLAUDE_PATH 可指向用户自己的安装
export function claudeExecutablePath() {
  return process.env.VELA_CLAUDE_PATH || '';
}

// CLI 侧的连接配置（ANTHROPIC_BASE_URL/token/默认模型映射）写在 ~/.claude/settings.json
// 的 env 块里，CLI 每次启动都应用它；而 bridge 由 vela-bridge:// 协议拉起，只继承
// Explorer 的进程环境，读不到这些变量。probe/listModels 必须合并 settings.json 的
// env 才能和 CLI 实际用的网关/模型一致（settings 覆盖进程环境，与 CLI 应用顺序相同）。
// 文件不存在/解析失败时退回纯环境变量。
export function claudeEnv() {
  let fileEnv = {};
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    if (parsed && typeof parsed.env === 'object' && parsed.env) fileEnv = parsed.env;
  } catch { /* 无配置文件或坏 JSON：环境变量兜底 */ }
  return { ...process.env, ...fileEnv };
}

// 登录态判定（尽力而为）：凭证文件存在或配置里有 token/key。mac 钥匙串探测不到，
// 此时误报“未登录”无碍——发起会话时 SDK 的真实报错会经 turn_end 透出。
export function claudeAuthed() {
  const env = claudeEnv();
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return true;
  return existsSync(join(homedir(), '.claude', '.credentials.json'));
}

function runVersion() {
  return new Promise((resolve) => {
    // Windows 下 claude 是 .cmd shim，必须带 shell 才能执行；整条命令串死防注入
    const command = process.platform === 'win32' ? 'claude --version' : 'claude';
    const args = process.platform === 'win32' ? [] : ['--version'];
    const child = execFile(command, args, { timeout: PROBE_TIMEOUT_MS, shell: process.platform === 'win32' }, (err, stdout) => {
      resolve(err ? null : (stdout || '').trim());
    });
    child.on('error', () => resolve(null));
  });
}

// 大任务派子智能体的引导。主线程串行 Glob/Grep/Read 步数多、上下文滚雪球，
// 每步都要全量重发（prefill 越来越长）；并行 Task 子智能体每路上下文小，
// 墙钟时间除以并行度。实测对比：串行 ~100 步 vs 3 路并行，是同问题下
// 两个前端速度差的主因。
export const LARGE_TASK_HINT = [
  'Task-splitting guidance: when a request requires exploring a large codebase or many files',
  '(for example, "analyze how X works across this project"), do not search file by file in the main conversation.',
  'Split the work into 2-4 parallel Task subagents, each scoped to a distinct module, directory, or question,',
  'then synthesize their reports into the final answer. Keep direct Grep/Glob/Read in the main conversation',
  'only for quick, small lookups. Parallel subagents finish faster and keep the main context small.',
].join(' ');

// query() 的静态选项（不含 abortController / canUseTool 这类每轮新建的回调）。
// 导出给测试断言：systemPrompt 追加、cwd/model/权限模式透传。
export function baseQueryOptions(session) {
  return {
    cwd: session.cwd || homedir(),
    additionalDirectories: session.contextDirs.length ? session.contextDirs : undefined,
    resume: session.agentSessionId || undefined,
    permissionMode: session.permissionMode || 'default',
    model: session.model || undefined, // 留空用 SDK/CLI 默认模型
    includePartialMessages: true,
    // preset 后追加引导文案。SDK 默认 snapshot: 会话首个请求把 system prompt
    // 固化进 transcript，之后 resume 的旧会话不重读 append——只有新会话生效。
    systemPrompt: { type: 'preset', preset: 'claude_code', append: LARGE_TASK_HINT },
    ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}),
  };
}

export const claudeAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  loginCommand: ['claude', 'login'],

  async probe() {
    const version = await runVersion();
    return {
      id: this.id,
      name: this.name,
      version: version || '',
      authed: version ? claudeAuthed() : false,
      loginCommand: this.loginCommand,
      // CLI 默认模型（settings env 的 ANTHROPIC_MODEL）：让前端「默认模型」选项显示真实落点，
      // 避免静默落到带 [1M] 后缀的网关变体
      defaultModel: claudeEnv().ANTHROPIC_MODEL || '',
    };
  },

  // 模型列表：问 agent 背后的 LLM 网关（ANTHROPIC_BASE_URL 指向的中转或官方）。
  // 首选 GET {base}/v1/models；网关不实现该路由（或订阅登录无 key 401）时，
  // 回退 settings env 的默认模型映射（ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL）
  // ——网关用户在这里显式配置过别名落点，这些 id 就是 CLI 实际可用的模型；
  // 两条路都拿不到才抛错，上层捕获后回退预设别名，不阻塞聊天。
  async listModels() {
    const env = claudeEnv();
    const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
    const headers = { 'anthropic-version': '2023-06-01' };
    if (env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
    if (env.ANTHROPIC_API_KEY) headers['x-api-key'] = env.ANTHROPIC_API_KEY;
    try {
      const res = await fetch(`${base}/v1/models?limit=100`, { headers, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        const ids = (Array.isArray(data?.data) ? data.data : [])
          .map((m) => (typeof m?.id === 'string' ? m.id : ''))
          .filter(Boolean);
        if (ids.length) return ids;
      }
    } catch { /* 网络不通/超时 → 走默认模型映射回退 */ }
    const mapped = [...new Set(['OPUS', 'SONNET', 'HAIKU', 'FABLE']
      .map((k) => env[`ANTHROPIC_DEFAULT_${k}_MODEL`])
      .filter((v) => typeof v === 'string' && v))];
    if (mapped.length) return mapped;
    throw new Error('模型列表不可得：网关不支持 /v1/models 且未配置默认模型映射');
  },

  // 跑一个 turn：文本增量、思考增量、工具调用、审批、结果全部经 emit 出去。
  // 结束保证发 turn_end；signal 已中止时 stopReason='cancelled'。
  async startTurn(session, text, { emit, signal, onPermission }) {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    let streamed = 0;
    const toolSeen = new Set();
    const toolT0 = new Map(); // tool_use id -> 开始时间戳，tool_result 到达时算耗时

    const options = {
      ...baseQueryOptions(session),
      abortController: abort,
      canUseTool: async (toolName, input) => {
        const outcome = await onPermission({ title: toolName, detail: summarizeInput(input) });
        if (outcome === 'allow') return { behavior: 'allow', updatedInput: input };
        return { behavior: 'deny', message: '用户在 Vela 中拒绝了该操作' };
      },
    };

    try {
      for await (const message of query({ prompt: text, options })) {
        if (signal.aborted) break;
        switch (message.type) {
          case 'system':
            if (message.subtype === 'init' && message.session_id) {
              session.agentSessionId = message.session_id;
              emit({ kind: 'session_info', agentSessionId: message.session_id });
            }
            break;
          case 'stream_event': {
            const ev = message.event ?? {};
            if (ev.type === 'content_block_delta' && ev.delta) {
              if (ev.delta.type === 'text_delta' && ev.delta.text) {
                streamed += ev.delta.text.length;
                emit({ kind: 'message_chunk', text: ev.delta.text });
              } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
                emit({ kind: 'thought_chunk', text: ev.delta.thinking });
              }
            } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
              const id = ev.content_block.id;
              if (!toolSeen.has(id)) {
                toolSeen.add(id);
                toolT0.set(id, Date.now());
                // parent_tool_use_id 非空 = 子智能体内部的工具调用，前端按它归组
                emit({ kind: 'tool_call', id, title: toolTitle(ev.content_block.name, {}), parentId: message.parent_tool_use_id || '' });
              }
            }
            break;
          }
          case 'assistant': {
            // 完整 tool_use 块在此有全量 input：未见的补发 tool_call，
            // 已见的发 tool_call_update 补 detail（流事件起步时 input 还是空的）
            for (const block of message.message?.content ?? []) {
              if (block.type !== 'tool_use') continue;
              const input = block.input ?? {};
              if (!toolSeen.has(block.id)) {
                toolSeen.add(block.id);
                toolT0.set(block.id, Date.now());
                emit({ kind: 'tool_call', id: block.id, title: toolTitle(block.name, input), detail: formatToolInput(input), parentId: message.parent_tool_use_id || '' });
              } else {
                emit({ kind: 'tool_call_update', id: block.id, title: toolTitle(block.name, input), detail: formatToolInput(input) });
              }
            }
            break;
          }
          case 'user': {
            for (const block of message.message?.content ?? []) {
              if (block.type === 'tool_result') {
                const t0 = toolT0.get(block.tool_use_id);
                toolT0.delete(block.tool_use_id);
                emit({
                  kind: 'tool_call_update',
                  id: block.tool_use_id,
                  status: block.is_error ? 'failed' : 'completed',
                  result: formatToolResult(block.content),
                  ...(t0 != null ? { durationMs: Date.now() - t0 } : {}),
                });
              }
            }
            break;
          }
          case 'result': {
            // 无增量（如纯工具轮次后直接出结果）时兜底整段输出
            if (streamed === 0 && message.subtype === 'success' && message.result) {
              emit({ kind: 'message_chunk', text: message.result });
              streamed += 1;
            }
            if (typeof message.total_cost_usd === 'number' || typeof message.duration_ms === 'number') {
              emit({
                kind: 'usage',
                ...(typeof message.total_cost_usd === 'number' ? { costUSD: message.total_cost_usd } : {}),
                ...(typeof message.duration_ms === 'number' ? { durationMs: message.duration_ms } : {}),
              });
            }
            break;
          }
          default:
            break; // 未知消息类型丢弃
        }
      }
      emit({ kind: 'turn_end', stopReason: signal.aborted ? 'cancelled' : 'end' });
    } catch (err) {
      if (signal.aborted) {
        emit({ kind: 'turn_end', stopReason: 'cancelled' });
      } else {
        emit({ kind: 'turn_end', stopReason: 'error', error: err?.message || String(err) });
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  },
};

function toolTitle(name, input) {
  const detail = summarizeInput(input);
  return detail ? `${name}: ${detail}` : `${name}`;
}

// 审批卡与工具行的单行摘要：挑最有辨识度的字段，截 120 字符
function summarizeInput(input) {
  const s = typeof input === 'string' ? input
    : input?.command || input?.file_path || input?.path || input?.pattern || input?.url || input?.prompt || '';
  const line = String(s).replace(/\s+/g, ' ').trim();
  return line.length > 120 ? line.slice(0, 117) + '…' : line;
}

// 步骤详情的完整输入：逐键一行 `key: value`（标量原样，其余 JSON 化），截 1200 字符
function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input !== 'object') return capLine(String(input), 1200);
  const lines = [];
  for (const [k, v] of Object.entries(input)) {
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    lines.push(`${k}: ${String(val).replace(/\s+/g, ' ').trim()}`);
  }
  return capLine(lines.join('\n'), 1200);
}

// 步骤详情的工具结果：content 为字符串或 [{type:'text',text}] 块数组，截 2500 字符
function formatToolResult(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? (b.text ?? '') : JSON.stringify(b))).join('\n');
  } else if (content != null) text = JSON.stringify(content);
  return capLine(text.trim(), 2500);
}

function capLine(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
