// Update check for both aki-mcp-sv (this repo) and akidevrule (the rule corpus).
// Compares local versions against the GitHub raw sources. Network failure degrades to
// "current known, latest unknown" — it never throws and never blocks startup (coding.C1).
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { USER_DIR } from './userdata.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE_CHANGELOG = path.join(os.homedir(), '.aki', 'akidevrule', 'CHANGELOG.md');

// Lives under this app's own USER_DIR (pattern.A1 SSoT), not the shared ~/.aki root — akidevrule's CHANGELOG above is a different product's data and stays under ~/.aki directly.
export const STATUS_PATH = path.join(USER_DIR, 'aki-mcp-status.json');
export const REPO_MCP = 'lacvietanh/aki-mcp-sv';
export const BRANCH_MCP = 'main';
export const REPO_RULE = 'lacvietanh/akidevrule';
export const BRANCH_RULE = 'master';

const MCP_PKG_URL = `https://raw.githubusercontent.com/${REPO_MCP}/${BRANCH_MCP}/package.json`;
const RULE_CHANGELOG_URL = `https://raw.githubusercontent.com/${REPO_RULE}/${BRANCH_RULE}/CHANGELOG.md`;

// Newest released version in a keep-a-changelog file: the first `## [x.y.z]` heading, skipping the `[Unreleased]` buffer. akidevrule has no version field, so its CHANGELOG is the SSoT.
export function parseChangelogVersion(text) {
  const m = text && text.match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
  return m ? m[1] : null;
}

function readLocalMcp() {
  try { return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

function readLocalRule() {
  try { return parseChangelogVersion(readFileSync(RULE_CHANGELOG, 'utf8')); }
  catch { return null; }
}

// Local versions only — no network. rule is null when akidevrule isn't installed.
export function getLocalVersions() {
  return { mcp: readLocalMcp(), rule: readLocalRule() };
}

// -1 / 0 / 1 for a<b / a==b / a>b on 3-part numeric semver. An unknown side yields 0 (no update claim).
export function cmpSemver(a, b) {
  if (!a || !b) return 0;
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// node:https over global fetch() avoids undici's lazy-init RSS cost — see CHANGELOG.md [Unreleased].
function fetchText(url, timeoutMs, redirectsLeft = 3) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'aki-mcp-sv' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return done(fetchText(new URL(res.headers.location, url).toString(), timeoutMs, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(null);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

// { mcp:{current,latest,updateAvailable}, rule:{...} }. current is local (always attempted); latest is null on any network/parse failure; updateAvailable is only true when latest > current.
export async function checkForUpdate({ timeoutMs = 3000 } = {}) {
  const local = getLocalVersions();
  const [mcpPkg, ruleLog] = await Promise.all([
    fetchText(MCP_PKG_URL, timeoutMs),
    fetchText(RULE_CHANGELOG_URL, timeoutMs),
  ]);
  let mcpLatest = null;
  try { mcpLatest = mcpPkg ? (JSON.parse(mcpPkg).version || null) : null; } catch { mcpLatest = null; }
  const branch = (current, latest) => ({ current, latest, updateAvailable: cmpSemver(current, latest) < 0 });
  return { mcp: branch(local.mcp, mcpLatest), rule: branch(local.rule, parseChangelogVersion(ruleLog)) };
}

// A convenience mirror the pasted instruction reads at session start (under ~/.aki = a locked allowed root), so a remote AI can tell the user its instruction is stale. Never fatal — the console/panel banners stand alone.
export function writeStatusFile(info) {
  try {
    writeFileSync(STATUS_PATH, `${JSON.stringify({ checkedAt: new Date().toISOString(), ...info }, null, 2)}\n`);
  } catch { /* best-effort */ }
}
