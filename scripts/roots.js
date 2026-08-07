// Path containment shared by every MCP tool that touches the filesystem — one implementation, because a second copy of a security boundary is a second chance to get it subtly wrong.
import os from 'node:os';
import path from 'node:path';

// Default = the user's home directory: the one folder that exists on every machine and holds the code someone installing this actually wants Claude to reach. Narrow or widen it with MCP_DATA_DIR.
export const ROOT = path.resolve(process.env.MCP_DATA_DIR || os.homedir());

export function resolveUnderRoot(target) {
  if (!target) return ROOT;
  const abs = path.resolve(ROOT, target);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`path is outside the allowed root ${ROOT}`);
  }
  return abs;
}
