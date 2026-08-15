#!/usr/bin/env node
// Builds a Node-less-client-ready archive per docs/plan/done/standalone-packaging.md; runs only at build/CI time, never on the client.
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const NODE_VERSION = pkg.engines?.node;
if (!NODE_VERSION) {
  console.error('[package] package.json is missing engines.node — the version to bundle has no single source of truth');
  process.exit(1);
}

// Mirrors open-browser.js's LAUNCHER map. bin/npm|npx|corepack are symlinks into lib/node_modules, so bin/+lib/ ship together (verified live on darwin-arm64 only).
const NODE_TARGETS = {
  'darwin-arm64': { dist: 'darwin-arm64', ext: 'tar.gz', mainBin: 'bin/node' },
  'darwin-x64': { dist: 'darwin-x64', ext: 'tar.gz', mainBin: 'bin/node' },
  'linux-x64': { dist: 'linux-x64', ext: 'tar.gz', mainBin: 'bin/node' },
  'win32-x64': { dist: 'win-x64', ext: 'zip', mainBin: 'node.exe' },
};

// Top-level entries of the extracted Node distribution with no runtime need (native-addon headers, man pages, Node's own docs) — pruned to shrink the archive; bin/ and lib/ always ship.
const NODE_PRUNE = new Set(['include', 'share', 'CHANGELOG.md', 'README.md']);

// PATH is prepended with the bundled Node bin dir — mcp-hub.config.json's "local" (bare "node") and "filesystem" (bare "npx") entries both spawn via PATH lookup, not process.execPath.
const LAUNCHER_SCRIPTS = {
  unix: {
    name: 'start.sh',
    mode: 0o755,
    content: () =>
      '#!/usr/bin/env bash\n' +
      'set -e\n' +
      'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n' +
      'export PATH="$DIR/node/bin:$PATH"\n' +
      'exec "$DIR/node/bin/node" "$DIR/app/scripts/start.js" "$@"\n',
  },
  win32: {
    name: 'start.cmd',
    mode: 0o644,
    content: () =>
      '@echo off\r\n' +
      'set "PATH=%~dp0node;%PATH%"\r\n' +
      '"%~dp0node\\node.exe" "%~dp0app\\scripts\\start.js" %*\r\n',
  },
};

const APP_ENTRIES = ['scripts', 'mcp-hub.config.json', 'package.json', 'LICENSE'];

function parseTargetArg() {
  const i = process.argv.indexOf('--target');
  const target = (i !== -1 ? process.argv[i + 1] : null) || `${process.platform}-${process.arch}`;
  if (!NODE_TARGETS[target]) {
    console.error(`[package] unknown target "${target}" — supported: ${Object.keys(NODE_TARGETS).join(', ')}`);
    process.exit(1);
  }
  return target;
}

async function fetchNodeDistRoot(target, cacheDir) {
  const { dist, ext } = NODE_TARGETS[target];
  const archiveName = `node-v${NODE_VERSION}-${dist}.${ext}`;
  const archivePath = path.join(cacheDir, archiveName);
  if (!existsSync(archivePath)) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
    console.log(`[package] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Node download failed: ${res.status} ${url}`);
    writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));
  } else {
    console.log(`[package] using cached ${archivePath}`);
  }
  const extractDir = path.join(cacheDir, `extract-${target}`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  if (ext === 'tar.gz') execFileSync('tar', ['-xzf', archivePath, '-C', extractDir]);
  else execFileSync('unzip', ['-q', archivePath, '-d', extractDir]);
  return path.join(extractDir, `node-v${NODE_VERSION}-${dist}`);
}

// Copies bin/+lib/ wholesale (npm/npx/corepack symlinks under bin/ target lib/node_modules) and prunes NODE_PRUNE; verifies the target's main binary lands.
function copyNodeRuntime(distRoot, target, stageNodeDir) {
  cpSync(distRoot, stageNodeDir, {
    recursive: true,
    dereference: false,
    filter: (src) => !(path.dirname(src) === distRoot && NODE_PRUNE.has(path.basename(src))),
  });
  const mainBin = path.join(stageNodeDir, NODE_TARGETS[target].mainBin);
  if (!existsSync(mainBin)) throw new Error(`expected node binary missing after copy: ${mainBin}`);
  if (!target.startsWith('win32')) chmodSync(mainBin, 0o755);
}

// Isolated staging copy — npm ci runs here, never at REPO_ROOT, so the shared tree's node_modules is never touched.
function installProdDeps(stageAppDir) {
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(stageAppDir, 'package.json'));
  cpSync(path.join(REPO_ROOT, 'package-lock.json'), path.join(stageAppDir, 'package-lock.json'));
  console.log('[package] npm ci --omit=dev (build-time only, never runs on the client)');
  execFileSync('npm', ['ci', '--omit=dev'], { cwd: stageAppDir, stdio: 'inherit' });
}

function copyAppCode(stageAppDir) {
  for (const entry of APP_ENTRIES) {
    const src = path.join(REPO_ROOT, entry);
    if (existsSync(src)) cpSync(src, path.join(stageAppDir, entry), { recursive: true });
  }
}

function writeLauncher(stageDir, target) {
  const family = target.startsWith('win32') ? 'win32' : 'unix';
  const { name, mode, content } = LAUNCHER_SCRIPTS[family];
  const dest = path.join(stageDir, name);
  writeFileSync(dest, content());
  chmodSync(dest, mode);
}

function archive(stageDir, target, outDir) {
  const base = `aki-mcp-sv-${pkg.version}-${target}`;
  mkdirSync(outDir, { recursive: true });
  if (!target.startsWith('win32')) {
    const out = path.join(outDir, `${base}.tar.gz`);
    execFileSync('tar', ['-czf', out, '-C', path.dirname(stageDir), path.basename(stageDir)]);
    return out;
  }
  const out = path.join(outDir, `${base}.zip`);
  execFileSync('zip', ['-rq', out, path.basename(stageDir)], { cwd: path.dirname(stageDir) });
  return out;
}

async function main() {
  const target = parseTargetArg();
  const buildDir = path.join(REPO_ROOT, 'dist');
  const cacheDir = path.join(buildDir, '.cache');
  const stageDir = path.join(buildDir, 'stage', `aki-mcp-sv-${pkg.version}-${target}`);
  const stageAppDir = path.join(stageDir, 'app');
  mkdirSync(cacheDir, { recursive: true });
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageAppDir, { recursive: true });

  const distRoot = await fetchNodeDistRoot(target, cacheDir);
  copyNodeRuntime(distRoot, target, path.join(stageDir, 'node'));

  installProdDeps(stageAppDir);
  copyAppCode(stageAppDir);
  writeLauncher(stageDir, target);

  const archivePath = archive(stageDir, target, buildDir);
  console.log(`[package] built ${archivePath}`);
}

main().catch((err) => {
  console.error('[package] failed:', err.message);
  process.exit(1);
});
