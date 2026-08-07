#!/usr/bin/env node
// Orchestrates mcp-hub + gatekeeper behind 1 `npm start`; foreground by design, manual stop/start only
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { loadOrCreateClient, loadOrCreatePassphrase } from './oauth.js';
import { writeConfigPage } from './config-page.js';

const dataDir = process.env.MCP_DATA_DIR; // default is set once, by `start` in package.json
const hubPort = process.env.MCP_HUB_PORT || '19999';
const gatePort = process.env.GATEKEEPER_PORT || '9999';

mkdirSync(`${process.cwd()}/data`, { recursive: true });

const client = loadOrCreateClient();
const passphrase = loadOrCreatePassphrase();

function ensureFunnel() {
  let json = {};
  try {
    json = JSON.parse(execFileSync('tailscale', ['funnel', 'status', '--json'], { encoding: 'utf8', timeout: 8000 }));
  } catch {
    console.error('[start] không gọi được `tailscale funnel status` — kiểm tra tailscale đã cài/login chưa.');
    return;
  }
  const allowed = json.AllowFunnel || {};
  const alreadyOn = Object.keys(allowed).some((k) => k.endsWith(`:${gatePort}`) && allowed[k]);
  if (alreadyOn) return;
  try {
    execFileSync('tailscale', ['funnel', '--bg', gatePort], { encoding: 'utf8', timeout: 8000 });
    console.log(`[start] đã bật funnel --bg ${gatePort}`);
  } catch (e) {
    console.error(`[start] bật funnel thất bại: ${e.message}`);
  }
}

function publicOrigin() {
  try {
    const json = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 8000 }));
    const dns = (json.Self?.DNSName || '').replace(/\.$/, '');
    return dns ? `https://${dns}` : null;
  } catch {
    return null;
  }
}

ensureFunnel();
const origin = publicOrigin();

if (origin) {
  console.log(`[start] Remote MCP server URL: ${origin}/mcp`);
  console.log(`[start] OAuth Client ID: ${client.clientId}`);
  console.log(`[start] OAuth Client Secret: ${client.clientSecret}`);
  console.log('[start] dán cả 3 giá trị trên vào Add custom connector (URL + Advanced settings)');
  console.log(`[start] Passphrase (nhập khi trình duyệt mở trang xác nhận): ${passphrase}`);
  const configFile = `${process.cwd()}/data/config.html`;
  writeConfigPage(configFile, { origin, client, passphrase });
  console.log(`[start] GUI copy config (URL/secret/passphrase + prompt + extension): ${configFile}`);
  try {
    execFileSync('open', [configFile]);
  } catch (e) {
    console.error(`[start] không tự mở được config.html (mở tay: open ${configFile}): ${e.message}`);
  }
} else {
  console.error('[start] không lấy được MagicDNS name — chạy `tailscale status` để tự tra URL');
}

const hub = spawn('npx', ['mcp-hub', '--port', hubPort, '--config', './mcp-hub.config.json'], {
  stdio: 'inherit',
  env: { ...process.env, MCP_DATA_DIR: dataDir },
});
const gate = spawn('node', ['./scripts/gatekeeper.js'], {
  stdio: 'inherit',
  env: { ...process.env, MCP_HUB_PORT: hubPort, GATEKEEPER_PORT: gatePort, PUBLIC_ORIGIN: origin || '' },
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  hub.kill();
  gate.kill();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
hub.on('exit', shutdown);
gate.on('exit', shutdown);
