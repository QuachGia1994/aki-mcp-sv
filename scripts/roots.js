// Path containment shared by every MCP tool that touches the filesystem — one implementation, because a second copy of a security boundary is a second chance to get it subtly wrong.
import os from 'node:os';
import path from 'node:path';
import { loadFolders } from './allowlist.js';

// Fallback when setting.json carries no `folders` key yet (fresh install, or a folder edit was never saved via the panel): reconstructs the same default the old boot-time MCP_DATA_DIR env var used to expand to (dataDir + ~/.aki + ~/.claude), so behavior is unchanged until the first save — including the rule/config dirs the panel's own prompt-builder tells the AI to read. MCP_DATA_DIR may itself already be that pre-joined string when read inside the `local` child (mcp-hub interpolates it from mcp-hub.config.json), so dedupe rather than assume either shape.
function envDefaultRoots() {
  const base = (process.env.MCP_DATA_DIR || os.homedir())
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
  const always = [path.join(os.homedir(), '.aki'), path.join(os.homedir(), '.claude')];
  return [...new Set([...(base.length ? base : [path.resolve(os.homedir())]), ...always])];
}

// Per-call read (no module-level snapshot): a folder add/remove in setting.json takes effect on the very next call, the same way the shell allowlist already does. An empty/malformed read must never widen to "no restriction" — the safe-default fallback below is mandatory, never optional.
export function getRoots() {
  const stored = loadFolders().map((p) => path.resolve(p));
  const roots = stored.length ? stored : envDefaultRoots();
  return roots.length ? roots : [path.resolve(os.homedir())];
}

export function containedIn(abs, root) {
  // Windows paths are case-insensitive; drive letter casing from different APIs must not bypass the boundary.
  if (process.platform === 'win32') {
    const a = abs.toLowerCase();
    const r = root.toLowerCase();
    return a === r || a.startsWith(r + path.sep.toLowerCase());
  }
  return abs === root || abs.startsWith(root + path.sep);
}

// Either direction of containment counts as overlap: a trusted exec dir inside a writable root (or vice versa) is the write+exec = RCE composition the trusted-dir preallow must refuse.
export const overlaps = (a, b) => containedIn(a, b) || containedIn(b, a);

export function resolveUnderRoot(target) {
  const roots = getRoots();
  if (!target) return roots[0];
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(roots[0], target);
  const allowed = roots.some((root) => containedIn(abs, root));
  if (!allowed) {
    throw new Error(`path is outside the allowed roots: ${roots.join(', ')}`);
  }
  return abs;
}

// Non-throwing variant for CLI-arm handlers: returns { ok, dir } or { ok:false, error }, so a caller wraps the failure however its context needs (sync fail() vs async) without repeating the try/catch and its Promise-wrapping footgun.
export function resolveOrFail(target) {
  try {
    return { ok: true, dir: resolveUnderRoot(target) };
  } catch (e) {
    return { ok: false, error: e };
  }
}
