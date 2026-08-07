#!/usr/bin/env node
// Orchestrates mcp-hub + gatekeeper behind 1 `npm start`; foreground by design, manual stop/start only
import { spawn, execFileSync } from 'node:child_process';
import { funnelStatus, enableFunnel } from './tailscale.js';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { loadOrCreateClient, loadOrCreatePassphrase } from './oauth.js';
import { startPanel } from './panel.js';
import { HUB_CONFIG_PATH, USER_DIR } from './userdata.js';

const dataDir = process.env.MCP_DATA_DIR || os.homedir();
const hubPort = process.env.MCP_HUB_PORT || '19999';
const gatePort = process.env.GATEKEEPER_PORT || '9999';
const panelPort = process.env.PANEL_PORT || '9998';
const panelToken = randomBytes(16).toString('hex');

console.log(`[start] cấu hình & khoá: ${USER_DIR}`);

const client = loadOrCreateClient();
const passphrase = loadOrCreatePassphrase();

const tailscale = await funnelStatus(gatePort);
if (!tailscale.installed) {
  console.error('[start] không gọi được `tailscale` — kiểm tra đã cài và login chưa: https://tailscale.com/download');
} else if (!tailscale.funnel) {
  const { ok, out } = await enableFunnel(gatePort);
  console[ok ? 'log' : 'error'](`[start] bật funnel ${gatePort}: ${ok ? 'xong' : out.trim()}`);
}

const origin = tailscale.host ? `https://${tailscale.host}` : null;

if (origin) {
  console.log(`[start] Remote MCP server URL: ${origin}/mcp`);
  console.log(`[start] OAuth Client ID: ${client.clientId}`);
  console.log(`[start] OAuth Client Secret: ${client.clientSecret}`);
  console.log('[start] dán cả 3 giá trị trên vào Add custom connector (URL + Advanced settings)');
  console.log(`[start] Passphrase (nhập khi trình duyệt mở trang xác nhận): ${passphrase}`);
} else {
  console.error('[start] không lấy được MagicDNS name — chạy `tailscale status` để tự tra URL');
}

let hub;
let shuttingDown = false;

function spawnHub() {
  const child = spawn('npx', ['mcp-hub', '--port', hubPort, '--config', HUB_CONFIG_PATH], {
    stdio: 'inherit',
    env: { ...process.env, MCP_DATA_DIR: dataDir },
  });
  // Only an unexpected death tears the stack down; a restart detaches the old child first.
  child.on('exit', () => child === hub && shutdown());
  hub = child;
}

function restartHub() {
  const old = hub;
  hub = null;
  old.once('exit', spawnHub);
  old.kill();
}

spawnHub();
const gate = spawn('node', ['./scripts/gatekeeper.js'], {
  stdio: 'inherit',
  env: { ...process.env, MCP_HUB_PORT: hubPort, GATEKEEPER_PORT: gatePort, PUBLIC_ORIGIN: origin || '' },
});

const panel = startPanel({ port: Number(panelPort), token: panelToken, origin, client, passphrase, dataDir, restartHub });
const panelUrl = `http://127.0.0.1:${panelPort}/?t=${panelToken}`;
try {
  execFileSync('open', [panelUrl]);
} catch (e) {
  console.error(`[start] không tự mở được panel (mở tay: ${panelUrl}): ${e.message}`);
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
