#!/usr/bin/env node
// Orchestrates mcp-hub + gatekeeper behind 1 `npm start`; foreground by design, manual stop/start only
import { spawn } from 'node:child_process';
import { funnelStatus, enableFunnel, bringUp } from './tailscale.js';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import { openBrowser } from './open-browser.js';
import { loadOrCreateClient, loadOrCreatePassphrase } from './oauth.js';
import { startPanel } from './panel.js';
import { HUB_CONFIG_PATH, USER_DIR } from './userdata.js';

const dataDir = process.env.MCP_DATA_DIR || os.homedir();
const hubPort = process.env.MCP_HUB_PORT || '19999';
const gatePort = process.env.GATEKEEPER_PORT || '9999';
const panelPort = process.env.PANEL_PORT || '9998';
const panelToken = randomBytes(16).toString('hex');
const home = process.env.HOME || os.homedir();
// HOME must be explicit: Windows does not set it, and the hub config's `${HOME}` placeholders resolve from the child env.
const env = { ...process.env, HOME: home, USERPROFILE: process.env.USERPROFILE || home, MCP_DATA_DIR: dataDir };

const spawnNode = (args, opts) => spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true, ...opts });

console.log(`[start] config & keys: ${USER_DIR}`);

const client = loadOrCreateClient();
const passphrase = loadOrCreatePassphrase();

let tailscale = await funnelStatus(gatePort);
if (!tailscale.installed) {
  console.error('[start] could not run `tailscale` — check it is installed and logged in: https://tailscale.com/download');
} else {
  if (!tailscale.running) {
    const { ok, out } = await bringUp();
    console[ok ? 'log' : 'error'](`[start] tailscale was stopped, starting it: ${ok ? 'done' : out.trim()}`);
    tailscale = await funnelStatus(gatePort);
  }
  if (tailscale.running && !tailscale.funnel) {
    const { ok, out } = await enableFunnel(gatePort);
    console[ok ? 'log' : 'error'](`[start] enabling funnel ${gatePort}: ${ok ? 'done' : out.trim()}`);
  }
}

const origin = tailscale.host ? `https://${tailscale.host}` : null;

if (origin) {
  console.log(`[start] Remote MCP server URL: ${origin}/mcp`);
  console.log(`[start] OAuth Client ID: ${client.clientId}`);
  console.log(`[start] OAuth Client Secret: ${client.clientSecret}`);
  console.log('[start] paste all 3 values above into Add custom connector (URL + Advanced settings)');
  console.log(`[start] Passphrase (enter it when the browser opens the confirmation page): ${passphrase}`);
} else {
  console.error('[start] could not get the MagicDNS name — run `tailscale status` to look up the URL yourself');
}

let hub;
let shuttingDown = false;

function spawnHub() {
  // Resolved and run through `node` directly so Windows never has to locate `npx.cmd`.
  const cli = createRequire(import.meta.url).resolve('mcp-hub/dist/cli.js');
  const child = spawnNode([cli, '--port', hubPort, '--config', HUB_CONFIG_PATH], { env });
  // Only an unexpected death tears the stack down; a restart detaches the old child first.
  child.on('exit', () => child === hub && shutdown());
  child.on('error', (e) => console.error(`[start] mcp-hub failed to start: ${e.message}`));
  hub = child;
}

function restartHub() {
  const old = hub;
  hub = null;
  old.once('exit', spawnHub);
  old.kill();
}

spawnHub();
const gate = spawnNode(['./scripts/gatekeeper.js'], {
  env: { ...env, MCP_HUB_PORT: hubPort, GATEKEEPER_PORT: gatePort, PUBLIC_ORIGIN: origin || '' },
});
gate.on('error', (e) => console.error(`[start] gatekeeper failed to start: ${e.message}`));

const panel = startPanel({ port: Number(panelPort), token: panelToken, origin, client, passphrase, dataDir, restartHub });
const panelUrl = `http://127.0.0.1:${panelPort}/?t=${panelToken}`;
try {
  await openBrowser(panelUrl);
} catch (e) {
  console.error(`[start] could not auto-open the panel (open manually: ${panelUrl}): ${e.message}`);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  hub?.kill();
  gate.kill();
  panel.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
gate.on('exit', shutdown);
