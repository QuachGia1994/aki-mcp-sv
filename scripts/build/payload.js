// Builds the platform-neutral app payload (npm ci --omit=dev, build-time only) as deterministic .tar.gz + .zip.
// docs/plan/standalone-release-delivery.md § Release assets.
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_ENTRIES, NATIVE_FILE_EXTS } from './targets.js';

// Fixed timestamp on every staged file so byte-identical inputs produce a byte-identical archive.
const DETERMINISTIC_MTIME = new Date('2026-01-01T00:00:00Z');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function scanForNativeFiles(root) {
  const hits = walk(root).filter((f) => NATIVE_FILE_EXTS.includes(path.extname(f)));
  if (hits.length > 0) {
    const rel = hits.map((f) => path.relative(root, f)).join('\n  ');
    throw new Error(
      `native dependency file(s) found — the platform-neutral single-payload assumption no longer holds:\n  ${rel}\n` +
        'Build per-target payloads instead of a shared one (see plan § Release assets).'
    );
  }
}

function normalizeTimestamps(root) {
  for (const f of walk(root)) utimesSync(f, DETERMINISTIC_MTIME, DETERMINISTIC_MTIME);
}

// Isolated staging copy — npm ci runs here, never at REPO_ROOT, so the dev tree's node_modules is never touched.
function installProdDeps(repoRoot, stageDir) {
  cpSync(path.join(repoRoot, 'package.json'), path.join(stageDir, 'package.json'));
  cpSync(path.join(repoRoot, 'package-lock.json'), path.join(stageDir, 'package-lock.json'));
  console.log('[payload] npm ci --omit=dev (build-time only, never runs on the client)');
  execFileSync('npm', ['ci', '--omit=dev'], { cwd: stageDir, stdio: 'inherit' });
}

function copyAppEntries(repoRoot, stageDir) {
  for (const entry of APP_ENTRIES) {
    const src = path.join(repoRoot, entry);
    if (entry === 'package.json') continue; // already installed above with the lockfile
    if (existsSync(src)) cpSync(src, path.join(stageDir, entry), { recursive: true });
  }
}

// Explicit sorted file list, not `tar -C dir .` / `zip -r`, so archive bytes don't depend on filesystem enumeration order.
function sortedRelativeFiles(root) {
  return walk(root)
    .map((f) => path.relative(root, f))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Both archives contain one top-level directory (archiveBaseName) — what install_verified() expects after extraction.
function buildTarGz(stageParentDir, files, outPath) {
  const listPath = `${outPath}.filelist`;
  writeFileSync(listPath, files.join('\n'));
  execFileSync('tar', ['-czf', outPath, '-C', stageParentDir, '-T', listPath]);
  rmSync(listPath);
}

function buildZip(stageParentDir, files, outPath) {
  rmSync(outPath, { force: true });
  execFileSync('zip', ['-X', '-q', outPath, ...files], { cwd: stageParentDir });
}

/**
 * @param {string} repoRoot
 * @param {string} version
 * @param {string} buildDir  scratch/output directory (repo's dist/)
 * @returns {{ tarPath: string, zipPath: string, stageParentDir: string, archiveBaseName: string }}
 */
export function buildPayload(repoRoot, version, buildDir) {
  const archiveBaseName = `aki-mcp-sv-${version}-app`;
  const stageParentDir = path.join(buildDir, 'stage-payload');
  const stageDir = path.join(stageParentDir, archiveBaseName);
  rmSync(stageParentDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  installProdDeps(repoRoot, stageDir);
  copyAppEntries(repoRoot, stageDir);
  scanForNativeFiles(stageDir);
  normalizeTimestamps(stageDir);

  mkdirSync(buildDir, { recursive: true });
  const archiveFiles = sortedRelativeFiles(stageDir).map((f) => path.join(archiveBaseName, f));
  const tarPath = path.join(buildDir, `${archiveBaseName}.tar.gz`);
  const zipPath = path.join(buildDir, `${archiveBaseName}.zip`);
  buildTarGz(stageParentDir, archiveFiles, tarPath);
  buildZip(stageParentDir, archiveFiles, zipPath);

  console.log(`[payload] built ${tarPath}`);
  console.log(`[payload] built ${zipPath}`);
  return { tarPath, zipPath, stageParentDir, archiveBaseName };
}
