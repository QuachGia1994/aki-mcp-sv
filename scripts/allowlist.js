// The shell allowlist, in one place: the MCP server enforces it and the panel shows it as the starting point a user edits. Two copies would let the panel display a set the server does not actually apply.
import fs from 'node:fs';
import { SETTINGS_PATH } from './userdata.js';

// null = any subcommand allowed; array = only those subcommands. Curated to read-only binaries.
export const DEFAULT_ALLOWLIST = {
  ls: null, cat: null, pwd: null, find: null, grep: null, head: null, tail: null,
  wc: null, file: null, stat: null, tree: null, ps: null, df: null, du: null,
  whoami: null, uname: null,
  git: ['status', 'log', 'diff', 'show'],
};

export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') process.stderr.write(`[allowlist] ignoring malformed ${SETTINGS_PATH}: ${e.message}\n`);
    return {};
  }
}

export function loadAllowlist() {
  const user = readSettings().shell?.allowlist;
  return user ? { ...DEFAULT_ALLOWLIST, ...user } : DEFAULT_ALLOWLIST;
}
