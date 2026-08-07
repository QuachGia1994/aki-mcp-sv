#!/usr/bin/env node
// Loopback-only, never behind the Funnel: it writes config and runs commands. Token-gated so no other browser page can POST to it.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPanel } from './config-page.js';
import { listTabs, evaluate, connectChrome, restartChrome } from './chrome.js';
import { loadAllowlist, readSettings } from './allowlist.js';
import { funnelStatus } from './tailscale.js';
import { HUB_CONFIG_PATH as HUB_CONFIG, SETTINGS_PATH, USER_DIR } from './userdata.js';

const REPO_ROOT = process.cwd();
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const RULES_DIR = path.join(os.homedir(), '.aki', 'akidevrule');
const SOURCE_REPO_FILE = path.join(RULES_DIR, '.source-repo');
const RULES_CLONE_DIR = path.join(os.homedir(), '.aki', 'akidevrule-src');
const RULES_REPO_URL = 'https://github.com/lacvietanh/akidevrule.git';

const MIME = { '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

// Shows placeholders expanded and saves back what it shows: a folder list is only checkable if it reads as real folders.
const expandPath = (p, dataDir) => p.replace(/\$\{MCP_DATA_DIR\}/g, dataDir).replace(/\$\{HOME\}/g, os.homedir());

function filesystemPaths(dataDir) {
  return readJson(HUB_CONFIG, {}).mcpServers.filesystem.args.slice(2).map((p) => expandPath(p, dataDir));
}

// `choose folder` is macOS's own picker: no path typing, no copy-paste, and multi-select in one pass.
// Cancelling is a normal outcome, not a failure — it comes back as an empty list.
async function pickFolders() {
  const script = [
    'activate',
    'set picked to choose folder with prompt "Chọn thư mục Claude được phép truy cập" with multiple selections allowed',
    'set out to ""',
    'repeat with f in picked',
    'set out to out & POSIX path of f & linefeed',
    'end repeat',
    'return out',
  ].flatMap((line) => ['-e', line]);
  try {
    const out = await run('osascript', script);
    return out.split('\n').map((s) => s.replace(/\/$/, '')).filter(Boolean);
  } catch (e) {
    if (/User canceled|-128/.test(e.message)) return [];
    throw e;
  }
}

// search/shell enforce path containment via the same list, so it never drifts from what this panel shows as "allowed".
function setFilesystemPaths(paths) {
  const config = readJson(HUB_CONFIG, {});
  const [flag, pkg] = config.mcpServers.filesystem.args;
  config.mcpServers.filesystem.args = [flag, pkg, ...paths];
  const rootsEnv = paths.join(',');
  config.mcpServers.search.env.MCP_DATA_DIR = rootsEnv;
  config.mcpServers.shell.env.MCP_DATA_DIR = rootsEnv;
  writeFileSync(HUB_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
}

// Whatever lands here becomes the gate shell-mcp checks, and a wrong type reads as "no restriction", not as an error.
function validateAllowlist(allowlist) {
  if (!allowlist || typeof allowlist !== 'object' || Array.isArray(allowlist)) throw new Error('allowlist phải là một object JSON');
  for (const [bin, subs] of Object.entries(allowlist)) {
    const ok = subs === null || (Array.isArray(subs) && subs.every((s) => typeof s === 'string'));
    if (!ok) throw new Error(`"${bin}": chỉ nhận null (mọi subcommand) hoặc mảng chuỗi`);
  }
  return allowlist;
}

function validatePaths(paths) {
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p.startsWith('/'))) {
    throw new Error('danh sách thư mục phải là các đường dẫn tuyệt đối');
  }
  return paths;
}

function setShellAllowlist(allowlist) {
  const settings = readSettings();
  settings.shell = { ...settings.shell, allowlist };
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 180_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
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
  const log = await run('bash', [path.join(repo, 'install.sh')], repo);
  return `${log.trim().split('\n').pop()} (nguồn: ${repo})`;
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}));
    req.on('error', reject);
  });

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const ROUTES = {
  'GET /api/state': async (body, ctx) => ({
    paths: filesystemPaths(ctx.dataDir),
    // The same call the MCP server enforces with, so the textarea can never show a set that isn't the live one.
    allowlist: loadAllowlist(),
    ruleFiles: existsSync(RULES_DIR) ? readdirSync(RULES_DIR).filter((f) => /^(index|RULE-.+|METHOD-.+)\.md$/.test(f)).sort() : [],
  }),
  'GET /api/tailscale': async () => funnelStatus(process.env.GATEKEEPER_PORT || '9999'),
  'POST /api/paths': async (body, ctx) => {
    setFilesystemPaths(validatePaths(body.paths));
    ctx.restartHub();
    return { ok: true, message: 'đã lưu thư mục và restart mcp-hub' };
  },
  'POST /api/allowlist': async (body) => {
    setShellAllowlist(validateAllowlist(body.allowlist));
    return { ok: true, message: `đã lưu allowlist vào ${SETTINGS_PATH}` };
  },
  'POST /api/restart': async (body, ctx) => {
    ctx.restartHub();
    return { ok: true, message: 'đã restart mcp-hub' };
  },
  'POST /api/install-rules': async () => ({ ok: true, message: await installRules() }),
  'POST /api/pick-folder': async () => ({ ok: true, folders: await pickFolders() }),
  'POST /api/chrome/connect': async () => ({ ok: true, ...(await connectChrome()) }),
  'POST /api/chrome/restart': async () => ({ ok: true, ...(await restartChrome()) }),
  'GET /api/chrome/tabs': async () => ({ tabs: await listTabs() }),
  'POST /api/chrome/eval': async (body) => ({ ok: true, result: await evaluate(body.tabId, body.js) }),
};

function serveStatic(res, urlPath) {
  const file = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^([/\\.]+)/, ''));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
  return true;
}

export function startPanel({ port, token, origin, client, passphrase, dataDir, restartHub }) {
  const server = http.createServer(async (req, res) => {
    const [urlPath, query] = (req.url || '').split('?');
    const route = `${req.method} ${urlPath}`;

    if (route === 'GET /') {
      if (new URLSearchParams(query).get('t') !== token) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('sai token — mở URL mà `npm start` in ra');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderPanel({ origin, client, passphrase, token, repoRoot: REPO_ROOT, dataDir, rulesDir: RULES_DIR, userDir: USER_DIR }));
    }

    if (req.method === 'GET' && serveStatic(res, urlPath)) return;

    const handler = ROUTES[route];
    if (!handler) return json(res, 404, { error: 'not found' });
    if (req.headers['x-panel-token'] !== token) return json(res, 403, { error: 'sai token' });

    try {
      json(res, 200, await handler(await readBody(req), { restartHub, dataDir }));
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });

  server.listen(port, '127.0.0.1', () => console.log(`[panel] http://127.0.0.1:${port}/?t=${token}`));
  return server;
}
