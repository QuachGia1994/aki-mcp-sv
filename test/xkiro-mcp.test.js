import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_XKIRO_MODEL, chooseXKiroModel, ensureFreeXKiroModel, executeXKiroReadTool, listFreeXKiroModels, runXKiroRead } from '../scripts/xkiro-mcp.js';
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
    if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: DEFAULT_XKIRO_MODEL, display_name: 'MiniMax M3', owned_by: 'minimax', access_tier: 'free', capabilities: { tools: true } }] });
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

test('xKiro model policy rejects paid or non-tool models before chat', async () => {
  const paidFetch = async () => jsonResponse({ data: [{ id: 'paid/model', access_tier: 'paid', capabilities: { tools: true } }] });
  const noToolsFetch = async () => jsonResponse({ data: [{ id: 'free/no-tools', access_tier: 'free', capabilities: { tools: false } }] });
  await assert.rejects(() => ensureFreeXKiroModel('paid/model', { fetchImpl: paidFetch }), /free-only policy/);
  await assert.rejects(() => ensureFreeXKiroModel('free/no-tools', { fetchImpl: noToolsFetch }), /does not support tool calling/);
});

test('xKiro free-only guard stops before chat when free quota is too low', async () => withXKiroEnv(async () => {
  let chatRequests = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: DEFAULT_XKIRO_MODEL, display_name: 'MiniMax M3', owned_by: 'minimax', access_tier: 'free', capabilities: { tools: true } }] });
    if (String(url).endsWith('/usage')) return jsonResponse({ free_tokens: { used_today: 4_999_950, limit_per_day: 5_000_000, remaining: 50 } });
    chatRequests += 1;
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'must not run' } }] });
  };
  const result = await runXKiroRead({ prompt: 'Inspect package metadata', cwd: process.cwd() }, { fetchImpl });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /free-only guard stopped before step 1/);
  assert.equal(chatRequests, 0, 'paid/wallet fallback must never receive a chat request when free quota is insufficient');
}));

test('xKiro live catalog exposes only free tool-calling models and preserves display metadata', async () => {
  const fetchImpl = async () => jsonResponse({ data: [
    { id: 'free/tools', display_name: 'Free Tools', owned_by: 'vendor', access_tier: 'free', capabilities: { tools: true, reasoning: true }, context_length: 262144, max_output_tokens: 65536 },
    { id: 'free/no-tools', display_name: 'Free No Tools', owned_by: 'vendor', access_tier: 'free', capabilities: { tools: false } },
    { id: 'paid/tools', display_name: 'Paid Tools', owned_by: 'vendor', access_tier: 'paid', capabilities: { tools: true } },
  ] });
  const models = await listFreeXKiroModels({ fetchImpl });
  assert.deepEqual(models.map((model) => model.id), ['free/tools']);
  assert.deepEqual(models[0], { id: 'free/tools', name: 'Free Tools', provider: 'vendor', context: 262144, output: 65536, reasoning: true, vision: false });
});

test('xKiro model choice keeps a valid selection and falls back only within free tool-capable catalog', () => {
  const models = [{ id: 'free/first' }, { id: DEFAULT_XKIRO_MODEL }];
  assert.equal(chooseXKiroModel('free/first', models), 'free/first');
  assert.equal(chooseXKiroModel('removed/model', models), DEFAULT_XKIRO_MODEL);
  assert.equal(chooseXKiroModel('removed/model', [{ id: 'free/only' }]), 'free/only');
  assert.throws(() => chooseXKiroModel('removed/model', []), /no free tool-calling model/);
});

test('xKiro read tools cannot escape the worker cwd', async () => {
  await assert.rejects(() => executeXKiroReadTool('read_text_file', { path: '..\\outside.txt' }, process.cwd()), /escapes worker cwd/);
});

test('agent_read prefers configured xKiro before local fallback workers', async () => withXKiroEnv(async () => {
  const providers = buildDefaultAgentProviders('inspect', process.cwd()).map(([name]) => name);
  assert.deepEqual(providers.slice(0, 4), ['xkiro', 'agy', 'kiro', 'opencode']);
}));

test('xKiro tab uses the bundled xKiro web favicon and a live free-model selector', () => {
  const panelSource = fs.readFileSync(new URL('../scripts/config-page.js', import.meta.url), 'utf8');
  const clientSource = fs.readFileSync(new URL('../public/panel-client.js', import.meta.url), 'utf8');
  assert.match(panelSource, /data-tab="xkiro"><img src="\/img\/providers\/xkiro\.ico" class="provider-icon" alt="">xKiro<\/button>/);
  assert.match(panelSource, /<select id="xkiroModel">/);
  assert.match(panelSource, /data-act="refreshXKiro">Refresh models<\/button>/);
  assert.doesNotMatch(panelSource, /type="text" id="xkiroModel"/);
  assert.match(clientSource, /\/api\/xkiro-refresh/);
  assert.match(clientSource, /state\?\.freeModels/);
  const icon = fs.readFileSync(new URL('../public/img/providers/xkiro.ico', import.meta.url));
  assert.ok(icon.length > 1000, 'xKiro favicon should be a real bundled asset');
  assert.deepEqual([...icon.subarray(0, 4)], [0, 0, 1, 0], 'asset should have a valid ICO header');
});
