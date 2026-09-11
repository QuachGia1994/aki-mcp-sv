#!/usr/bin/env node
// Guided setup for Aki Watch (Postman pool auto-join). Orchestrates the proven
// scripts and reuses their config loader; it never reimplements the automation
// and never prints secret values (Telegram api hash / bot token) to the terminal.
// The human-only steps it cannot skip live in docs/ref/aki-watch-onboarding.md.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  POSTMAN_POOL_CONFIG_PATH,
  getPostmanPoolConfigStatus,
  resolveReportCredentials,
  sendPostmanPoolReportMessage,
} from './postman-pool.js';

const TELEGRAM_SCRIPT = fileURLToPath(new URL('./postman-pool-telegram.py', import.meta.url));
const JOIN_SCRIPT = fileURLToPath(new URL('./postman-pool-join.py', import.meta.url));
const IS_WIN = process.platform === 'win32';
const PY = IS_WIN ? 'py' : 'python3';
const PY_PREFIX = IS_WIN ? ['-3'] : [];

function redactToken(value) {
  return String(value == null ? '' : value).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>');
}

function pyCapture(args) {
  const res = spawnSync(PY, [...PY_PREFIX, ...args], { encoding: 'utf8', windowsHide: true });
  if (res.error) return { ok: false, text: res.error.message };
  return { ok: res.status === 0, text: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

function pyInherit(args) {
  // -X utf8 keeps emoji-titled Telegram groups from crashing the Windows console codec.
  return spawnSync(PY, [...PY_PREFIX, '-X', 'utf8', ...args], { stdio: 'inherit', windowsHide: true }).status ?? 1;
}

function moduleVersion(name) {
  const res = pyCapture(['-c', `import ${name}; print(getattr(${name}, "__version__", "installed"))`]);
  return res.ok ? res.text : null;
}

function readConfig(configPath) {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(configPath, config) {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function withDefaults(config) {
  const dir = path.dirname(POSTMAN_POOL_CONFIG_PATH);
  const { chromeBinary: _chromeBinary, chromeUserDataRoot: _chromeUserDataRoot, chromeProfileDirectories: _chromeProfileDirectories, browserBackend: _browserBackend, profileRoot: _profileRoot, ...current } = config || {};
  return {
    enabled: false,
    telegramApiId: 0,
    telegramApiHash: '',
    telegramSessionPath: path.join(dir, 'telegram-user.session'),
    sourceChatId: '',
    adminUserIds: [],
    reportBotToken: '',
    reportChatId: '',
    librewolfBinary: IS_WIN ? 'C:\\Program Files\\LibreWolf\\librewolf.exe' : '',
    profilesRoot: '',
    profileDirectories: [],
    headless: false,
    scratchRoot: '',
    timeoutSeconds: 45,
    manualVerificationSeconds: 300,
    ...current,
  };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

// Non-secret view of the config for prefilling the GUI form: secret values
// (telegramApiHash, reportBotToken) are reported only as booleans, never echoed.
function configView(configPath) {
  const raw = readConfig(configPath);
  const status = getPostmanPoolConfigStatus(configPath);
  return {
    configPath,
    enabled: raw.enabled === true,
    telegramApiId: Number(raw.telegramApiId) || 0,
    hasApiHash: Boolean(raw.telegramApiHash),
    telegramSessionPath: raw.telegramSessionPath || '',
    sourceChatId: raw.sourceChatId ? String(raw.sourceChatId) : '',
    adminUserIds: Array.isArray(raw.adminUserIds) ? raw.adminUserIds : [],
    hasReportBotToken: !status.missing.includes('reportBotToken'),
    tokenSource: status.tokenSource,
    reportChatId: raw.reportChatId ? String(raw.reportChatId) : '',
    librewolfBinary: raw.librewolfBinary || '',
    profilesRoot: raw.profilesRoot || '',
    profileDirectories: Array.isArray(raw.profileDirectories) ? raw.profileDirectories : [],
    headless: raw.headless === true,
    scratchRoot: raw.scratchRoot || '',
    timeoutSeconds: Number(raw.timeoutSeconds) || 45,
    manualVerificationSeconds: Number(raw.manualVerificationSeconds) || 300,
  };
}

async function setConfigFromStdin(configPath) {
  const patchRaw = await readStdin();
  const patch = patchRaw.trim() ? JSON.parse(patchRaw) : {};
  const merged = withDefaults({ ...readConfig(configPath), ...patch });
  if (Array.isArray(merged.adminUserIds)) {
    merged.adminUserIds = merged.adminUserIds.map((n) => Number(n)).filter((n) => Number.isSafeInteger(n) && n > 0);
  }
  merged.telegramApiId = Number(merged.telegramApiId) || 0;
  merged.profileDirectories = Array.isArray(merged.profileDirectories) ? merged.profileDirectories.map(String).filter(Boolean) : [];
  writeConfig(configPath, merged);
}

async function sendTestReport(configPath) {
  const status = getPostmanPoolConfigStatus(configPath);
  if (status.missing.includes('reportBotToken') || status.missing.includes('reportChatId')) {
    console.log(JSON.stringify({ ok: false, error: `missing ${status.missing.join(', ')}` }));
    return;
  }
  const creds = resolveReportCredentials(configPath);
  try {
    const result = await sendPostmanPoolReportMessage(creds, 'Aki Watch: outbound test message (sendMessage only).');
    console.log(JSON.stringify({ ok: true, chatId: creds.reportChatId, tokenSource: creds.tokenSource, messageId: result?.message_id ?? null }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: redactToken(error?.message || String(error)) }));
  }
}

function browserArgsFromConfig(config) {
  const args = [];
  if (config.librewolfBinary) args.push('--librewolf-binary', config.librewolfBinary);
  if (config.profilesRoot) args.push('--profiles-root', config.profilesRoot);
  for (const profile of config.profileDirectories || []) args.push('--profile-directory', profile);
  if (config.scratchRoot) args.push('--scratch-root', config.scratchRoot);
  return args;
}

function geckodriverStatus() {
  const code = 'from pathlib import Path; import shutil; p=shutil.which("geckodriver"); r=Path.home()/".cache"/"selenium"/"geckodriver"; h=[str(x) for x in r.rglob("geckodriver*") if x.is_file()] if r.exists() else []; print(p or (h[-1] if h else "managed-by-selenium-manager"))';
  const result = pyCapture(['-c', code]);
  return result.ok ? result.text : 'unknown';
}

function preflightView(configPath) {
  const configExists = existsSync(configPath);
  const raw = withDefaults(readConfig(configPath));
  const status = getPostmanPoolConfigStatus(configPath);
  const pyVer = pyCapture(['--version']);
  const telethon = moduleVersion('telethon');
  const selenium = moduleVersion('selenium');
  const scan = pyVer.ok ? pyCapture([JOIN_SCRIPT, ...browserArgsFromConfig(raw), '--dry-run']) : { ok: false, text: 'Python not found' };
  let scanData = null;
  if (scan.ok) {
    try { scanData = JSON.parse(scan.text.split(/\r?\n/).filter(Boolean).at(-1) || '{}'); } catch {}
  }
  const joinIssues = [];
  if (!configExists) joinIssues.push({ code: 'config_missing', message: 'Save Settings once to create the local Aki Watch config.' });
  if (!pyVer.ok) joinIssues.push({ code: 'python_missing', message: 'Python 3 is required. Install Python 3 and ensure py/python3 is on PATH.' });
  if (!selenium) joinIssues.push({ code: 'selenium_missing', message: 'Selenium is missing. Install with: python -m pip install selenium' });
  if (!scan.ok) joinIssues.push({ code: 'browser_scan_failed', message: scan.text || 'LibreWolf/profile discovery failed.' });
  else if (!(scanData?.profiles?.length > 0)) joinIssues.push({ code: 'profiles_missing', message: 'No valid LibreWolf profiles were found.' });
  if (raw.headless) joinIssues.push({ code: 'headless_manual_verify', message: 'Headless is blocked because Human Verify requires a visible LibreWolf window.' });

  const watcherIssues = [...joinIssues];
  if (!telethon) watcherIssues.push({ code: 'telethon_missing', message: 'Telethon is missing. Install with: python -m pip install telethon' });
  if (!status.ready) watcherIssues.push({ code: 'config_incomplete', message: `Complete Settings: ${status.missing.join(', ')}` });

  return {
    ready: joinIssues.length === 0 && watcherIssues.length === 0,
    joinReady: joinIssues.length === 0,
    watcherReady: watcherIssues.length === 0,
    joinIssues,
    watcherIssues,
    issues: watcherIssues,
    headless: raw.headless === true,
    configReady: status.ready,
    missingConfig: status.missing,
    dependencies: {
      node: process.version,
      python: pyVer.ok ? pyVer.text : null,
      telethon,
      selenium,
      geckodriver: pyVer.ok ? geckodriverStatus() : null,
      librewolfBinary: scanData?.librewolfBinary || raw.librewolfBinary || null,
    },
    profiles: scanData?.profiles?.length || 0,
    profilesRoot: scanData?.profilesRoot || raw.profilesRoot || null,
  };
}

function printCheck(configPath) {
  const status = getPostmanPoolConfigStatus(configPath);
  const raw = readConfig(configPath);
  const pyVer = pyCapture(['--version']);
  const librewolf = raw.librewolfBinary || '';
  console.log('Aki Watch - environment check\n');
  const line = (k, v) => console.log(`  ${String(k).padEnd(18)} ${v}`);
  line('node', process.version);
  line(`${PY} ${PY_PREFIX.join(' ')}`.trim(), pyVer.ok ? pyVer.text : 'NOT FOUND');
  line('telethon', moduleVersion('telethon') || 'NOT INSTALLED (py -3 -m pip install telethon)');
  line('selenium', moduleVersion('selenium') || 'NOT INSTALLED (py -3 -m pip install selenium)');
  line('librewolf', librewolf ? (existsSync(librewolf) ? librewolf : `MISSING: ${librewolf}`) : 'auto-discover');
  line('profilesRoot', raw.profilesRoot || 'auto-detect (%APPDATA%/librewolf/Profiles)');
  console.log(`\nConfig: ${configPath}`);
  line('watcher owner', 'Aki Watch GUI');
  line('legacy enabled', status.enabled);
  line('sourceChatId', status.sourceChatId || '(missing)');
  line('adminUserIds', status.adminUserIds.length ? status.adminUserIds.join(', ') : '(missing)');
  line('reportChatId', status.reportChatId || '(missing)');
  line('reportBotToken', status.missing.includes('reportBotToken') ? '(missing)' : `present (source: ${status.tokenSource})`);
  line('missing', status.missing.length ? status.missing.join(', ') : 'none');
  console.log(`\n  ready to enable    ${status.ready ? 'YES' : 'NO'}`);
}

async function runSetup(configPath) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question, def) => {
    const shown = def !== undefined && def !== '' ? `${question} [${def}]: ` : `${question}: `;
    const answer = (await rl.question(shown)).trim();
    return answer || (def ?? '');
  };
  const yes = async (question) => /^y(es)?$/i.test((await rl.question(`${question} (y/N): `)).trim());
  try {
    console.log('Aki Watch guided setup. Secrets are written to the local config only, never printed.');
    console.log(`Config: ${configPath}`);
    console.log('Human-only steps (my.telegram.org, @BotFather, Postman logins): docs/ref/aki-watch-onboarding.md\n');

    let config = withDefaults(readConfig(configPath));

    console.log('Step 1 - Telegram API credentials: open https://my.telegram.org/apps and create an app.');
    config.telegramApiId = Number(await ask('telegramApiId', config.telegramApiId || '')) || config.telegramApiId;
    const apiHash = await ask('telegramApiHash (stays local)', config.telegramApiHash ? '(keep existing)' : '');
    if (apiHash && apiHash !== '(keep existing)') config.telegramApiHash = apiHash;
    writeConfig(configPath, config);

    if (await yes('Step 2 - Run Telegram login now to create the session and list your groups?')) {
      pyInherit([TELEGRAM_SCRIPT, '--login', '--config', configPath]);
    }
    console.log('From the SELF line printed above, note your own userId (used for a self-DM reportChatId).');

    config.sourceChatId = String(await ask('Step 3 - sourceChatId (paste the group chatId from the list)', config.sourceChatId));
    writeConfig(configPath, config);

    if (await yes('Step 4 - Observe the group to capture the admin sender ID? (admin posts a message; Ctrl+C to stop)')) {
      pyInherit([TELEGRAM_SCRIPT, '--observe-senders', '--config', configPath]);
    }
    const admins = await ask('adminUserIds (comma-separated numeric IDs)', config.adminUserIds.join(','));
    config.adminUserIds = admins.split(',').map((part) => Number(part.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
    writeConfig(configPath, config);

    console.log('Step 5 - Report bot token from @BotFather (/newbot), or reuse an existing outbound bot.');
    console.log('Leave blank to supply it via env AKI_POSTMAN_POOL_REPORT_BOT_TOKEN instead of the config file.');
    const token = await ask('reportBotToken (blank = use env)', config.reportBotToken ? '(keep existing)' : '');
    if (token && token !== '(keep existing)') config.reportBotToken = token;

    console.log('Step 6 - reportChatId: for a private DM use your own userId (the SELF line) and press Start on the bot first.');
    config.reportChatId = String(await ask('reportChatId', config.reportChatId));

    console.log('Step 7 - LibreWolf settings. Point at your LibreWolf binary and the Profiles directory that holds your pool profiles.');
    config.librewolfBinary = await ask('librewolfBinary', config.librewolfBinary);
    config.profilesRoot = await ask('profilesRoot (…/librewolf/Profiles; blank = auto-detect)', config.profilesRoot);
    const profiles = await ask('profileDirectories (comma-separated folder or "Hồ sơ N" names; blank = discover all)', config.profileDirectories.join(','));
    config.profileDirectories = profiles ? profiles.split(',').map((part) => part.trim()).filter(Boolean) : [];
    writeConfig(configPath, config);

    if (await yes('Check Postman LibreWolf profile discovery now (postman-pool-join.py --dry-run)?')) {
      const browserArgs = [];
      if (config.librewolfBinary) browserArgs.push('--librewolf-binary', config.librewolfBinary);
      if (config.profilesRoot) browserArgs.push('--profiles-root', config.profilesRoot);
      for (const profileDirectory of config.profileDirectories) browserArgs.push('--profile-directory', profileDirectory);
      pyInherit([JOIN_SCRIPT, ...browserArgs, '--dry-run']);
    }

    const status = getPostmanPoolConfigStatus(configPath);
    if (!status.ready) {
      console.log(`\nStill missing: ${status.missing.join(', ')}. Re-run setup after supplying them.`);
      return;
    }
    console.log('\nConfig is complete (all required fields present).');

    if (await yes('Send one outbound test message now (sendMessage only)?')) {
      const creds = resolveReportCredentials(configPath);
      try {
        const result = await sendPostmanPoolReportMessage(creds, 'Aki Watch: outbound test message (sendMessage only).');
        console.log(`Sent test to chat ${creds.reportChatId} (token source: ${creds.tokenSource}); message_id=${result?.message_id ?? 'n/a'}`);
      } catch (error) {
        console.log(`Test send failed: ${redactToken(error?.message)}`);
      }
    }

    console.log('Setup complete. Start or stop the watcher from Aki Watch > Auto Watch; no Aki MCP restart is required.');
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let configPath = POSTMAN_POOL_CONFIG_PATH;
  const configFlag = args.indexOf('--config');
  if (configFlag >= 0 && args[configFlag + 1]) configPath = args[configFlag + 1];
  if (args.includes('--status-json')) {
    console.log(JSON.stringify(getPostmanPoolConfigStatus(configPath)));
    return 0;
  }
  if (args.includes('--get-config-json')) {
    console.log(JSON.stringify(configView(configPath)));
    return 0;
  }
  if (args.includes('--set-config-json')) {
    await setConfigFromStdin(configPath);
    console.log(JSON.stringify(configView(configPath)));
    return 0;
  }
  if (args.includes('--send-test-json')) {
    await sendTestReport(configPath);
    return 0;
  }
  if (args.includes('--preflight-json')) {
    console.log(JSON.stringify(preflightView(configPath)));
    return 0;
  }
  if (args.includes('--check')) {
    printCheck(configPath);
    return 0;
  }
  await runSetup(configPath);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(redactToken(error?.message || error));
    process.exit(1);
  });
