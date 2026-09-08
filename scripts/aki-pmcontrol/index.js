/**
 * Postman Automation Daemon & UI Injector
 * 100% Non-Invasive - Controlled via Chrome DevTools Protocol (CDP)
 * Native Gateway Integration (bifrost-premium-https-v4.gw.postman.com)
 */
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { fetchAllUsage } = require('./scripts/cdp-usage');
const { PostmanSession } = require('./scripts/postman-session');
const { loadInstruction, saveInstruction, copyDefaultIfMissing } = require('./scripts/instruction-store');
const daemonPid = require('./scripts/daemon-pid');
const {
  checkForUpdate,
  localSnapshot,
  refreshLocalVersions,
  getLocalVersions,
  RULES_DIR,
} = require('./scripts/update-check');

const AKI_DATA_DIR = process.env.AKI_DATA_DIR || path.join(os.homedir(), '.aki', 'mcpsv');
const PROMPTS_DIR = path.join(AKI_DATA_DIR, 'prompts');
const ASSETS_PROMPTS_DIR = path.join(__dirname, 'assets', 'prompts');
const PROVIDER = 'postman';
const SUM_PROMPT_NAME = 'aki-prompt-sum-to-new-chat.md';
const USER_PROMPT_PATH = path.join(PROMPTS_DIR, `${PROVIDER}.md`);
const DEFAULT_PROMPT_PATH = path.join(ASSETS_PROMPTS_DIR, `${PROVIDER}.md`);
const SHARED_PROMPT_USER_PATH = path.join(PROMPTS_DIR, SUM_PROMPT_NAME);
const SHARED_PROMPT_DEFAULT_PATH = path.join(ASSETS_PROMPTS_DIR, SUM_PROMPT_NAME);
const LEGACY_CDP_DIR = path.join(os.homedir(), '.aki', 'cdp-postman');
const DATA_JSON_PATH = path.join(LEGACY_CDP_DIR, 'data.json');
const LEGACY_INSTRUCTION_PATH = path.join(LEGACY_CDP_DIR, 'aki-postman-instruction.md');
const LEGACY_REPO_INSTRUCTION_PATH = path.join(__dirname, 'data', 'aki-postman-instruction.md');
const RULES_SOURCE_FILE = path.join(RULES_DIR, '.source-repo');
const RULES_CLONE_DIR = path.join(os.homedir(), '.aki', 'akidevrule-src');
const RULES_REPO_URL = 'https://github.com/lacvietanh/akidevrule.git';

const clients = new Map();
let cachedUsageData = null;
let cachedUpdateInfo = localSnapshot();
let akiConfig = null;
let loggedMissingRule = false;
const CHAT_URL_RE = /gateway\.postman\.com\/chat/i;
const TURN_LOG_PATH = path.join(LEGACY_CDP_DIR, 'usage-turns.jsonl');
const convoState = new Map();
let lastGlobalUsageMilli = null;

async function refreshUsageData(customToken = null) {
  cachedUsageData = await fetchAllUsage(customToken);
  return cachedUsageData;
}

function pushUsageToPage(client) {
  client.Runtime.evaluate({
    expression: `
      window.__pmUsageData = ${JSON.stringify(cachedUsageData)};
      if (typeof window.__pmRenderUsageBox === 'function') window.__pmRenderUsageBox();
    `
  }).catch(() => {});
}

function pushInstallRuleResultToPage(client, result) {
  client.Runtime.evaluate({
    expression: `
      window.__pmInstallRuleResult = ${JSON.stringify(result)};
      if (typeof window.__pmRenderInstallRuleResult === 'function') window.__pmRenderInstallRuleResult();
    `
  }).catch(() => {});
}

function pushUpdateInfoToPage(client) {
  client.Runtime.evaluate({
    expression: `
      window.__pmUpdateInfo = ${JSON.stringify(cachedUpdateInfo)};
      if (typeof window.__pmRenderRuleStatus === 'function') window.__pmRenderRuleStatus();
    `
  }).catch(() => {});
}

function pushUpdateInfoToAll() {
  for (const client of clients.values()) pushUpdateInfoToPage(client);
}

function logRuleUpdate(info) {
  const r = info && info.rule;
  if (!r) return;
  if (r.state === 'missing') {
    if (loggedMissingRule) return;
    loggedMissingRule = true;
    console.log('[akidevrule] not installed - press Install in the Aki Control Panel');
    return;
  }
  if (r.state === 'update') {
    console.log(`\x1b[43m\x1b[30m [update] akidevrule ${r.current} → ${r.latest} - update in the Aki Control Panel \x1b[0m`);
  }
}

// Mỗi lượt chat trả về SSE có event `usage` (docs/research/chat-gateway.md). Bắt thẳng tại
// Network.loadingFinished của CDP thay vì polling định kỳ hay patch window.fetch trong trang.
function hookChatUsageCapture(client) {
  const pending = new Map();

  client.Network.requestWillBeSent(async (params) => {
    const req = params.request || {};
    if (req.method !== 'POST' || !CHAT_URL_RE.test(req.url || '')) return;
    const referer = (req.headers && (req.headers.Referer || req.headers.referer)) || '';
    let teamId = null;
    try { teamId = new URL(referer).searchParams.get('teamId'); } catch (e) {}

    let reqConvoId = null;
    let reqModel = null;
    try {
      let post = req.postData;
      if (!post && req.hasPostData) {
        const result = await client.Network.getRequestPostData({ requestId: params.requestId }).catch(() => null);
        post = result && result.postData;
      }
      if (post) {
        const body = JSON.parse(post);
        reqConvoId = (body.input && body.input.conversationId) || null;
        reqModel = (body.devModeOptions && body.devModeOptions.selectedModel) || null;
      }
    } catch (e) {}

    pending.set(params.requestId, { teamId, reqConvoId, reqModel });
  });

  client.Network.loadingFinished(async (params) => {
    if (!pending.has(params.requestId)) return;
    const ctx = pending.get(params.requestId);
    pending.delete(params.requestId);
    try {
      const { body, base64Encoded } = await client.Network.getResponseBody({ requestId: params.requestId });
      applyChatUsageFromSSE(client, base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body, ctx);
    } catch (e) {}
  });

  client.Network.loadingFailed((params) => pending.delete(params.requestId));
}

function applyChatUsageFromSSE(client, sseText, ctx) {
  let latest = null;
  let convo = null;
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const evt = JSON.parse(line.slice(5).trim());
      if (evt.eventType === 'usage' && evt.data && typeof evt.data.limit === 'number') latest = evt.data;
      else if (evt.eventType === 'conversation' && evt.data && evt.data.id) convo = evt.data;
    } catch (e) {}
  }
  if (!latest) return;

  logUsageTurn(ctx, latest, convo);
  if (!cachedUsageData || !Array.isArray(cachedUsageData.teams) || !cachedUsageData.teams.length) return;

  const teamId = ctx && ctx.teamId;
  const team = cachedUsageData.teams.find((t) => String(t.team_id) === String(teamId)) || cachedUsageData.teams[0];
  team.quota = {
    used: Math.ceil((latest.usage || 0) / 1000),
    limit: Math.floor((latest.limit || 0) / 1000),
    percent: latest.limit > 0 ? Math.round(((latest.usage || 0) / latest.limit) * 100) : 0,
    resetAt: (latest.usageCycle && latest.usageCycle.end) || null
  };
  cachedUsageData.updatedAt = new Date().toLocaleTimeString();
  pushUsageToPage(client);
}

function logUsageTurn(ctx, latest, convo) {
  try {
    const usageMilli = latest.usage || 0;
    const convoId = (convo && convo.id) || (ctx && ctx.reqConvoId) || null;
    const model = (ctx && ctx.reqModel) || (convo && convo.modelKey) || null;
    let state = convoId ? convoState.get(convoId) : null;
    let prevUsage;

    if (convoId) {
      if (!state) {
        state = { turns: 0, startUsage: usageMilli, lastUsage: usageMilli };
        convoState.set(convoId, state);
      }
      prevUsage = state.lastUsage;
    } else {
      prevUsage = lastGlobalUsageMilli == null ? usageMilli : lastGlobalUsageMilli;
    }

    const deltaMilli = usageMilli - prevUsage;
    if (state) {
      state.turns += 1;
      state.lastUsage = usageMilli;
    }
    lastGlobalUsageMilli = usageMilli;

    const record = {
      ts: new Date().toISOString(),
      teamId: (ctx && ctx.teamId) || null,
      conversationId: convoId,
      model,
      turn: state ? state.turns : null,
      usageMilli,
      limitMilli: latest.limit || 0,
      deltaMilli,
      cumulativeMilli: state ? usageMilli - state.startUsage : null,
      isTeamPooled: !!latest.isTeamPooled
    };
    fs.mkdirSync(LEGACY_CDP_DIR, { recursive: true });
    fs.appendFileSync(TURN_LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
    const turn = record.turn == null ? '?' : record.turn;
    const cumulative = record.cumulativeMilli == null ? 'n/a' : `${(record.cumulativeMilli / 1000).toFixed(2)}cr`;
    console.log(`[usage] turn=${turn} convo=${convoId ? convoId.slice(0, 8) : 'n/a'} model=${model || '?'} Δ=${(deltaMilli / 1000).toFixed(2)}cr cum=${cumulative}`);
  } catch (e) {}
}

// The daemon's automation contract — auto-click + panel-stays-open must hold on every start
// path (Launch, already-open Postman attach, daemon restart), not merely on first-ever
// creation. A mid-session uncheck lives only in the page's in-memory `config` and never
// becomes the next boot's default.
const FORCED_ON_KEYS = ['autoApprove', 'autoContinue', 'autoRun', 'autoRetry', 'autoRejectPickFolder', 'isPinned', 'autoInjectInstruction'];

// Panel → daemon IPC for the "New window" panel button (scripts/panel.js's
// POST /api/postman-new-window, via postman-mcp.js's requestNewWindow): a flag file next to
// data.json is the smallest transport that works — the panel is the only writer, this is the
// only reader/deleter, and it rides discover()'s existing 1s tick instead of a new interval.
const NEW_WINDOW_FLAG_PATH = path.join(LEGACY_CDP_DIR, 'new-window.flag');

function consumePendingNewWindow() {
  if (!fs.existsSync(NEW_WINDOW_FLAG_PATH)) return;
  try { fs.unlinkSync(NEW_WINDOW_FLAG_PATH); } catch (e) {}
  for (const client of clients.values()) {
    client.Runtime.evaluate({ expression: "window.pm && window.pm.mediator.trigger('newRequesterWindow')" }).catch(() => {});
  }
}

function loadAkiData() {
  let data = null;
  if (fs.existsSync(DATA_JSON_PATH)) {
    try {
      data = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8'));
    } catch (e) {}
  }
  if (!data) data = {};

  let changed = false;
  for (const key of FORCED_ON_KEYS) {
    if (data[key] !== true) { data[key] = true; changed = true; }
  }
  if (data.__v !== 2) { data.__v = 2; changed = true; }
  if (changed) saveAkiData(data);

  akiConfig = data;
  return data;
}

function loadInstructionFile() {
  return loadInstruction([
    USER_PROMPT_PATH,
    LEGACY_INSTRUCTION_PATH,
    LEGACY_REPO_INSTRUCTION_PATH,
    DEFAULT_PROMPT_PATH,
  ]);
}

function saveInstructionFile(text) {
  try {
    saveInstruction(USER_PROMPT_PATH, text);
  } catch (e) {
    console.error('❌ Lỗi ghi file prompts/postman.md:', e.message);
  }
}

function loadSummarizePromptFile() {
  return loadInstruction([SHARED_PROMPT_USER_PATH, SHARED_PROMPT_DEFAULT_PATH]);
}

function init() {
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  if (!loadInstruction([USER_PROMPT_PATH])) {
    const legacyInstruction = loadInstruction([LEGACY_INSTRUCTION_PATH, LEGACY_REPO_INSTRUCTION_PATH]);
    if (legacyInstruction) saveInstruction(USER_PROMPT_PATH, legacyInstruction);
    else copyDefaultIfMissing(USER_PROMPT_PATH, DEFAULT_PROMPT_PATH);
  }
  copyDefaultIfMissing(SHARED_PROMPT_USER_PATH, SHARED_PROMPT_DEFAULT_PATH);
}

function saveAkiData(data) {
  try {
    if (!fs.existsSync(LEGACY_CDP_DIR)) {
      fs.mkdirSync(LEGACY_CDP_DIR, { recursive: true });
    }
    let existing = {};
    if (fs.existsSync(DATA_JSON_PATH)) {
      try {
        existing = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8')) || {};
      } catch (e) {}
    }
    const incoming = data || {};
    const merged = { ...existing, ...incoming };
    delete merged.showUsage;
    delete merged.thinking;
    delete merged.autorun;
    fs.writeFileSync(DATA_JSON_PATH, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    console.error('❌ Lỗi ghi file data.json:', e.message);
  }
}

function runCmd(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, msg: (stderr || err.message || '').trim().slice(-400) });
      else resolve({ ok: true, msg: (stdout || stderr || '(no output)').trim() });
    });
  });
}

// Bắt chước aki-mcp-sv panel.js installRules: .source-repo hoặc clone/pull akidevrule, rồi bash install.sh (unattended — install.py chỉ prompt khi stdin là TTY).
async function installAkiRule() {
  const recorded = fs.existsSync(RULES_SOURCE_FILE) ? fs.readFileSync(RULES_SOURCE_FILE, 'utf8').trim() : null;
  let repo = recorded && fs.existsSync(path.join(recorded, 'install.sh')) ? recorded : null;
  if (!repo) {
    if (fs.existsSync(path.join(RULES_CLONE_DIR, '.git'))) {
      const pull = await runCmd('git', ['-C', RULES_CLONE_DIR, 'pull', '--ff-only']);
      if (!pull.ok) return pull;
    } else {
      fs.mkdirSync(path.dirname(RULES_CLONE_DIR), { recursive: true });
      const clone = await runCmd('git', ['clone', '--depth', '1', RULES_REPO_URL, RULES_CLONE_DIR]);
      if (!clone.ok) return clone;
    }
    repo = RULES_CLONE_DIR;
  }
  const bash = process.platform === 'win32' ? 'bash.exe' : 'bash';
  const install = await runCmd(bash, [path.join(repo, 'install.sh')], repo);
  if (!install.ok && process.platform === 'win32' && /ENOENT|not found/i.test(install.msg)) {
    return { ok: false, msg: 'bash not found — install Git for Windows (includes bash)' };
  }
  const last = (install.msg || '').split('\n').filter(Boolean).pop() || install.msg;
  return { ok: install.ok, msg: `${last} (source: ${repo})`, version: getLocalVersions().current };
}

function getScriptBundle() {
  const autoclickerPath = path.join(__dirname, 'scripts', 'cdp-autoclicker.js');
  let scriptContent = '';
  if (fs.existsSync(autoclickerPath)) {
    scriptContent = fs.readFileSync(autoclickerPath, 'utf8');
  }

  const initialConfig = loadAkiData();
  const configInjection = `
    window.__pmInitialConfig = ${JSON.stringify(initialConfig)};
    window.__pmUsageData = ${JSON.stringify(cachedUsageData)};
    window.__pmUpdateInfo = ${JSON.stringify(cachedUpdateInfo)};
    window.__pmInitialInstruction = ${JSON.stringify(loadInstructionFile())};
  `;

  return configInjection + '\n' + scriptContent;
}

async function setupCDP(target, port) {
  if (clients.has(target.id)) return;

  try {
    const client = await CDP({ target: target.id, port });
    clients.set(target.id, client);

    await client.Page.enable();
    await client.Runtime.enable();
    await client.Network.enable();

    // 0. Usage theo từng lượt chat — bắt tại Network.loadingFinished (SSE event "usage"), không patch window.fetch.
    hookChatUsageCapture(client);

    // 1. Tự động trích xuất access_token trực tiếp từ Postman Desktop (100% Native)
    try {
      const tokenEval = await client.Runtime.evaluate({
        expression: 'localStorage.getItem("access_token")'
      });
      const token = tokenEval && tokenEval.result && tokenEval.result.value;
      if (token) {
        saveAkiData({ access_token: token });
        refreshUsageData(token).then(() => pushUsageToPage(client));
      }
    } catch (e) {}

    // 2. Binding lưu cấu hình từ UI
    try {
      await client.Runtime.addBinding({ name: '__cdpSaveAkiConfig' });
    } catch (e) {}

    // 3. Binding refresh usage
    try {
      await client.Runtime.addBinding({ name: '__cdpRefreshUsage' });
    } catch (e) {}

    // 3b. Binding install/update aki dev rule (chạy git + bash install.sh phía daemon)
    try {
      await client.Runtime.addBinding({ name: '__cdpInstallAkiRule' });
    } catch (e) {}

    // 3c. Binding save instruction text.
    try {
      await client.Runtime.addBinding({ name: '__cdpSaveInstruction' });
    } catch (e) {}

    try {
      await client.Runtime.addBinding({ name: '__cdpRequestSummarize' });
    } catch (e) {}

    client.Runtime.bindingCalled(async (event) => {
      if (event.name === '__cdpSaveAkiConfig') {
        try {
          const newConfig = JSON.parse(event.payload);
          saveAkiData(newConfig);
          akiConfig = { ...akiConfig, ...newConfig };
        } catch (err) {}
      } else if (event.name === '__cdpInstallAkiRule') {
        const result = await installAkiRule();
        if (result.ok) {
          cachedUpdateInfo = refreshLocalVersions(cachedUpdateInfo);
          pushUpdateInfoToPage(client);
        }
        pushInstallRuleResultToPage(client, result);
      } else if (event.name === '__cdpRefreshUsage') {
        let tokenToUse = null;
        if (event.payload && event.payload !== 'refresh') {
          tokenToUse = event.payload;
        }
        if (!tokenToUse) {
          const tokenEval = await client.Runtime.evaluate({
            expression: 'localStorage.getItem("access_token")'
          }).catch(() => null);
          tokenToUse = tokenEval && tokenEval.result && tokenEval.result.value;
        }
        await refreshUsageData(tokenToUse);
        pushUsageToPage(client);
      } else if (event.name === '__cdpSaveInstruction') {
        saveInstructionFile(event.payload);
      } else if (event.name === '__cdpRequestSummarize') {
        const summarizePrompt = loadSummarizePromptFile();
        client.Runtime.evaluate({
          expression: `if (typeof window.__pmDeliverSummarizePrompt === 'function') window.__pmDeliverSummarizePrompt(${JSON.stringify(summarizePrompt)});`
        }).catch(() => {});
      }
    });

    // 4. Chuyển tiếp Console Logs
    client.Runtime.consoleAPICalled((entry) => {
      const msg = entry.args.map((a) => a.value || '').join(' ');
      if (msg.includes('[⚡ AutoRun]')) {
        console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
      }
    });

    await client.Runtime.evaluate({ expression: getScriptBundle() });

    client.Page.loadEventFired(async () => {
      await client.Runtime.evaluate({ expression: getScriptBundle() }).catch(() => {});
    });

    client.on('disconnect', () => {
      clients.delete(target.id);
    });

    console.log(`✅ [CDP] Đã kết nối & nạp sẵn Aki Controller: "${target.title || target.url}"`);
  } catch (e) {
    if (clients.has(target.id)) {
      try {
        const c = clients.get(target.id);
        await c.close();
      } catch (_) {}
      clients.delete(target.id);
    }
  }
}

// Hosts confirmed (from live daemon logs) to be genuine Postman app/product surfaces —
// the main desktop shell and the billing views this daemon's own "View on team" button opens.
// Anything else (marketing/promo popups like "Welcome to the Postman API Network", external
// OAuth pages, ...) is left alone: no panel injected, no clutter.
const KNOWN_POSTMAN_HOSTS = ['desktop.postman.com', 'app.getpostman.com', 'postman.co'];

function isKnownPostmanSurface(url) {
  if (!url) return false; // mid-navigation targets: skip this tick, re-checked on the next
  try {
    const host = new URL(url).hostname;
    return KNOWN_POSTMAN_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
  } catch (e) {
    return false;
  }
}

async function discover() {
  consumePendingNewWindow();
  const port = PostmanSession.getDevToolsPort();
  try {
    const targets = await CDP.List({ port });
    for (const target of targets) {
      if (target.type === 'page' && isKnownPostmanSurface(target.url)) {
        await setupCDP(target, port);
      }
    }
  } catch (e) {}
}

// Undoes what setupCDP's Runtime.evaluate injected (cdp-autoclicker.js): without this, the
// auto-click loop and the floating panel keep running live inside Postman's own renderer after
// the daemon exits, because they no longer depend on the CDP connection once evaluated.
const TEARDOWN_SCRIPT = `
  if (window.__pmMasterInterval) clearInterval(window.__pmMasterInterval);
  document.getElementById('aki-control-panel')?.remove();
  document.getElementById('aki-vertical-trigger')?.remove();
  document.getElementById('aki-status-bar-slot')?.remove();
  document.getElementById('aki-injected-styles')?.remove();
`;

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const teardowns = [...clients.values()].map((client) =>
    Promise.race([
      client.Runtime.evaluate({ expression: TEARDOWN_SCRIPT }),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]).catch(() => {})
  );
  await Promise.all(teardowns);
  for (const client of clients.values()) {
    try { client.close(); } catch { /* already gone */ }
  }
  clients.clear();
  daemonPid.release();
  process.exit(0);
}
process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });
process.on('exit', () => daemonPid.release());

async function main() {
  daemonPid.claim();
  console.log('⚡ Postman CDP Daemon — non-invasive, native gateway');

  init();
  loadAkiData();
  logRuleUpdate(cachedUpdateInfo);
  checkForUpdate().then((info) => {
    cachedUpdateInfo = info;
    logRuleUpdate(info);
    pushUpdateInfoToAll();
  }).catch(() => {});

  await PostmanSession.ensureRunning();
  await refreshUsageData();

  setInterval(discover, 1000);
  discover();
}

main();
