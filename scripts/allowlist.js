// The shell allowlist, in one place: the MCP server enforces it and the panel shows it as the starting point a user edits. Two copies would let the panel display a set the server does not actually apply.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS_PATH } from './userdata.js';

// Entry form: a bare string allows any subcommand; [bin, ...subs] restricts to those. Structure carries the level — no hand-written null.
// find/sort/fd excluded on purpose: their flags escape read-only (find -exec/-delete, sort -o, fd -x) and the args[0] gate can't restrain a flag; search__find_path/search__search_content cover read-only lookup.
// Unix tools work as-is on macOS/Linux and on Windows when Git for Windows usr\bin is on PATH.
const UNIX_DEFAULT = [
  'ls', 'cat', 'pwd', 'grep', 'head', 'tail', 'wc', 'file', 'stat', 'tree', 'ps', 'df', 'du',
  'whoami', 'uname', 'uniq', 'cut', 'diff', 'jq',
  'basename', 'dirname', 'realpath', 'which', 'date', 'strings', 'uptime', 'pgrep',
  ['lsof', '-i'],
  ['npm', 'list', 'ls', 'outdated'], ['pip', 'freeze', 'list'], ['node', '-v'],
  ['git', 'status', 'log', 'diff', 'show', 'branch', 'remote', 'blame', 'check-ignore', 'ls-files', 'rev-parse', 'tag'],
];

// Per-OS read-only extras, selected as data by process.platform (never a business-logic branch).
const MAC_EXTRA = ['vm_stat', ['sysctl', '-n'], ['top', '-l'], ['diskutil', 'list', 'info'], 'ifconfig', ['netstat', '-an'], 'sw_vers', 'system_profiler'];
const LINUX_EXTRA = ['free', ['top', '-b'], 'nproc', 'lsblk', ['ip', 'addr'], ['ss', '-tuln']];
const WIN_EXTRA = ['where', 'findstr', 'tasklist', 'hostname', 'systeminfo', 'Get-CimInstance', 'Get-Counter', 'Get-Process', 'Get-PSDrive', 'Get-Volume', 'Get-Service', 'Get-NetIPAddress', 'Get-NetTCPConnection', 'Test-Connection', 'Get-ComputerInfo'];

const PLATFORM_EXTRA =
  process.platform === 'win32' ? WIN_EXTRA : process.platform === 'darwin' ? MAC_EXTRA : LINUX_EXTRA;

// One entry list → the { bin: null|array } map the rest of the subsystem reads. The null (any subcommand) is produced here once, never hand-authored.
const toMap = (entries) => Object.fromEntries(entries.map((e) => (Array.isArray(e) ? [e[0], e.slice(1)] : [e, null])));
export const DEFAULT_ALLOWLIST = toMap([...UNIX_DEFAULT, ...PLATFORM_EXTRA]);

export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') process.stderr.write(`[allowlist] ignoring malformed ${SETTINGS_PATH}: ${e.message}\n`);
    return {};
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Normalizes three stored shapes to { overrides, revoked }: v3 { added:[entries], revoked }, v2 { overrides:{bin:null|array}, revoked }, v1 flat map. `revoked` records a removed default that an absent key cannot (the P0 bug). Format detail: docs/plan/shell-allowlist.md.
function normalizeStored(stored) {
  if (Array.isArray(stored.added)) {
    return { overrides: toMap(stored.added), revoked: Array.isArray(stored.revoked) ? stored.revoked : [] };
  }
  if (isPlainObject(stored.overrides) || Array.isArray(stored.revoked)) {
    return { overrides: isPlainObject(stored.overrides) ? stored.overrides : {}, revoked: Array.isArray(stored.revoked) ? stored.revoked : [] };
  }
  return { overrides: stored, revoked: [] };
}

export function loadAllowlist() {
  const stored = readSettings().shell?.allowlist;
  if (!stored || typeof stored !== 'object') return DEFAULT_ALLOWLIST;
  const { overrides, revoked } = normalizeStored(stored);
  const merged = { ...DEFAULT_ALLOWLIST, ...overrides };
  for (const bin of revoked) delete merged[bin];
  return merged;
}

// Second, directory-scoped trust mechanism alongside the name allowlist: any executable/script under these zones may run without a per-file entry, so new Aki skills/scripts don't need a settings edit each time. Zones Aki owns end-to-end; whitelisting individual files inside them is the wrong grain (docs/plan/shell-allowlist.md).
const DEFAULT_ALLOWLIST_DIRS = ['~/.aki', '~/.claude'];
const expandTilde = (p) => (p === '~' ? os.homedir() : /^~[/\\]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p);

export function loadAllowlistDirs() {
  const dirs = readSettings().shell?.allowlistDirs;
  const list = Array.isArray(dirs) ? dirs : DEFAULT_ALLOWLIST_DIRS;
  return list.filter((d) => typeof d === 'string' && d.trim()).map((d) => path.resolve(expandTilde(d.trim())));
}
