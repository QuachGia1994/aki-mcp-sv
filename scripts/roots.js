// Path containment shared by every MCP tool that touches the filesystem — one implementation, because a second copy of a security boundary is a second chance to get it subtly wrong.
import os from 'node:os';
import path from 'node:path';

// Default = the user's home directory: the one folder that exists on every machine and holds the code someone installing this actually wants Claude to reach.
// MCP_DATA_DIR is comma-separated, kept in sync with the filesystem MCP server's own path list by panel.js — one allowlist, not a second copy of it.
const parsed = (process.env.MCP_DATA_DIR || os.homedir())
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));
export const ROOTS = parsed.length ? parsed : [path.resolve(os.homedir())];
export const ROOT = ROOTS[0];

export function resolveUnderRoot(target) {
  if (!target) return ROOT;
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(ROOT, target);
  const allowed = ROOTS.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!allowed) {
    throw new Error(`path is outside the allowed roots: ${ROOTS.join(', ')}`);
  }
  return abs;
}
