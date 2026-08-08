// The shell allowlist, in one place: the MCP server enforces it and the panel shows it as the starting point a user edits. Two copies would let the panel display a set the server does not actually apply.
import fs from 'node:fs';
import { SETTINGS_PATH } from './userdata.js';

// null = any subcommand allowed; array = only those subcommands. Curated to read-only binaries.
// Unix tools work as-is on macOS/Linux and also on Windows when Git for Windows usr\bin is on PATH.
const UNIX_DEFAULT = {
  ls: null, cat: null, pwd: null, find: null, grep: null, head: null, tail: null,
  wc: null, file: null, stat: null, tree: null, ps: null, df: null, du: null,
  whoami: null, uname: null,
  sort: null, uniq: null, cut: null, diff: null,
  basename: null, dirname: null, realpath: null, which: null, date: null,
  git: ['status', 'log', 'diff', 'show'],
};

const WIN_EXTRA = {
  where: null,
  findstr: null,
  tasklist: null,
  hostname: null,
};

export const DEFAULT_ALLOWLIST =
  process.platform === 'win32' ? { ...UNIX_DEFAULT, ...WIN_EXTRA } : UNIX_DEFAULT;

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
