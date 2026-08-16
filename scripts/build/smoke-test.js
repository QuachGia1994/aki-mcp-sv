#!/usr/bin/env node
// Bootstrap smoke test — one OS launcher, run for real, into a scratch user-data root.
// docs/plan/standalone-release-delivery.md § Required implementation sequence, step 4.
//
// Builds a fresh payload and a launcher pointed at a throwaway local HTTP server instead of the
// real GitHub Release (which may not have this version's assets uploaded yet — the whole reason
// this step exists is that 1.8.0/1.8.1 never got that far). The launcher subprocess is spawned
// with Node's own directory stripped from PATH, so it genuinely cannot fall back to a
// preinstalled Node — proving it provisions its own private runtime, the same claim a real
// Node-absent machine needs to be true. Node's own download still hits the real nodejs.org
// (that part is never faked: the checksum-verify path being exercised is the one shipped).
//
// This driver script itself needs Node to build/serve/orchestrate — that's this CI job's own
// runtime, analogous to a maintainer's machine building a release. Only the launcher-under-test's
// PATH is scrubbed. Full OAuth/Tailscale/browser startup stays explicitly out of scope (plan
// step 4: "Tailscale/OAuth/browser flow remains runtime verification, not a CI claim").
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

// PATH stripped of every directory that resolves a `node`/`node.exe` — not just the currently
// running interpreter's own directory, since a real dev/CI machine can carry several Node
// installs (nvm, homebrew, a system package) on PATH at once. What remains must still carry
// curl/tar/unzip/sh (POSIX) or the platform's built-in PowerShell (Windows) — the runtime
// prerequisites the plan documents.
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

// Deliberately async (child_process.spawn), not spawnSync: this driver's in-process local HTTP
// server (serveDir) needs the event loop free to actually answer the launcher's download
// request. spawnSync blocks the whole event loop for its duration, which starves that server —
// the launcher's curl/Invoke-WebRequest call would hang until the timeout fired with no response
// ever sent, which looks identical to a real network failure but isn't one.
// Ports are pinned away from start.js's defaults (9998/9999/19999) so a stray already-running
// dev instance on the host machine can't collide with this scratch run. PUBLIC_ORIGIN (start.js's
// own existing ingress-precedence knob) and MCP_SKIP_BROWSER_OPEN keep this scratch run from
// touching the real machine at all — no Tailscale Funnel mutation, no browser window (coding.B3:
// running the app is user-triggered; a verification script does not get to have side effects on
// the host it runs on).
function runLauncher(launcherPath, scrubbedPath, fakeHome, timeoutMs) {
  const portEnv = { MCP_HUB_PORT: '29999', GATEKEEPER_PORT: '28999', PANEL_PORT: '28998' };
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
    const child = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
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
  // start.js never returns on its own (it stays up serving the panel/gatekeeper); the launcher
  // execs into it, so the install step completing and Node actually booting is what a bounded
  // timeout + non-zero-from-timeout result proves, not a clean exit.
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

// Node dist dir names differ per target ("darwin-arm64" etc) but there is exactly one child dir
// under runtime/<version>/ after a single-target smoke-test install.
function oneDirNameUnder(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length !== 1) throw new Error(`expected exactly one target directory under ${dir}, found: ${entries.map((e) => e.name).join(', ')}`);
  return entries[0].name;
}

main().catch((err) => {
  console.error('[smoke-test] FAILED:', err.message);
  process.exit(1);
});
