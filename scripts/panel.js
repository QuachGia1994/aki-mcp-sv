#!/usr/bin/env node
// Loopback-only, never behind the Funnel: it writes config and runs commands. Token-gated so no other browser page can POST to it.
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPanel, AGY_SERVER_KEY } from './config-page.js';
import { getOrIssueAccessToken, rotateAccessToken, rotatePassphrase, loadOrCreatePassphrase, listClients, removeClient } from './oauth.js';
import { logSecurity, readSecurityLog } from './security-log.js';
import { listCallers } from './callers.js';
import { loadAllowlist, loadAllowlistDirs, readSettings, DEFAULT_ALLOWLIST } from './allowlist.js';
import { getRoots } from './roots.js';
import { funnelStatus } from './tailscale.js';
import { SETTINGS_PATH, USER_DIR, INGRESS_CONFIG_PATH, CLOUDFLARED_CRED_PATH, readIngressConfig } from './userdata.js';
import { getAgyPoolStatus, getAgyPoolUsage, initializeAgyPool, provisionAgyRoleUsers, loginAgyPoolRole, logoutAgyPoolRole, startAgyPool, stopAgyPool, startAgyPoolRole, stopAgyPoolRole } from './agy-pool-manager.js';
import { readBody, json, serveStatic, serveFontAwesome } from './http.js';
import { failures, readLimits, validateLimits, LIMIT_DEFAULTS } from './rate-limit.js';
import { getLocalVersions, cmpSemver, writeStatusFile, getRuleStatus } from './update-check.js';
import { getDaemonStatus, launchPostmanDaemon, killPostmanDaemon, requestNewWindow } from './postman/postman-mcp.js';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES_DIR = path.join(os.homedir(), '.aki', 'akidevrule');
const SOURCE_REPO_FILE = path.join(RULES_DIR, '.source-repo');
const RULES_CLONE_DIR = path.join(os.homedir(), '.aki', 'akidevrule-src');
const RULES_REPO_URL = 'https://github.com/lacvietanh/akidevrule.git';

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

// Keep the containment boundary atomic; a partial write could widen access.
function setFolders(paths) {
  const settings = readSettings();
  settings.folders = paths;
  writeJsonAtomic(SETTINGS_PATH, settings);
}

// Connection limits are a security setting like folders: written atomically so a partial write cannot read back as "no limit".
function setRateLimit(limits) {
  const settings = readSettings();
  settings.rateLimit = limits;
  writeJsonAtomic(SETTINGS_PATH, settings);
}

// Whatever lands here becomes the gate shell-mcp checks, and a wrong type reads as "no restriction", not as an error.
function validateAllowlist(allowlist) {
  if (!allowlist || typeof allowlist !== 'object' || Array.isArray(allowlist)) throw new Error('allowlist must be a JSON object');
  for (const [bin, subs] of Object.entries(allowlist)) {
    const ok = subs === null || (Array.isArray(subs) && subs.every((s) => typeof s === 'string'));
    if (!ok) throw new Error(`"${bin}": must be null (any subcommand) or an array of strings`);
  }
  return allowlist;
}

function validatePaths(paths) {
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) {
    throw new Error('folder list must be absolute paths');
  }
  if (!paths.length) throw new Error('an empty list cuts off all of Claude\'s file access; add at least one folder');
  return paths.map((p) => path.normalize(p));
}

const sameSubs = (a, b) =>
  a === null || b === null ? a === b : Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

// Diff against DEFAULT_ALLOWLIST so a deleted default lands in `revoked`, not silently back to default. `added` is the 2-level array (string = any, [bin, ...subs] = restricted): no hand-written null.
const entryOf = ([bin, subs]) => (subs === null ? bin : [bin, ...subs]);
function toStored(effective) {
  const added = Object.entries(effective)
    .filter(([bin, subs]) => !(bin in DEFAULT_ALLOWLIST) || !sameSubs(subs, DEFAULT_ALLOWLIST[bin]))
    .map(entryOf);
  const revoked = Object.keys(DEFAULT_ALLOWLIST).filter((bin) => !(bin in effective));
  return { added, revoked };
}

function setShellAllowlist(allowlist) {
  const settings = readSettings();
  settings.shell = { ...settings.shell, allowlist: toStored(allowlist) };
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

function validateTrustedDirs(dirs) {
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === 'string' && path.isAbsolute(d))) {
    throw new Error('trusted directories must be absolute paths');
  }
  return dirs.map((p) => path.normalize(p));
}

function setTrustedDirs(dirs) {
  const settings = readSettings();
  settings.shell = { ...settings.shell, allowlistDirs: dirs };
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

// Mirrors the same TunnelID check start.js does at boot (spawnCloudflared), so a bad file is caught here instead of silently tearing down the stack on next `npm start`.
function validateCloudflaredCred(credContent) {
  let parsed;
  try {
    parsed = JSON.parse(credContent);
  } catch {
    throw new Error('not valid JSON — upload the cloudflared credentials file as-is');
  }
  if (!parsed.TunnelID) throw new Error('no TunnelID field — this does not look like a cloudflared credentials JSON');
  return credContent;
}

function validateIngressOrigin(origin) {
  const trimmed = (origin || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(trimmed)) throw new Error('origin must be a full URL, e.g. https://your-host');
  return trimmed;
}

// Browser file inputs cannot hand back an OS path, so the content is persisted here and referenced by path instead.
function saveCloudflaredIngress(credContent, origin) {
  writeFileSync(CLOUDFLARED_CRED_PATH, validateCloudflaredCred(credContent), { mode: 0o600 });
  const saved = { mode: 'cloudflared', credPath: CLOUDFLARED_CRED_PATH, origin: validateIngressOrigin(origin) };
  writeFileSync(INGRESS_CONFIG_PATH, `${JSON.stringify(saved, null, 2)}\n`);
  return saved;
}

// Clears only the pointer, not the persisted cred file — a re-save can reuse it without a re-upload.
function clearSavedIngress() {
  if (existsSync(INGRESS_CONFIG_PATH)) unlinkSync(INGRESS_CONFIG_PATH);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout || stderr || '(no output)'),
    );
  });
}

// Three states, one button: already cloned locally, cloned by us before, or never seen on this machine.
async function installRules() {
  const recorded = existsSync(SOURCE_REPO_FILE) ? readFileSync(SOURCE_REPO_FILE, 'utf8').trim() : null;
  let repo = recorded && existsSync(path.join(recorded, 'install.sh')) ? recorded : null;

  if (!repo) {
    if (existsSync(path.join(RULES_CLONE_DIR, '.git'))) {
      await run('git', ['-C', RULES_CLONE_DIR, 'pull', '--ff-only']);
    } else {
      mkdirSync(path.dirname(RULES_CLONE_DIR), { recursive: true });
      await run('git', ['clone', '--depth', '1', RULES_REPO_URL, RULES_CLONE_DIR]);
    }
    repo = RULES_CLONE_DIR;
  }
  // Windows bash.exe may launch WSL without a distro; use PowerShell for install.ps1.
  let cmd, args;
  if (IS_WIN) {
    if (existsSync(path.join(repo, 'install.ps1'))) {
      cmd = 'powershell';
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'install.ps1')];
    } else {
      throw new Error('this akidevrule clone has no install.ps1 for Windows — pull the latest akidevrule and retry');
    }
  } else {
    cmd = 'bash';
    args = [path.join(repo, 'install.sh')];
  }
  try {
    const log = await run(cmd, args, repo);
    return `${log.trim().split('\n').pop()} (source: ${repo})`;
  } catch (e) {
    if (IS_WIN && /ENOENT|not found|not recognized|execvpe|\/bin\/bash|WSL/i.test(e.message)) {
      throw new Error('Windows install failed — could not run install.ps1 (do not use WSL bash): ' + e.message);
    }
    throw e;
  }
}

// Check cleanliness at click-time; the tree may have changed since page load.
async function pullUpdate() {
  if (!existsSync(path.join(REPO_ROOT, '.git'))) {
    throw new Error('this runtime is not a Git checkout — start AKIMCP from your local fork before updating');
  }
  const dirty = (await run('git', ['-C', REPO_ROOT, 'status', '--porcelain'])).trim();
  if (dirty && dirty !== '(no output)') {
    throw new Error('working tree has uncommitted changes — commit them before updating');
  }
  let hasUpstream = true;
  try { await run('git', ['-C', REPO_ROOT, 'remote', 'get-url', 'upstream']); } catch { hasUpstream = false; }
  if (hasUpstream) {
    await run('git', ['-C', REPO_ROOT, 'fetch', 'upstream', 'main']);
    await run('git', ['-C', REPO_ROOT, 'merge', '--no-edit', 'upstream/main']);
    return 'merged upstream/main into the local fork — restart akimcp to load the new code';
  }
  await run('git', ['-C', REPO_ROOT, 'pull', '--ff-only']);
  return 'pulled latest — restart akimcp to load the new code';
}

// Mirror shell-mcp's classification: a zone overlapping a writable root is dropped (write+exec = RCE). Name the offending root so the panel can show why a zone is disabled.
function trustedDirStatus() {
  const roots = getRoots().map((p) => path.resolve(p));
  return loadAllowlistDirs().map((dir) => {
    const conflict = roots.find((root) => overlaps(dir, root)) || null;
    return { dir, active: !conflict, conflict };
  });
}

// Refresh the on-disk version after rule install so reload does not show stale updates.
// A rule install updates the on-disk corpus but not the boot-time updateInfo, so without this a reload re-rendered a stale "update available" banner. Recompute current from disk against the boot-time latest.
function refreshLocalVersions(updateInfo) {
  const local = getLocalVersions();
  updateInfo.mcp.current = local.mcp;
  updateInfo.mcp.updateAvailable = cmpSemver(local.mcp, updateInfo.mcp.latest) < 0;
  // Rebuild the whole rule branch (installed/unreleasedOnly/state), not just current, so a post-install reload flips "not installed" -> "installed" and clears the update badge — same source as boot.
  updateInfo.rule = getRuleStatus(updateInfo.rule?.latest ?? null);
  writeStatusFile(updateInfo);
}

async function alibabaReviewPreview() {
  const runOcr = (argv) => new Promise((resolve, reject) => {
    const command = IS_WIN ? (process.env.ComSpec || 'cmd.exe') : 'ocr';
    const args = IS_WIN
      ? ['/c', ['ocr', ...argv.map((a) => /\s/.test(a) ? '"' + a.replace(/"/g, '\\\"') + '"' : a)].join(' ')]
      : argv;
    execFile(command, args, { cwd: REPO_ROOT, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve((stdout || stderr || '').trim());
    });
  });

  try {
    const output = JSON.parse(await runOcr(['delegate', 'preview', '--format', 'json', '--repo', REPO_ROOT]));
    let rules = null;
    const files = Array.isArray(output.reviewable_files) ? output.reviewable_files : [];
    if (files.length) {
      const paths = files.map((f) => typeof f === 'string' ? f : f.path).filter(Boolean);
      if (paths.length) {
        try {
          rules = JSON.parse(await runOcr(['delegate', 'rule', '--format', 'json', ...paths]));
        } catch (e) {
          if (/unknown flag.*format/i.test(e.message)) rules = await runOcr(['delegate', 'rule', ...paths]);
          else throw e;
        }
      }
    }
    return { mode: 'json', output, rules };
  } catch (e) {
    if (/unknown flag.*format/i.test(e.message)) {
      return { mode: 'text', output: await runOcr(['delegate', 'preview', '--repo', REPO_ROOT]) };
    }
    if (/ENOENT|not recognized|not found/i.test(e.message)) {
      throw new Error('Alibaba Open Code Review CLI is not installed or not on PATH — install @alibaba-group/open-code-review first');
    }
    throw e;
  }
}

export async function launchAlibabaReview({
  spawnFn = spawn,
  existsFn = existsSync,
  claudeCmd = path.join('D:', 'LacViet', 'claude-pm', 'clpm.cmd'),
} = {}) {
  if (!existsFn(claudeCmd)) {
    throw new Error('Claude PM launcher not found: ' + claudeCmd);
  }

  const prompt = [
    'Perform a full Alibaba Open Code Review in DELEGATION MODE for the current repository.',
    'Repository: ' + REPO_ROOT,
    '',
    'Mandatory workflow:',
    '1. Run: ocr delegate preview --format json --repo "' + REPO_ROOT + '"',
    '2. Put every reviewable_files entry into an explicit checklist.',
    '3. Run: ocr delegate rule --format json <every reviewable file path>.',
    '4. Review every reviewable file using the resolved rules. Batch only for context/size; do not silently omit files.',
    '5. Report Critical, High, and Medium findings with precise file and line evidence.',
    '6. Report coverage: total reviewable, reviewed, skipped, and skip reasons.',
    '7. Do NOT run ocr review, ocr llm test, configure an OCR LLM, request API keys, or modify files.',
    '',
    'This is a read-only review. Return the final review report directly in this Claude Code session.'
  ].join('\\n');

  const child = spawnFn(claudeCmd, ['-p', prompt], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: true,
  });
  child.unref();

  return {
    ok: true,
    launched: true,
    pid: child.pid,
    message: 'Alibaba Review launched in Claude PM — review is running in the new CLPM session',
  };
}

export const ROUTES = {
  'GET /api/state': async (body, ctx) => ({
    // Same call shell/find_path/search_content enforce with (roots.js:getRoots()), so the list can never show a set that isn't the live one.
    paths: getRoots(),
    allowlist: loadAllowlist(),
    trustedDirs: loadAllowlistDirs(),
    ingressConfig: readIngressConfig(),
  }),
  'GET /api/tailscale': async () => funnelStatus(process.env.GATEKEEPER_PORT || '9999'),
  // Same function aki__postman_status calls (scripts/postman/postman-mcp.js) — one status shape, two readers.
  'GET /api/postman-status': async () => getDaemonStatus(),
  // Deterministic Alibaba OCR delegation step: returns reviewable files/ref metadata only; the host agent performs the actual review.
  'POST /api/alibaba-review': async () => launchAlibabaReview(),
  // launchPostmanDaemon handles repeated clicks.
  // The one launch action (panel Postman tab button) — spawn-or-recognize lives in launchPostmanDaemon itself (scripts/postman/postman-mcp.js), so N clicks here behave like one, same as every other panel action.
  'POST /api/postman-launch': async () => launchPostmanDaemon(),
  // Quit returns the real post-kill status (running/pid), never a placeholder "stopping…".
  'POST /api/postman-quit': async () => killPostmanDaemon(),
  // New window shown only while running — asks the already-running daemon to fire the same mediator trigger its own injected panel button uses (requestNewWindow, scripts/postman/postman-mcp.js).
  'POST /api/postman-new-window': async () => requestNewWindow(),
  'GET /api/agy-pool': async () => getAgyPoolStatus(),
  'GET /api/agy-pool/usage': async () => getAgyPoolUsage(),
  'POST /api/agy-pool/usage': async () => getAgyPoolUsage({ fresh: true }),
  'POST /api/agy-pool/init': async () => initializeAgyPool(),
  'POST /api/agy-pool/provision': async () => provisionAgyRoleUsers(),
  'POST /api/agy-pool/login-role': async (body) => loginAgyPoolRole(body.role),
  'POST /api/agy-pool/logout-role': async (body) => logoutAgyPoolRole(body.role),
  'POST /api/agy-pool/start': async () => startAgyPool(),
  'POST /api/agy-pool/stop': async () => stopAgyPool(),
  'POST /api/agy-pool/start-role': async (body) => startAgyPoolRole(body.role),
  'POST /api/agy-pool/stop-role': async (body) => stopAgyPoolRole(body.role),
  // Servers go to mcp_config.json, permissions to settings.json — docs/ref/fact-agy-mcp-config.md § CLI-1, CLI-3, CLI-4.
  // The panel's instance token is not a /mcp access token (401), hence stdio. Idempotent: merges, never clobbers other entries.
  'POST /api/agy-apply-mcp': async () => {
    // (A) MCP server -> ~/.gemini/config/mcp_config.json as a stdio entry.
    const mcpConfigPath = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
    let mcpConfig = {};
    if (existsSync(mcpConfigPath)) {
      try {
        mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) || {};
      } catch {
        throw new Error(`${mcpConfigPath} is not valid JSON — fix or remove it, then retry`);
      }
    }
    mcpConfig.mcpServers = mcpConfig.mcpServers || {};
    mcpConfig.mcpServers[AGY_SERVER_KEY] = { command: 'node', args: [path.join(REPO_ROOT, 'scripts', 'stdio.js')] };
    writeJsonAtomic(mcpConfigPath, mcpConfig);

    // (B) Pre-allow -> ~/.gemini/antigravity-cli/settings.json (permissions only; agy does NOT read MCP servers here).
    // Also drop any stale akimcp server entry a previous (wrong) version wrote under mcpServers here.
    const settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    let settings = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf8')) || {};
      } catch {
        throw new Error(`${settingsPath} is not valid JSON — fix or remove it, then retry`);
      }
    }
    if (settings.mcpServers && settings.mcpServers[AGY_SERVER_KEY]) delete settings.mcpServers[AGY_SERVER_KEY];
    settings.permissions = settings.permissions || { allow: [], deny: [] };
    settings.permissions.allow = settings.permissions.allow || [];
    settings.permissions.allow = [...new Set([...settings.permissions.allow, `mcp(${AGY_SERVER_KEY}/*)`])];
    writeJsonAtomic(settingsPath, settings);

    return { ok: true, message: 'Applied — akimcp (stdio) → ~/.gemini/config/mcp_config.json + pre-allow → antigravity-cli/settings.json. Restart agy to pick it up.' };
  },
  // No hub restart: setFolders writes setting.json, and roots.js reads it fresh per call — a save takes effect on the next shell/find_path/search_content call, same as the allowlist.
  'POST /api/paths': async (body) => {
    setFolders(validatePaths(body.paths));
    return { ok: true, message: 'saved — shell, find, and search pick this up on their next call' };
  },
  'POST /api/allowlist': async (body) => {
    setShellAllowlist(validateAllowlist(body.allowlist));
    return { ok: true, message: `saved allowlist to ${SETTINGS_PATH}` };
  },
  // No hub restart: shell-mcp reads allowlistDirs fresh per command (checkPermission → preallowedByDir), so a save takes effect on the next run_cmd.
  'POST /api/trusted-dirs': async (body) => {
    setTrustedDirs(validateTrustedDirs(body.dirs));
    return { ok: true, message: `saved trusted directories to ${SETTINGS_PATH}` };
  },
  'GET /api/security': async () => ({ limits: readLimits(), defaults: LIMIT_DEFAULTS, blocked: failures.blockedList(), clients: listClients(), callers: listCallers(), log: readSecurityLog() }),
  'POST /api/clients/remove': async (body) => ({ ok: true, message: removeClient(typeof body.clientId === 'string' ? body.clientId : '') }),
  'POST /api/rate-limit': async (body) => {
    setRateLimit(validateLimits(body.limits));
    logSecurity('connection limits saved');
    return { ok: true, message: 'saved — applies from the next request' };
  },
  'POST /api/rate-limit/release': async (body) => {
    const key = typeof body.key === 'string' ? body.key : undefined;
    failures.release(key);
    logSecurity(key ? `released ${key.slice(0, 64)}` : 'released every blocked caller');
    return { ok: true, message: body.key ? 'released' : 'everyone released' };
  },
  'POST /api/install-rules': async (body, ctx) => {
    const message = await installRules();
    refreshLocalVersions(ctx.updateInfo);
    return { ok: true, message };
  },
  // No refresh: a repo pull only lands on disk; the process keeps the old version until restart, so the banner stays as a restart reminder and clears on the next boot.
  // The page reloads after this so every server-rendered snippet carries the new token; the token itself is never returned.
  'POST /api/roll-token': async (body) => {
    rotateAccessToken({ revokeRefresh: body.hard === true });
    return { ok: true, message: body.hard === true ? 'rolled — every client must re-authorize' : 'rolled — re-paste the token into local snippets' };
  },
  'POST /api/roll-passphrase': async () => {
    rotatePassphrase();
    return { ok: true, message: 'rolled — the old passphrase no longer authorizes; connected AIs keep working' };
  },
  'POST /api/pull-update': async () => ({ ok: true, message: await pullUpdate() }),
  // Ingress is decided at start.js boot, not live-switchable — saving here never restarts anything, only records the pick for the next `npm start`.
  'POST /api/ingress/cloudflared': async (body) => {
    const saved = saveCloudflaredIngress(body.credContent, body.origin);
    return { ok: true, message: 'saved — restart akimcp to use this ingress', saved };
  },
  'POST /api/ingress/clear': async () => {
    clearSavedIngress();
    return { ok: true, message: 'cleared — restart akimcp to go back to Tailscale Funnel', saved: null };
  },
};

export function startPanel({ port, token, origin, ingress, client, passphrase, updateInfo, isDev = false, onFatal }) {
  const server = http.createServer(async (req, res) => {
    const [urlPath, query] = (req.url || '').split('?');
    const route = `${req.method} ${urlPath}`;

    if (route === 'GET /') {
      if (new URLSearchParams(query).get('t') !== token) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('wrong token — open the URL printed in your terminal');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderPanel({ origin, ingress, client, passphrase: loadOrCreatePassphrase(), token, accessToken: getOrIssueAccessToken(), repoRoot: REPO_ROOT, rulesDir: RULES_DIR, userDir: USER_DIR, updateInfo, savedIngress: readIngressConfig(), isDev }));
    }

    if (req.method === 'GET' && (await serveStatic(res, urlPath) || await serveFontAwesome(res, urlPath))) return;

    const handler = ROUTES[route];
    if (!handler) return json(res, 404, { error: 'not found' });
    if (req.headers['x-panel-token'] !== token) return json(res, 403, { error: 'sai token' });

    try {
      json(res, 200, await handler(JSON.parse((await readBody(req)) || '{}'), { updateInfo }));
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });

  // Unlike the gatekeeper (mapped to a fixed port by Tailscale/cloudflared ingress), nothing external pins the panel's port, so stepping past a conflict is safe.
  const MAX_PORT_ATTEMPTS = 20;
  let attempt = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
      attempt++;
      server.listen(port + attempt, '127.0.0.1');
      return;
    }
    console.error(`[panel] failed to listen on :${port + attempt}: ${e.message}`);
    onFatal?.();
  });
  server.on('listening', () => {
    server.actualPort = server.address().port;
    console.log(`[panel] http://127.0.0.1:${server.actualPort}/?t=${token}`);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
