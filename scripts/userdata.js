// Everything this server writes for a user — config and secrets alike — lives in one directory outside the repo, the same way a CLI keeps its settings under the home directory. A clone stays exactly as it was checked out.
// The setup runs at import, not on a call: oauth.js reads its files while loading, so ordering has to come from the dependency graph rather than from someone remembering to call a function first.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const USER_DIR = path.join(os.homedir(), '.aki', 'mcpsv');

export const SETTINGS_PATH = path.join(USER_DIR, 'setting.json');
export const HUB_CONFIG_PATH = path.join(USER_DIR, 'mcp-hub.config.json');
export const CLIENT_PATH = path.join(USER_DIR, 'oauth-client.json');
export const DCR_CLIENTS_PATH = path.join(USER_DIR, 'oauth-dcr-clients.json');
export const PASSPHRASE_PATH = path.join(USER_DIR, 'passphrase.txt');
export const TOKENS_PATH = path.join(USER_DIR, 'tokens.json');

mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });

// The tracked mcp-hub.config.json is the shipped default with placeholders; the copy here is the live one the panel edits.
// First run seeds it verbatim. Later runs additively merge any server the template gained since (e.g. a new worker arm)
// without touching entries the panel may have edited — otherwise a server added to the shipped default never reaches an
// existing install, because the live copy is never re-copied. A new worker inherits the roots the existing workers already
// run under (search.env.MCP_DATA_DIR, kept authoritative by the panel) so it is scoped identically, not to the template default.
const TEMPLATE_PATH = path.join(process.cwd(), 'mcp-hub.config.json');
if (!existsSync(HUB_CONFIG_PATH)) {
  copyFileSync(TEMPLATE_PATH, HUB_CONFIG_PATH);
} else {
  const template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
  const live = JSON.parse(readFileSync(HUB_CONFIG_PATH, 'utf8'));
  const liveRoots = live.mcpServers?.search?.env?.MCP_DATA_DIR;
  let added = false;
  for (const [name, entry] of Object.entries(template.mcpServers ?? {})) {
    if (live.mcpServers[name]) continue;
    const merged = structuredClone(entry);
    if (liveRoots && merged.env?.MCP_DATA_DIR) merged.env.MCP_DATA_DIR = liveRoots;
    live.mcpServers[name] = merged;
    added = true;
  }
  if (added) writeFileSync(HUB_CONFIG_PATH, `${JSON.stringify(live, null, 2)}\n`);
}
