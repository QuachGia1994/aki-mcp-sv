import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_XKIRO_MODEL, runXKiroRead, executeXKiroReadTool, ensureFreeXKiroModel } from '../scripts/xkiro-mcp.js';
import { buildDefaultAgentProviders } from '../scripts/agent-mcp.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function withXKiroEnv(fn) {
  const oldKey = process.env.XKIRO_API_KEY;
  const oldModel = process.env.XKIRO_MODEL;
  process.env.XKIRO_API_KEY = 'sk-xt-test-only';
  process.env.XKIRO_MODEL = DEFAULT_XKIRO_MODEL;
  return Promise.resolve(fn()).finally(() => {
    if (oldKey === undefined) delete process.env.XKIRO_API_KEY; else process.env.XKIRO_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.XKIRO_MODEL; else process.env.XKIRO_MODEL = oldModel;
  });
}

test('xKiro read worker performs bounded OpenAI tool-calling loop and returns usage metadata', async () => withXKiroEnv(async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: DEFAULT_XKIRO_MODEL, access_tier: 'free' }] });
    if (String(url).endsWith('/usage')) return jsonResponse({ free_tokens: { used_today: 10, limit_per_day: 5_000_000, remaining: 4_999_990 } });
    const chatCalls = requests.filter((r) => r.url.endsWith('/chat/completions')).length;
    if (chatCalls === 1) {
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_text_file', arguments: '{"path":"package.json","head":20}' } }] }, finish_reason: 'tool_calls' }],
        usage: { total_tokens: 111 },
      });
    }
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Evidence complete.' }, finish_reason: 'stop' }], usage: { total_tokens: 222 } });
  };
  const toolCalls = [];
  const result = await runXKiroRead(
    { prompt: 'Inspect package metadata', cwd: process.cwd(), maxSteps: 4 },
    { fetchImpl, toolExecutor: async (name, args, dir) => { toolCalls.push({ name, args, dir }); return '{"name":"mcp-local"}'; } },
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Evidence complete\./);
  assert.match(result.content[0].text, /333 tokens · 1 tool calls/);
  assert.deepEqual(toolCalls.map((c) => c.name), ['read_text_file']);
  const secondChat = requests.filter((r) => r.url.endsWith('/chat/completions'))[1].body;
  assert.equal(secondChat.messages.at(-1).role, 'tool');
  assert.equal(secondChat.messages.at(-1).tool_call_id, 'call_1');
  assert.equal(secondChat.reasoning_effort, 'none');
  assert.ok(secondChat.tools.length <= 20, 'xKiro docs recommend keeping the tool set below ~20');
}));

test('xKiro free-only policy rejects non-free catalog models before chat', async () => {
  const fetchImpl = async () => jsonResponse({ data: [{ id: 'paid/model', access_tier: 'paid' }] });
  await assert.rejects(() => ensureFreeXKiroModel('paid/model', { fetchImpl }), /free-only policy/);
});

test('xKiro free-only guard stops before chat when free quota is too low', async () => withXKiroEnv(async () => {
  let chatRequests = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: DEFAULT_XKIRO_MODEL, access_tier: 'free' }] });
    if (String(url).endsWith('/usage')) return jsonResponse({ free_tokens: { used_today: 4_999_950, limit_per_day: 5_000_000, remaining: 50 } });
    chatRequests += 1;
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'must not run' } }] });
  };
  const result = await runXKiroRead({ prompt: 'Inspect package metadata', cwd: process.cwd() }, { fetchImpl });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /free-only guard stopped before step 1/);
  assert.equal(chatRequests, 0, 'paid/wallet fallback must never receive a chat request when free quota is insufficient');
}));

test('xKiro read tools cannot escape the worker cwd', async () => {
  await assert.rejects(() => executeXKiroReadTool('read_text_file', { path: '..\\outside.txt' }, process.cwd()), /escapes worker cwd/);
});

test('agent_read prefers configured xKiro before local fallback workers', async () => withXKiroEnv(async () => {
  const providers = buildDefaultAgentProviders('inspect', process.cwd()).map(([name]) => name);
  assert.deepEqual(providers.slice(0, 4), ['xkiro', 'agy', 'kiro', 'opencode']);
}));
