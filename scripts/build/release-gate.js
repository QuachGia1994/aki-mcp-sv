#!/usr/bin/env node
// Release gate: every required asset must be present, checksummed from the real release URL.
// docs/plan/standalone-release-delivery.md § Required implementation sequence, step 6.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './checksum.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const version = process.argv[2] || pkg.version;

const REQUIRED_ASSETS = [
  `aki-mcp-sv-${version}-app.tar.gz`,
  `aki-mcp-sv-${version}-app.zip`,
  `aki-mcp-sv-${version}-macos.command`,
  `aki-mcp-sv-${version}-windows.cmd`,
  `aki-mcp-sv-${version}-linux.run`,
  'SHA256SUMS',
];
// One asset per OS — the app archives are already checksum-verified by each launcher's own install step.
const PER_OS_CHECK_ASSETS = [`aki-mcp-sv-${version}-macos.command`, `aki-mcp-sv-${version}-windows.cmd`, `aki-mcp-sv-${version}-linux.run`];

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function parseShaSums(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m) map.set(m[2].trim(), m[1]);
  }
  return map;
}

function main() {
  const release = ghJson(['release', 'view', version, '--json', 'assets']);
  const present = new Set(release.assets.map((a) => a.name));
  const missing = REQUIRED_ASSETS.filter((name) => !present.has(name));
  if (missing.length > 0) {
    console.error(`[release-gate] FAIL: release ${version} is missing required assets:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`[release-gate] all ${REQUIRED_ASSETS.length} required assets are present on release ${version}`);

  const workDir = mkdtempSync(path.join(tmpdir(), 'aki-mcp-sv-release-gate-'));
  try {
    gh(['release', 'download', version, '--pattern', 'SHA256SUMS', '--dir', workDir, '--clobber']);
    const publishedSums = parseShaSums(readFileSync(path.join(workDir, 'SHA256SUMS'), 'utf8'));

    for (const assetName of PER_OS_CHECK_ASSETS) {
      const expected = publishedSums.get(assetName);
      if (!expected) throw new Error(`SHA256SUMS on the release has no entry for ${assetName}`);
      gh(['release', 'download', version, '--pattern', assetName, '--dir', workDir, '--clobber']);
      const actual = sha256File(path.join(workDir, assetName));
      if (actual !== expected) {
        throw new Error(`checksum mismatch for ${assetName} downloaded from the release: expected ${expected}, got ${actual}`);
      }
      console.log(`[release-gate] verified ${assetName} against the release's own SHA256SUMS`);
    }
  } catch (err) {
    console.error(`[release-gate] FAIL: ${err.message}`);
    process.exit(1);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log(`[release-gate] PASS: release ${version} is ready to publish`);
}

main();
