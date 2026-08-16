#!/usr/bin/env node
// Release build entry point: app payload + three launchers + SHA256SUMS, six assets total.
// docs/plan/standalone-release-delivery.md § Required implementation sequence, step 2.
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload } from './payload.js';
import { buildLaunchers } from './launchers.js';
import { sha256File } from './checksum.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const NODE_VERSION = pkg.engines?.node;
if (!NODE_VERSION) {
  console.error('[package] package.json is missing engines.node — the version to bundle has no single source of truth');
  process.exit(1);
}

async function main() {
  const version = pkg.version;
  const buildDir = path.join(REPO_ROOT, 'dist');
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  const { tarPath, zipPath, archiveBaseName } = buildPayload(REPO_ROOT, version, buildDir);
  const appTarSha256 = sha256File(tarPath);
  const appZipSha256 = sha256File(zipPath);

  const launchers = await buildLaunchers({
    nodeVersion: NODE_VERSION,
    appVersion: version,
    appArchiveBaseName: archiveBaseName,
    appTarSha256,
    appZipSha256,
    outDir: buildDir,
  });

  const assets = [tarPath, zipPath, launchers.macos, launchers.windows, launchers.linux];
  const sumsLines = assets
    .map((p) => `${sha256File(p)}  ${path.basename(p)}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sumsPath = path.join(buildDir, 'SHA256SUMS');
  writeFileSync(sumsPath, `${sumsLines.join('\n')}\n`);

  console.log(`[package] built ${assets.length} release assets + ${sumsPath}`);
  for (const p of assets) console.log(`[package]   ${path.relative(REPO_ROOT, p)}`);
}

main().catch((err) => {
  console.error('[package] failed:', err.message);
  process.exit(1);
});
