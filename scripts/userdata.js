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
  // Authoritative roots the panel keeps in sync, read from whichever server still carries them: it used to be
  // `search`, but the tool arms were consolidated into `local`, so an old install may have search while a new one has local.
  const liveRoots = Object.values(live.mcpServers ?? {}).find((s) => s.env?.MCP_DATA_DIR)?.env?.MCP_DATA_DIR;
  let changed = false;
  for (const [name, entry] of Object.entries(template.mcpServers ?? {})) {
    if (live.mcpServers[name]) continue;
    const merged = structuredClone(entry);
    if (liveRoots && merged.env?.MCP_DATA_DIR) merged.env.MCP_DATA_DIR = liveRoots;
    live.mcpServers[name] = merged;
    changed = true;
  }
  // Prune servers the template dropped so a legacy install migrates cleanly instead of trying to boot arms that no
  // longer exist standalone (shell/agy/kiro/search became register() modules under `local`). The template is the single
  // source of truth for the server set; the panel only ever edits folders/commands, never adds its own server entries.
  for (const name of Object.keys(live.mcpServers ?? {})) {
    if (!template.mcpServers?.[name]) {
      delete live.mcpServers[name];
      changed = true;
    }
  }
  if (changed) writeFileSync(HUB_CONFIG_PATH, `${JSON.stringify(live, null, 2)}\n`);
}
