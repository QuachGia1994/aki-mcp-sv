#!/usr/bin/env node
// Bootstrap smoke test: builds a payload+launcher against a local scratch server, runs it with Node stripped from PATH, asserts the private runtime + app payload land.
// See docs/plan/standalone-release-delivery.md § Required implementation sequence, step 4.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPayload } from './payload.js';
import { buildLaunchers } from './launchers.js';
import { sha256File } from './checksum.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const NODE_VERSION = pkg.engines?.node;

function serveDir(dir) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const filePath = path.join(dir, decodeURIComponent(req.url.replace(/^\//, '')));
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end(readFileSync(filePath));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Strips every PATH dir that resolves a `node`/`node.exe`, not just the running interpreter's own dir.
function pathWithoutNode() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const nodeBinName = process.platform === 'win32' ? 'node.exe' : 'node';
  const entries = (process.env.PATH || '').split(sep).filter((p) => p && !existsSync(path.join(p, nodeBinName)));
  return entries.join(sep);
}

function assertNoNodeOnPath(scrubbedPath) {
  const probe = process.platform === 'win32' ? ['where', ['node.exe']] : ['sh', ['-c', 'command -v node']];
  const result = spawnSync(probe[0], probe[1], { env: { ...process.env, PATH: scrubbedPath }, encoding: 'utf8' });
  if (result.status === 0) {
    throw new Error(`PATH scrub failed — a "node" is still resolvable via PATH: ${result.stdout.trim()} (PATH=${scrubbedPath})`);
  }
}

function launcherKeyForPlatform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'windows';
  throw new Error(`unsupported smoke-test platform: ${process.platform}`);
}

// Async spawn: spawnSync would block the event loop and starve serveDir's HTTP server.
// PUBLIC_ORIGIN + MCP_SKIP_BROWSER_OPEN stop this run from touching the real machine (coding.B3).
function runLauncher(launcherPath, scrubbedPath, fakeHome, timeoutMs) {
  const portEnv = { MCP_HUB_PORT: '29999', GATEKEEPER_PORT: '28999', PANEL_PORT: '28998' }; // off start.js's defaults, avoids colliding with a real running instance
  const safetyEnv = { PUBLIC_ORIGIN: 'http://127.0.0.1:28998', MCP_SKIP_BROWSER_OPEN: '1' };
  const isWin = process.platform === 'win32';
  const [cmd, args, env] = isWin
    ? [
        'cmd.exe',
        ['/c', launcherPath],
        { PATH: scrubbedPath, ...portEnv, ...safetyEnv, LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'), TEMP: path.join(fakeHome, 'Temp'), TMP: path.join(fakeHome, 'Temp'), SystemRoot: process.env.SystemRoot },
      ]
    : ['sh', [launcherPath], { PATH: scrubbedPath, ...portEnv, ...safetyEnv, HOME: fakeHome }];

  return new Promise((resolve) => {
    // detached on win32: its own process group, so taskkill /T targets only this tree, never the smoke-test process itself.
    const child = spawn(cmd, args, { env, ...(isWin ? { detached: true } : {}) });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    // Windows has no exec-replace: cmd.exe->powershell.exe->node.exe stay separate, so killing cmd.exe alone orphans node.exe holding stdio open forever; taskkill /T kills the whole tree.
    const timer = setTimeout(() => {
      timedOut = true;
      if (isWin) {
        const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
        console.log(`[smoke-test] taskkill pid=${child.pid} status=${r.status} stdout=${(r.stdout || '').trim()} stderr=${(r.stderr || '').trim()} spawnError=${r.error}`);
      } else {
        child.kill('SIGTERM');
      }
    }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
  });
}

async function main() {
  const version = pkg.version;
  if (!NODE_VERSION) throw new Error('package.json is missing engines.node');

  const workDir = mkdtempSync(path.join(tmpdir(), 'aki-mcp-sv-smoke-'));
  const buildDir = path.join(workDir, 'build');
  const fakeHome = path.join(workDir, 'home');

  console.log('[smoke-test] building payload + launcher against a local server (not the real GitHub Release)');
  const { tarPath, zipPath, archiveBaseName } = buildPayload(REPO_ROOT, version, buildDir);
  const server = await serveDir(buildDir);
  const assetBaseUrl = `http://127.0.0.1:${server.address().port}`;

  const launchers = await buildLaunchers({
    nodeVersion: NODE_VERSION,
    appVersion: version,
    appArchiveBaseName: archiveBaseName,
    appTarSha256: sha256File(tarPath),
    appZipSha256: sha256File(zipPath),
    outDir: buildDir,
    assetBaseUrl,
  });

  const platform = launcherKeyForPlatform();
  const launcherPath = launchers[platform];
  const scrubbedPath = pathWithoutNode();
  assertNoNodeOnPath(scrubbedPath);
  console.log(`[smoke-test] PATH scrubbed of Node — confirmed no "node" resolvable before running the launcher`);

  console.log(`[smoke-test] running ${launcherPath} (first run — expect real downloads)`);
  // start.js never exits on its own — a timeout kill is the expected end, not a clean exit.
  const first = await runLauncher(launcherPath, scrubbedPath, fakeHome, 45_000);
  console.log(`[smoke-test] first run ended (${first.timedOut ? 'killed at timeout, expected — start.js stays up' : `exited on its own, status ${first.status}`})`);
  console.log(first.stdout || '');
  console.error(first.stderr || '');

  const appDataRoot =
    platform === 'macos'
      ? path.join(fakeHome, 'Library', 'Application Support', 'aki-mcp-sv')
      : platform === 'linux'
        ? path.join(fakeHome, '.local', 'share', 'aki-mcp-sv')
        : path.join(fakeHome, 'AppData', 'Local', 'aki-mcp-sv');

  const runtimeRoot = path.join(appDataRoot, 'runtime', NODE_VERSION);
  if (!existsSync(runtimeRoot)) throw new Error(`FAIL: no runtime installed under ${runtimeRoot}`);
  const target = oneDirNameUnder(runtimeRoot);
  const nodeBin = path.join(runtimeRoot, target, platform === 'windows' ? 'node.exe' : 'bin/node');
  if (!existsSync(nodeBin)) throw new Error(`FAIL: private Node binary missing: ${nodeBin}`);

  const versionCheck = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' });
  if (versionCheck.status !== 0 || !versionCheck.stdout.includes(NODE_VERSION)) {
    throw new Error(`FAIL: private Node --version check failed: ${versionCheck.stdout} ${versionCheck.stderr}`);
  }
  console.log(`[smoke-test] PASS: private Node binary at ${nodeBin} reports ${versionCheck.stdout.trim()}`);

  const appDir = path.join(appDataRoot, 'app', version);
  if (!existsSync(path.join(appDir, 'scripts', 'start.js'))) throw new Error(`FAIL: app payload not installed under ${appDir}`);
  console.log(`[smoke-test] PASS: app payload installed at ${appDir}`);

  console.log(`[smoke-test] running ${launcherPath} again (second run — expect no re-download)`);
  const second = await runLauncher(launcherPath, scrubbedPath, fakeHome, 15_000);
  const secondLog = `${second.stdout || ''}${second.stderr || ''}`;
  if (secondLog.includes('downloading')) {
    throw new Error('FAIL: second run re-downloaded — installed versions were not reused');
  }
  console.log('[smoke-test] PASS: second run reused the installed runtime/app, no re-download');

  server.close();
  rmSync(workDir, { recursive: true, force: true });
  console.log('[smoke-test] ALL CHECKS PASSED');
}

// Exactly one child dir exists under runtime/<version>/ after a single-target smoke-test install.
function oneDirNameUnder(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length !== 1) throw new Error(`expected exactly one target directory under ${dir}, found: ${entries.map((e) => e.name).join(', ')}`);
  return entries[0].name;
}

main().catch((err) => {
  console.error('[smoke-test] FAILED:', err.message);
  // exitCode, not process.exit(): the latter can truncate not-yet-flushed stdio on Windows.
  process.exitCode = 1;
});
