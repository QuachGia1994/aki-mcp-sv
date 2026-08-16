#!/usr/bin/env node
// Orchestrates mcp-hub + gatekeeper behind 1 `npm start`; foreground by design, manual stop/start only
// process.loadEnvFile throws ENOENT when the file is missing — swallow it so a .env is optional.
try { process.loadEnvFile?.(); } catch {}
if (existsSync('.env')) console.log('[start] loaded environment from .env');

import { spawn } from 'node:child_process';
import { funnelStatus, enableFunnel, bringUp } from './tailscale.js';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import { openBrowser } from './open-browser.js';
import { loadOrCreateClient, loadOrCreatePassphrase } from './oauth.js';
import { startGatekeeper } from './gatekeeper.js';
import { startPanel } from './panel.js';
import { checkForUpdate, writeStatusFile } from './update-check.js';
import { HUB_CONFIG_PATH, USER_DIR, readIngressConfig } from './userdata.js';

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

// Ingress precedence: --tunnel (spawn cloudflared) > PUBLIC_ORIGIN (bring your own edge) > saved panel ingress config (picked in section 0) > Tailscale Funnel (default).
// Everything downstream keys off the single `origin`, so each mode only has to resolve that value.
const argOf = (flag) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : null; };
const tunnelCred = argOf('--tunnel');
const tunnelOrigin = argOf('--origin')?.replace(/\/+$/, '') || null;
const publicOrigin = (process.env.PUBLIC_ORIGIN || process.env.AKI_PUBLIC_ORIGIN)?.replace(/\/+$/, '') || null;
const savedIngress = !tunnelCred && !publicOrigin ? readIngressConfig() : null;
const cloudflaredCredPath = tunnelCred || savedIngress?.credPath;

let origin;
let ingressMode;
if (tunnelCred) {
  if (!tunnelOrigin) {
    console.error('[start] --tunnel <cred.json> needs --origin https://your-host — the credentials file carries no hostname');
    process.exit(1);
  }
  origin = tunnelOrigin;
  ingressMode = 'cloudflared';
  console.log(`[start] Cloudflare tunnel mode — cloudflared will serve ${origin}`);
} else if (publicOrigin) {
  origin = publicOrigin;
  ingressMode = 'public-origin';
  console.log(`[start] PUBLIC_ORIGIN set — skipping Tailscale, serving at ${origin}`);
} else if (savedIngress?.mode === 'cloudflared' && savedIngress.credPath && savedIngress.origin) {
  origin = savedIngress.origin;
  ingressMode = 'cloudflared';
  console.log(`[start] using ingress picked in the panel (section 0) — cloudflared will serve ${origin}`);
} else {
  ingressMode = 'funnel';
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
  origin = tailscale.host ? `https://${tailscale.host}` : null;
  if (!origin) console.error('[start] could not get the MagicDNS name — run `tailscale status` to look up the URL yourself');
}

if (origin) {
  console.log(`[start] Remote MCP server URL: ${origin}/mcp`);
  console.log(`[start] OAuth Client ID: ${client.clientId}`);
  console.log(`[start] OAuth Client Secret: ${client.clientSecret}`);
  console.log('[start] paste all 3 values above into Add custom connector (URL + Advanced settings)');
  console.log(`[start] Passphrase (enter it when the browser opens the confirmation page): ${passphrase}`);
}

// One check per `npm start`; own version stays on top, then the rule corpus. Never blocks boot.
const updateInfo = await checkForUpdate();
writeStatusFile(updateInfo);
const bar = (s) => console.log(`\x1b[43m\x1b[30m ${s} \x1b[0m`);
if (updateInfo.mcp.updateAvailable) bar(`[update] aki-mcp-sv ${updateInfo.mcp.current} → ${updateInfo.mcp.latest} — open the panel to pull & restart`);
if (updateInfo.rule.updateAvailable) bar(`[update] akidevrule ${updateInfo.rule.current} → ${updateInfo.rule.latest} — update in panel, then re-paste the Instructions (panel section 3) into the custom-instructions setting of each AI`);

let hub;
let panel;
let cloudflared = null;
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

function spawnCloudflared(credPath) {
  let tunnelId;
  try {
    tunnelId = JSON.parse(readFileSync(credPath, 'utf8')).TunnelID;
  } catch (e) {
    console.error(`[start] cannot read tunnel credentials at ${credPath}: ${e.message}`);
    return shutdown();
  }
  if (!tunnelId) {
    console.error(`[start] ${credPath} has no TunnelID — not a cloudflared credentials file`);
    return shutdown();
  }
  // Single-service run without a config file: --url stands in for the yml `ingress` rule, port fixed to the gatekeeper.
  const child = spawn('cloudflared', ['tunnel', 'run', '--cred-file', credPath, '--url', `http://127.0.0.1:${gatePort}`, tunnelId], { stdio: 'inherit', windowsHide: true });
  child.on('error', (e) => {
    console.error(e.code === 'ENOENT'
      ? '[start] `cloudflared` not found — install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
      : `[start] cloudflared failed to start: ${e.message}`);
    shutdown();
  });
  child.on('exit', (code) => { if (!shuttingDown) { console.error(`[start] cloudflared exited (code ${code}) — tunnel down`); shutdown(); } });
  return child;
}

spawnHub();
if (ingressMode === 'cloudflared') cloudflared = spawnCloudflared(cloudflaredCredPath);
// Gatekeeper runs in-process (docs/plan/consolidate-mcp-tool-processes.md, Part B); a fatal listen error tears the whole stack down via shutdown, so the hub is never left orphaned.
let gateServer;
try {
  gateServer = startGatekeeper(origin, shutdown);
} catch (e) {
  console.error(`[start] gatekeeper failed to start: ${e.message}`);
  shutdown();
}

panel = startPanel({ port: Number(panelPort), token: panelToken, origin, ingress: ingressMode, client, passphrase, dataDir, restartHub, updateInfo });
const panelUrl = `http://127.0.0.1:${panelPort}/?t=${panelToken}`;
// Escape hatch for automated runs (bootstrap smoke tests) that must not pop a browser window — off by default, normal `npm start` is unaffected.
if (process.env.MCP_SKIP_BROWSER_OPEN) {
  console.log(`[start] MCP_SKIP_BROWSER_OPEN set — not opening a browser (panel: ${panelUrl})`);
} else {
  try {
    await openBrowser(panelUrl);
  } catch (e) {
    console.error(`[start] could not auto-open the panel (open manually: ${panelUrl}): ${e.message}`);
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  hub?.kill();
  cloudflared?.kill();
  gateServer?.close();
  panel?.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { hub?.kill(); cloudflared?.kill(); }); // safety net: never leave a child orphaned if this process exits abruptly
