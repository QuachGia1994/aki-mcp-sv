// Everything this server writes for a user — config and secrets alike — lives in one directory outside the repo, the same way a CLI keeps its settings under the home directory. A clone stays exactly as it was checked out.
// The setup runs at import, not on a call: oauth.js reads its files while loading, so ordering has to come from the dependency graph rather than from someone remembering to call a function first.
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const USER_DIR = path.join(os.homedir(), '.aki', 'mcpsv');

export const SETTINGS_PATH = path.join(USER_DIR, 'setting.json');
export const HUB_CONFIG_PATH = path.join(USER_DIR, 'mcp-hub.config.json');
export const CLIENT_PATH = path.join(USER_DIR, 'oauth-client.json');
export const PASSPHRASE_PATH = path.join(USER_DIR, 'passphrase.txt');
export const TOKENS_PATH = path.join(USER_DIR, 'tokens.json');

// Carried over from <repo>/data, where earlier versions wrote them: dropping these costs the user their OAuth client and passphrase, i.e. re-creating the connector on claude.ai. Copied, not moved.
const LEGACY = [
  ['.oauth-client.json', CLIENT_PATH, 0o600],
  ['.token', PASSPHRASE_PATH, 0o600],
  ['.tokens.json', TOKENS_PATH, 0o600],
  ['mcp-hub.config.json', HUB_CONFIG_PATH, 0o644],
];

mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });

for (const [name, dest, mode] of LEGACY) {
  const legacy = path.join(process.cwd(), 'data', name);
  if (!existsSync(legacy) || existsSync(dest)) continue;
  copyFileSync(legacy, dest);
  chmodSync(dest, mode);
}

// The tracked mcp-hub.config.json is the shipped default with placeholders; the copy here is the live one the panel edits.
if (!existsSync(HUB_CONFIG_PATH)) copyFileSync(path.join(process.cwd(), 'mcp-hub.config.json'), HUB_CONFIG_PATH);
