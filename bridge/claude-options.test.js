// baseQueryOptions：system prompt 追加引导 + 会话字段透传。
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseQueryOptions, LARGE_TASK_HINT } from './agents/claude.js';

test('systemPrompt 在 preset 后追加大任务引导', () => {
  const o = baseQueryOptions({ cwd: '', contextDirs: [], agentSessionId: '', permissionMode: 'bypassPermissions', model: '' });
  assert.equal(o.systemPrompt.type, 'preset');
  assert.equal(o.systemPrompt.preset, 'claude_code');
  assert.equal(o.systemPrompt.append, LARGE_TASK_HINT);
  assert.match(LARGE_TASK_HINT, /parallel Task subagents/);
});

test('会话字段透传：cwd / 上下文目录 / 续接 / 权限模式 / 模型', () => {
  const o = baseQueryOptions({
    cwd: 'E:/code/flink',
    contextDirs: ['E:/ws/knowledge'],
    agentSessionId: 'agent-s1',
    permissionMode: 'acceptEdits',
    model: 'glm-5.3-flash',
  });
  assert.equal(o.cwd, 'E:/code/flink');
  assert.deepEqual(o.additionalDirectories, ['E:/ws/knowledge']);
  assert.equal(o.resume, 'agent-s1');
  assert.equal(o.permissionMode, 'acceptEdits');
  assert.equal(o.model, 'glm-5.3-flash');
});

test('空会话回退：cwd 落 homedir，resume/model 不带字段', () => {
  const o = baseQueryOptions({ cwd: '', contextDirs: [], agentSessionId: '', permissionMode: '', model: '' });
  assert.equal(o.cwd.length > 0, true);
  assert.equal(o.additionalDirectories, undefined);
  assert.equal(o.resume, undefined);
  assert.equal(o.model, undefined);
  assert.equal(o.permissionMode, 'default');
});
