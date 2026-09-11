const { invoke } = window.__TAURI__.core;
const $ = (selector) => document.querySelector(selector);

const state = {
  profiles: [],
  selectedProfiles: [],
  preflight: null,
  joinTimer: null,
  watcherTimer: null,
  verifyTimer: null,
  joinRunning: false,
  watcherRunning: false,
  verifyRunning: false,
  joinLogHidden: false,
};

function parseJson(text) {
  const value = String(text ?? '').trim();
  if (!value) return {};
  return JSON.parse(value);
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((element) => element.classList.toggle('active', element.id === `screen-${name}`));
  document.querySelectorAll('.tab').forEach((element) => {
    const active = element.dataset.screen === name;
    element.classList.toggle('active', active);
    element.setAttribute('aria-selected', String(active));
  });
  if (name === 'settings') loadConfig();
  if (name === 'watch') {
    refreshWatcher();
    refreshVerify();
  }
}

function friendlyError(error) {
  const text = String(error ?? 'Unknown error');
  if (/Aki Watch runtime is missing|runtime script is unavailable|EISDIR.*lstat/i.test(text)) return 'Portable runtime path could not be resolved. Keep aki-watch.exe beside aki-watch-runtime and use the latest portable build.';
  if (/failed to run node|node.*not found|ENOENT.*node/i.test(text)) return 'Node.js was not found. Install Node.js and reopen Aki Watch.';
  if (/python.*not found|failed to run Python|ENOENT.*python|ENOENT.*py/i.test(text)) return 'Python 3 was not found. Install Python 3 and ensure py/python3 is on PATH.';
  if (/selenium/i.test(text) && /missing|not installed|No module/i.test(text)) return 'Selenium is missing. Run: python -m pip install selenium';
  if (/telethon/i.test(text) && /missing|not installed|No module/i.test(text)) return 'Telethon is missing. Run: python -m pip install telethon';
  if (/LibreWolf/i.test(text) && /not found|missing|does not exist/i.test(text)) return 'LibreWolf was not found. Open Settings and choose the LibreWolf executable/profile root.';
  if (/config not found|config is incomplete|missing .*sourceChatId|missing .*telegram/i.test(text)) return 'Configuration is incomplete. Open Settings and complete the required fields.';
  return text;
}

function applyActionGuards() {
  const joinReady = state.preflight?.joinReady === true;
  const watcherReady = state.preflight?.watcherReady === true;
  $('#join-start-btn').disabled = state.joinRunning || !joinReady;
  $('#join-stop-btn').disabled = !state.joinRunning;
  $('#watch-start-btn').disabled = state.watcherRunning || !watcherReady;
  $('#watch-stop-btn').disabled = !state.watcherRunning;
  $('#verify-btn').disabled = state.verifyRunning || !joinReady;
  $('#verify-stop-btn').disabled = !state.verifyRunning;
}

function renderPreflight(data) {
  state.preflight = data;
  const banner = $('#preflight-banner');
  banner.classList.remove('checking', 'ready', 'blocked');
  if (data.joinReady && data.watcherReady) {
    banner.classList.add('ready');
    banner.textContent = `Ready · ${data.profiles} profiles · Python ${data.dependencies?.python || 'OK'} · Selenium ${data.dependencies?.selenium || 'OK'} · geckodriver ${data.dependencies?.geckodriver || 'Selenium Manager'}`;
  } else {
    banner.classList.add('blocked');
    const unique = [...new Map([...(data.joinIssues || []), ...(data.watcherIssues || [])].map((item) => [item.code, item])).values()];
    banner.textContent = `Action required: ${unique.map((item) => item.message).join(' · ')}`;
  }
  applyActionGuards();
}

async function refreshPreflight() {
  const banner = $('#preflight-banner');
  banner.className = 'preflight-banner checking';
  banner.textContent = 'Checking runtime readiness…';
  try {
    const data = parseJson(await invoke('preflight'));
    renderPreflight(data);
    return data;
  } catch (error) {
    const message = friendlyError(error);
    const data = { joinReady: false, watcherReady: false, joinIssues: [{ code: 'preflight_failed', message }], watcherIssues: [{ code: 'preflight_failed', message }] };
    renderPreflight(data);
    return data;
  }
}

function statusClass(status) {
  if (['joined', 'already_joined', 'authenticated'].includes(status)) return 'status-success';
  if (['failed', 'not_signed_in', 'error', 'challenge_page'].includes(status)) return 'status-failed';
  if (['running', 'processing', 'switching_session', 'auto_clicked', 'waiting_transition', 'joined_syncing'].includes(status)) return 'status-running';
  return '';
}

function statusLabel(status) {
  const labels = {
    waiting: 'Waiting',
    running: 'Processing…',
    switching_session: 'Switching account…',
    auto_clicked: 'Auto-confirming…',
    waiting_transition: 'Loading team…',
    joined_syncing: 'Joined · syncing…',
    joined: 'Joined',
    already_joined: 'Already joined',
    failed: 'Failed',
    authenticated: 'Signed in',
    not_signed_in: 'Signed out',
    cloudflare_challenge: 'Challenge page',
    challenge_page: 'Challenge page',
    unknown: 'Unknown',
    error: 'Error',
  };
  return labels[status] || status || 'Ready';
}

function profileKey(row) {
  return row.email || row.dir || row.profile || crypto.randomUUID();
}

function baseRows() {
  return state.profiles.map((profile, index) => ({ ...profile, index: index + 1, status: 'waiting' }));
}

function renderProfilePicker() {
  const picker = $('#profile-picker');
  if (!state.profiles.length) {
    picker.textContent = 'No profiles scanned yet.';
    return;
  }
  const selected = new Set(state.selectedProfiles);
  picker.innerHTML = state.profiles.map((profile) => {
    const value = profile.dir || profile.profile;
    const checked = selected.has(value) || selected.has(profile.profile) ? ' checked' : '';
    return `<label class="profile-choice"><input type="checkbox" name="profilePick" value="${escapeHtml(value)}"${checked}><span><strong>${escapeHtml(profile.email || 'email unknown')}</strong><small>${escapeHtml(profile.profile || value)}</small></span></label>`;
  }).join('');
}

function renderRows(rows) {
  const body = $('#accounts-body');
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="4">No profiles found.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row, index) => {
    const label = statusLabel(row.status);
    const title = row.error ? ` title="${escapeHtml(row.error)}"` : '';
    return `<tr data-key="${escapeHtml(profileKey(row))}"><td>${row.index || index + 1}</td><td>${escapeHtml(row.email || '—')}</td><td>${escapeHtml(row.profile || row.dir || '—')}</td><td class="status-cell ${statusClass(row.status)}"${title}>${escapeHtml(label)}</td></tr>`;
  }).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function rowsFromJoin(data) {
  const rows = baseRows();
  const byEmail = new Map();
  const byProfile = new Map();
  for (const row of rows) {
    if (row.email) byEmail.set(String(row.email).toLowerCase(), row);
    if (row.profile) byProfile.set(row.profile, row);
  }
  const ensure = (event) => {
    const emailKey = event.email ? String(event.email).toLowerCase() : null;
    if (emailKey && byEmail.has(emailKey)) return byEmail.get(emailKey);
    if (event.profile && byProfile.has(event.profile)) {
      const existing = byProfile.get(event.profile);
      if (!existing.email || !event.email || String(existing.email).toLowerCase() === emailKey) {
        if (event.email) {
          existing.email = event.email;
          byEmail.set(emailKey, existing);
        }
        return existing;
      }
    }
    const row = { profile: event.profile || 'unknown', email: event.email || null, index: event.index || rows.length + 1, status: 'waiting' };
    rows.push(row);
    if (emailKey) byEmail.set(emailKey, row);
    if (event.profile && !byProfile.has(event.profile)) byProfile.set(event.profile, row);
    return row;
  };
  for (const event of data.events || []) {
    if (event?.type === 'accounts_discovered') {
      for (const account of event.accounts || []) ensure({ ...account, profile: event.profile });
      continue;
    }
    if (!event?.profile && !event?.email) continue;
    const row = ensure(event);
    if (event.email) row.email = event.email;
    if (event.index) row.index = event.index;
    if (event.type === 'account_start') row.status = 'running';
    if (event.type === 'account_status') row.status = event.status || 'running';
    if (event.type === 'account_done') {
      row.status = event.status || 'failed';
      row.error = event.error || null;
    }
  }
  const resultGroups = [data.result?.joined, data.result?.skipped, data.result?.failed];
  for (const group of resultGroups) {
    for (const result of group || []) {
      const row = ensure(result);
      row.status = result.status || row.status;
      row.error = result.error || row.error;
    }
  }
  return rows.sort((a, b) => (a.index || 999) - (b.index || 999));
}

function renderJoin(data) {
  const rows = rowsFromJoin(data);
  renderRows(rows);
  const totalFromEvents = Math.max(0, ...(data.events || []).map((event) => Number(event.total) || 0));
  const total = totalFromEvents || rows.length;
  const done = (data.events || []).filter((event) => event.type === 'account_done').length || (data.result ? rows.filter((row) => row.status !== 'waiting' && row.status !== 'running').length : 0);
  const joined = data.result?.joined?.length ?? rows.filter((row) => ['joined', 'already_joined'].includes(row.status)).length;
  const failed = data.result?.failed?.length ?? rows.filter((row) => row.status === 'failed').length;
  $('#metric-profiles').textContent = state.profiles.length || total || '—';
  $('#metric-progress').textContent = `${Math.min(done, total)} / ${total}`;
  $('#metric-joined').textContent = joined;
  $('#metric-failed').textContent = failed;
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  $('#join-progress').style.width = `${percent}%`;
  $('#join-progress-track').setAttribute('aria-valuenow', String(percent));
  state.joinRunning = data.running === true;
  applyActionGuards();
  if (data.running) {
    const current = [...(data.events || [])].reverse().find((event) => event.type === 'account_status' || event.type === 'account_start');
    const detail = current?.status ? ` · ${statusLabel(current.status)}` : '';
    $('#join-status').textContent = `Join running${current?.email ? ` — ${current.email}` : current?.profile ? ` — ${current.profile}` : ''}${detail}.`;
  } else if (data.cancelled) {
    $('#join-status').textContent = 'Join cancelled by user.';
  } else if (data.result) {
    $('#join-status').textContent = `Completed: ${joined} joined/already joined · ${failed} failed.`;
  } else if (data.error) {
    $('#join-status').textContent = friendlyError(data.error);
  }
  if (data.log && !state.joinLogHidden) $('#join-log').textContent = data.log;
}

async function scanProfiles() {
  const buttons = [$('#scan-btn'), $('#watch-scan-btn')];
  buttons.forEach((button) => { button.disabled = true; });
  $('#join-status').textContent = 'Scanning LibreWolf profiles…';
  try {
    const result = parseJson(await invoke('profiles_scan'));
    state.profiles = result.profiles || [];
    $('#metric-profiles').textContent = state.profiles.length;
    renderRows(baseRows());
    renderProfilePicker();
    $('#join-status').textContent = `Found ${state.profiles.length} LibreWolf profiles.`;
    $('#profile-health').textContent = state.profiles.map((row, index) => `${index + 1}. ${row.email || 'email unknown'}  —  ${row.profile}`).join('\n') || 'No profiles found.';
    return result;
  } catch (error) {
    const message = friendlyError(error);
    $('#join-status').textContent = `Profile scan failed: ${message}`;
    $('#profile-health').textContent = `Profile scan failed:\n${message}`;
    return null;
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function renderVerify(data) {
  state.verifyRunning = data.running === true;
  const doneEvents = (data.events || []).filter((event) => event.type === 'verify_done');
  const total = Math.max(0, ...(data.events || []).map((event) => Number(event.total) || 0));
  const current = [...(data.events || [])].reverse().find((event) => event.type === 'verify_start');
  const rows = data.result?.results || doneEvents.map((event) => event);
  if (rows.length) {
    $('#profile-health').textContent = rows.map((row) => `${statusLabel(row.authState).padEnd(12)} ${row.email || 'email unknown'}  —  ${row.profile}${row.error ? ` · ${friendlyError(row.error)}` : ''}`).join('\n');
  } else if (data.log) {
    $('#profile-health').textContent = data.log;
  }
  if (data.running) {
    $('#verify-status').textContent = `Verifying ${Math.min(doneEvents.length + 1, total || 1)} / ${total || '?'}${current?.profile ? ` — ${current.profile}` : ''}`;
  } else if (data.cancelled) {
    $('#verify-status').textContent = `Verification cancelled · ${doneEvents.length} profiles completed.`;
  } else if (data.result) {
    $('#verify-status').textContent = `Verification complete · ${rows.length} profiles checked.`;
  } else if (data.error) {
    $('#verify-status').textContent = `Verification failed: ${friendlyError(data.error)}`;
  } else {
    $('#verify-status').textContent = 'No verification running.';
  }
  applyActionGuards();
}

async function refreshVerify() {
  try {
    const result = parseJson(await invoke('verify_status'));
    renderVerify(result);
    if (!result.running && state.verifyTimer) {
      clearInterval(state.verifyTimer);
      state.verifyTimer = null;
    }
    return result;
  } catch (error) {
    $('#verify-status').textContent = `Verification status failed: ${friendlyError(error)}`;
    return null;
  }
}

function ensureVerifyPolling() {
  if (state.verifyTimer) return;
  state.verifyTimer = setInterval(refreshVerify, 750);
}

async function startVerify() {
  const readiness = await refreshPreflight();
  if (!readiness.joinReady) {
    $('#verify-status').textContent = readiness.joinIssues?.[0]?.message || 'Browser prerequisites are not ready.';
    return;
  }
  $('#profile-health').textContent = 'Starting profile verification…';
  try {
    const result = parseJson(await invoke('verify_start'));
    renderVerify(result);
    ensureVerifyPolling();
  } catch (error) {
    $('#verify-status').textContent = `Verify failed: ${friendlyError(error)}`;
  }
}

async function stopVerify() {
  try {
    const result = parseJson(await invoke('verify_stop'));
    renderVerify(result);
  } catch (error) {
    $('#verify-status').textContent = `Stop verify failed: ${friendlyError(error)}`;
  }
}

async function refreshJoin() {
  try {
    const result = parseJson(await invoke('join_status'));
    renderJoin(result);
    if (!result.running && state.joinTimer) {
      clearInterval(state.joinTimer);
      state.joinTimer = null;
    }
    return result;
  } catch (error) {
    $('#join-status').textContent = `Join status failed: ${friendlyError(error)}`;
    return null;
  }
}

function ensureJoinPolling() {
  if (state.joinTimer) return;
  state.joinTimer = setInterval(refreshJoin, 750);
}

async function startJoin() {
  const readiness = await refreshPreflight();
  if (!readiness.joinReady) {
    $('#join-status').textContent = readiness.joinIssues?.[0]?.message || 'Join prerequisites are not ready.';
    return;
  }
  const inviteUrl = $('#invite-url').value.trim();
  if (!inviteUrl) {
    $('#join-status').textContent = 'Paste a Postman invite first.';
    $('#invite-url').focus();
    return;
  }
  $('#join-start-btn').disabled = true;
  $('#join-log').textContent = 'Starting join worker…';
  try {
    if (!state.profiles.length) await scanProfiles();
    const result = parseJson(await invoke('join_start', { inviteUrl }));
    renderJoin(result);
    ensureJoinPolling();
  } catch (error) {
    $('#join-start-btn').disabled = false;
    $('#join-status').textContent = `Could not start: ${friendlyError(error)}`;
  }
}

async function stopJoin() {
  $('#join-stop-btn').disabled = true;
  try {
    const result = parseJson(await invoke('join_stop'));
    renderJoin(result);
  } catch (error) {
    $('#join-status').textContent = `Stop failed: ${friendlyError(error)}`;
  }
}

function renderWatcher(data) {
  const running = data.running === true;
  const degraded = running && data.unresponsive === true;
  state.watcherRunning = running;
  const pill = $('#watcher-pill');
  pill.classList.toggle('running', running && !degraded);
  pill.classList.toggle('degraded', degraded);
  pill.classList.toggle('idle', !running);
  pill.querySelector('strong').textContent = degraded ? 'Watcher unresponsive' : running ? 'Watcher running' : 'Watcher stopped';
  const badge = $('#watch-state');
  badge.classList.toggle('running', running && !degraded);
  badge.classList.toggle('degraded', degraded);
  badge.classList.toggle('idle', !running);
  badge.textContent = degraded ? `Unresponsive · PID ${data.pid}` : running ? `Running · PID ${data.pid}` : 'Stopped';
  applyActionGuards();
  if (degraded) $('#watch-log').textContent = `Watcher process is alive but its local control channel is not responding.\n${data.log || ''}`;
  else if (data.log) $('#watch-log').textContent = data.log;
  else if (!running) $('#watch-log').textContent = 'Watcher is stopped. Start it here — no Aki restart is required.';
}

async function refreshWatcher() {
  try {
    const data = parseJson(await invoke('watcher_status'));
    renderWatcher(data);
    return data;
  } catch (error) {
    $('#watch-log').textContent = `Watcher status failed:\n${friendlyError(error)}`;
    return null;
  }
}

async function startWatcher() {
  const readiness = await refreshPreflight();
  if (!readiness.watcherReady) {
    $('#watch-log').textContent = readiness.watcherIssues?.map((item) => item.message).join('\n') || 'Watcher prerequisites are not ready.';
    return;
  }
  $('#watch-start-btn').disabled = true;
  $('#watch-log').textContent = 'Starting Telegram watcher…';
  try {
    const data = parseJson(await invoke('watcher_start'));
    renderWatcher(data);
  } catch (error) {
    $('#watch-log').textContent = `Watcher start failed:\n${friendlyError(error)}`;
    await refreshWatcher();
  }
}

async function stopWatcher() {
  $('#watch-stop-btn').disabled = true;
  try {
    const data = parseJson(await invoke('watcher_stop'));
    renderWatcher(data);
  } catch (error) {
    $('#watch-log').textContent = `Watcher stop failed:\n${friendlyError(error)}`;
    await refreshWatcher();
  }
}

async function loadConfig() {
  const out = $('#settings-out');
  try {
    const cfg = parseJson(await invoke('get_config'));
    const form = $('#setup-form');
    form.telegramApiId.value = cfg.telegramApiId || '';
    form.sourceChatId.value = cfg.sourceChatId || '';
    form.adminUserIds.value = (cfg.adminUserIds || []).join(', ');
    form.reportChatId.value = cfg.reportChatId || '';
    form.telegramSessionPath.value = cfg.telegramSessionPath || '';
    form.librewolfBinary.value = cfg.librewolfBinary || '';
    form.profilesRoot.value = cfg.profilesRoot || '';
    state.selectedProfiles = cfg.profileDirectories || [];
    renderProfilePicker();
    form.headless.checked = cfg.headless === true;
    form.scratchRoot.value = cfg.scratchRoot || '';
    form.timeoutSeconds.value = cfg.timeoutSeconds || 45;
    form.telegramApiHash.value = '';
    form.reportBotToken.value = '';
    $('#tag-apihash').textContent = cfg.hasApiHash ? 'set' : 'not set';
    $('#tag-token').textContent = cfg.hasReportBotToken ? `set · ${cfg.tokenSource}` : 'not set';
    out.textContent = `Loaded ${cfg.configPath}`;
  } catch (error) {
    out.textContent = `Load failed:\n${friendlyError(error)}`;
  }
}

async function saveConfig(event) {
  event.preventDefault();
  const form = $('#setup-form');
  const out = $('#settings-out');
  const patch = {
    telegramApiId: Number(form.telegramApiId.value) || 0,
    sourceChatId: form.sourceChatId.value.trim(),
    adminUserIds: form.adminUserIds.value.split(',').map((value) => Number(value.trim())).filter((value) => Number.isSafeInteger(value) && value > 0),
    reportChatId: form.reportChatId.value.trim(),
    telegramSessionPath: form.telegramSessionPath.value.trim(),
    librewolfBinary: form.librewolfBinary.value.trim(),
    profilesRoot: form.profilesRoot.value.trim(),
    profileDirectories: [...document.querySelectorAll('input[name="profilePick"]:checked')].map((input) => input.value),
    headless: form.headless.checked,
    scratchRoot: form.scratchRoot.value.trim(),
    timeoutSeconds: Number(form.timeoutSeconds.value) || 45,
  };
  if (form.telegramApiHash.value.trim()) patch.telegramApiHash = form.telegramApiHash.value.trim();
  if (form.reportBotToken.value.trim()) patch.reportBotToken = form.reportBotToken.value.trim();
  out.textContent = 'Saving…';
  try {
    await invoke('save_config', { patch: JSON.stringify(patch) });
    const status = parseJson(await invoke('config_status'));
    out.textContent = `Saved. Required config: ${status.ready ? 'READY' : `missing ${status.missing.join(', ')}`}. No Aki restart is needed for the GUI watcher.`;
    await loadConfig();
    await scanProfiles();
    await refreshPreflight();
  } catch (error) {
    out.textContent = `Save failed:\n${friendlyError(error)}`;
  }
}

async function launchConsole(command, label) {
  const out = $('#telegram-out');
  out.textContent = `${label}…`;
  try { out.textContent = await invoke(command); } catch (error) { out.textContent = `${label} failed:\n${friendlyError(error)}`; }
}

async function listDialogs() {
  const out = $('#telegram-out');
  out.textContent = 'Listing Telegram groups…';
  try { out.textContent = await invoke('list_dialogs'); } catch (error) { out.textContent = `List failed:\n${friendlyError(error)}`; }
}

async function sendTest() {
  const out = $('#telegram-out');
  out.textContent = 'Sending outbound report test…';
  try {
    const result = parseJson(await invoke('send_test'));
    out.textContent = result.ok ? `Test sent to chat ${result.chatId}; message_id=${result.messageId ?? 'n/a'}` : `Test failed: ${result.error}`;
  } catch (error) {
    out.textContent = `Test failed:\n${friendlyError(error)}`;
  }
}

async function environmentCheck() {
  const out = $('#settings-out');
  out.textContent = 'Running environment check…';
  try { out.textContent = await invoke('env_check'); } catch (error) { out.textContent = `Environment check failed:\n${friendlyError(error)}`; }
}

async function pasteInvite() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) $('#invite-url').value = text.trim();
  } catch {
    $('#join-status').textContent = 'Clipboard access was blocked; use Ctrl+V in the invite field.';
    $('#invite-url').focus();
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showScreen(tab.dataset.screen)));
  $('#paste-btn').addEventListener('click', pasteInvite);
  $('#scan-btn').addEventListener('click', scanProfiles);
  $('#watch-scan-btn').addEventListener('click', scanProfiles);
  $('#verify-btn').addEventListener('click', startVerify);
  $('#verify-stop-btn').addEventListener('click', stopVerify);
  $('#join-start-btn').addEventListener('click', startJoin);
  $('#join-stop-btn').addEventListener('click', stopJoin);
  $('#clear-log-btn').addEventListener('click', async () => {
    state.joinLogHidden = !state.joinLogHidden;
    $('#clear-log-btn').textContent = state.joinLogHidden ? 'Show log' : 'Hide log';
    if (state.joinLogHidden) $('#join-log').textContent = 'Log hidden in the UI.';
    else await refreshJoin();
  });
  $('#watch-start-btn').addEventListener('click', startWatcher);
  $('#watch-stop-btn').addEventListener('click', stopWatcher);
  $('#watch-refresh-btn').addEventListener('click', refreshWatcher);
  $('#login-btn').addEventListener('click', () => launchConsole('launch_login', 'Opening Telegram login'));
  $('#observe-btn').addEventListener('click', () => launchConsole('launch_observe', 'Opening sender observer'));
  $('#dialogs-btn').addEventListener('click', listDialogs);
  $('#test-btn').addEventListener('click', sendTest);
  $('#reload-btn').addEventListener('click', loadConfig);
  $('#env-btn').addEventListener('click', environmentCheck);
  $('#setup-form').addEventListener('submit', saveConfig);
  $('#invite-url').addEventListener('keydown', (event) => { if (event.key === 'Enter') startJoin(); });

  await Promise.all([loadConfig(), refreshWatcher(), refreshJoin(), refreshVerify()]);
  const readiness = await refreshPreflight();
  if (readiness.dependencies?.python && readiness.dependencies?.selenium) await scanProfiles();
  state.watcherTimer = setInterval(refreshWatcher, 3000);
  const currentJoin = await refreshJoin();
  if (currentJoin?.running) ensureJoinPolling();
  const currentVerify = await refreshVerify();
  if (currentVerify?.running) ensureVerifyPolling();
});
