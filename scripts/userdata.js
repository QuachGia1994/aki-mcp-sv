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
export const INGRESS_CONFIG_PATH = path.join(USER_DIR, 'ingress.json');
export const CLOUDFLARED_CRED_PATH = path.join(USER_DIR, 'cloudflared-cred.json');

mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });

// Single reader for the panel-picked ingress (panel.js writes it, start.js reads it as the default when no --tunnel flag/PUBLIC_ORIGIN is set) — one shape, read the same way by both.
export function readIngressConfig() {
  if (!existsSync(INGRESS_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(INGRESS_CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// A launch-arg list is [prefix..., ...absoluteDirs] — the boundary is the first absolute-path
// token. Shared by the reconciliation below and panel.js's filesystem-folder editing so both
// agree on where the entry prefix ends, regardless of how many tokens that prefix has (an old
// `npx -y <package>` pair vs a bare `node <script>`).
export function splitLaunchArgs(args) {
  const idx = args.findIndex((a) => path.isAbsolute(a));
  return idx === -1 ? { prefix: args, dirs: [] } : { prefix: args.slice(0, idx), dirs: args.slice(idx) };
}

// The tracked mcp-hub.config.json is the shipped default with placeholders; the copy here is the live one the panel edits. First run seeds it verbatim.
// Later runs reconcile the live copy against the template's server set — add what the template gained, prune what it dropped, and migrate an existing entry's launch shape (command/entry script) forward when the template's changed — while leaving the panel-edited folders themselves untouched.
const TEMPLATE_PATH = path.join(process.cwd(), 'mcp-hub.config.json');
if (!existsSync(HUB_CONFIG_PATH)) {
  copyFileSync(TEMPLATE_PATH, HUB_CONFIG_PATH);
} else {
  const template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
  const live = JSON.parse(readFileSync(HUB_CONFIG_PATH, 'utf8'));
  // Roots the panel keeps authoritative, read from whichever server still carries MCP_DATA_DIR: it used to be `search`, consolidated into `local`, so an old install may have one and a new one the other. A server added below inherits them, not the template placeholder.
  const liveRoots = Object.values(live.mcpServers).find((s) => s.env?.MCP_DATA_DIR)?.env?.MCP_DATA_DIR;
  let changed = false;
  for (const [name, entry] of Object.entries(template.mcpServers)) {
    const liveEntry = live.mcpServers[name];
    if (!liveEntry) {
      const merged = structuredClone(entry);
      if (liveRoots && merged.env?.MCP_DATA_DIR) merged.env.MCP_DATA_DIR = liveRoots;
      live.mcpServers[name] = merged;
      changed = true;
      continue;
    }
    // Entry exists but its launch shape may be stale (e.g. Step 1's npx→node switch for
    // `filesystem`): a naive "already present, skip" here is exactly what let a broken hybrid
    // command/args pair through. Recover the user's real directories (any absolute-path arg,
    // however the old shape scattered them) and rebuild them onto the template's current prefix.
    if (Array.isArray(liveEntry.args) && (liveEntry.command !== entry.command || liveEntry.args[0] !== entry.args[0])) {
      const { dirs: liveDirs } = splitLaunchArgs(liveEntry.args);
      const templatePrefix = entry.args.filter((a) => !a.startsWith('${'));
      const merged = structuredClone(entry);
      merged.command = entry.command;
      merged.args = liveDirs.length ? [...templatePrefix, ...liveDirs] : entry.args.map((a) => (liveRoots && a.startsWith('${') ? liveRoots : a));
      live.mcpServers[name] = merged;
      changed = true;
    }
  }
  // Prune servers the template no longer defines: shell/agy/kiro/search became register() modules under `local` and can't boot standalone. The template is the single source of truth for the server set; the panel only edits folders and commands.
  for (const name of Object.keys(live.mcpServers)) {
    if (!template.mcpServers[name]) {
      delete live.mcpServers[name];
      changed = true;
    }
  }
  if (changed) writeFileSync(HUB_CONFIG_PATH, `${JSON.stringify(live, null, 2)}\n`);
}
