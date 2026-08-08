// Minimal CDP client, no dependency: Node 22 ships WebSocket. Chrome opens its debug port only at launch, so quitting a running Chrome is unavoidable — and confined to restartChrome(); everything else here never closes anything.
import { setTimeout as sleep } from 'node:timers/promises';
import { IS_MAC, IS_WIN, execCapture, findChrome } from './platform.js';

const CDP_PORT = Number(process.env.CHROME_CDP_PORT || 9222);
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const CHROME_APP = 'Google Chrome';
const READY_TIMEOUT_MS = 20_000;

async function probe() {
  try {
    return await (await fetch(`${CDP_BASE}/json`)).json();
  } catch {
    return null;
  }
}

// macOS: AppleScript quit so Chrome writes its session out, then --restore-last-session. Windows: taskkill without /F first.
async function isRunning() {
  if (IS_MAC) return (await execCapture('pgrep', ['-x', CHROME_APP])) !== null;
  if (IS_WIN) {
    const out = await execCapture('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH']);
    return !!(out && /chrome\.exe/i.test(out));
  }
  return (await execCapture('pgrep', ['-f', 'chrome|chromium'])) !== null;
}

async function quitChrome() {
  if (IS_MAC) return execCapture('osascript', ['-e', `quit app "${CHROME_APP}"`]);
  if (IS_WIN) {
    await execCapture('taskkill', ['/IM', 'chrome.exe']);
    return null;
  }
  return execCapture('pkill', ['-f', 'chrome|chromium']);
}

async function launchChrome() {
  const args = [`--remote-debugging-port=${CDP_PORT}`, '--restore-last-session'];
  if (IS_MAC) {
    return execCapture('open', ['-a', CHROME_APP, '--args', ...args]);
  }
  const bin = process.env.CHROME_PATH || findChrome();
  if (!bin) throw new Error('Google Chrome not found — install it or set CHROME_PATH');
  return execCapture(bin, args);
}

async function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(400);
  }
  return null;
}

async function waitReady() {
  if (await waitUntil(probe, READY_TIMEOUT_MS)) return;
  throw new Error(`Chrome didn't open debug port ${CDP_PORT} within ${READY_TIMEOUT_MS / 1000}s — try opening Chrome with --remote-debugging-port=${CDP_PORT}`);
}

// Never quits anything. `needsRestart` hands the decision back to the user instead of taking it.
export async function connectChrome() {
  if (await probe()) return { state: 'ready', message: 'Chrome is ready' };
  if (await isRunning()) {
    return {
      state: 'needsRestart',
      message: 'Chrome is open but its debug port isn\'t enabled — Chrome can only turn that on at launch, so it has to be reopened before it can be controlled.',
    };
  }
  await launchChrome();
  await waitReady();
  return { state: 'ready', message: 'opened Chrome with the debug port enabled' };
}

export async function restartChrome() {
  if (await isRunning()) {
    await quitChrome();
    await waitUntil(async () => !(await isRunning()), 10_000);
  }
  await launchChrome();
  await waitReady();
  return { state: 'ready', message: 'Chrome reopened with the debug port enabled, previous tabs restored' };
}

export async function listTabs() {
  const targets = await probe();
  if (!targets) throw new Error('Chrome isn\'t connected yet — click "Connect Chrome" first');
  return targets
    .filter((t) => t.type === 'page')
    .map(({ id, title, url, webSocketDebuggerUrl }) => ({ id, title, url, ws: webSocketDebuggerUrl }));
}

export async function evaluate(tabId, expression) {
  const tab = (await listTabs()).find((t) => t.id === tabId);
  if (!tab) throw new Error(`tab ${tabId} not found`);
  if (!tab.ws) throw new Error('tab has no debugger endpoint');

  const ws = new WebSocket(tab.ws);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('failed to open CDP WebSocket')), { once: true });
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP did not respond within 10s')), 10_000);
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== 1) return;
        clearTimeout(timer);
        resolve(msg);
      });
    });
    if (reply.error) throw new Error(reply.error.message);
    const { result, exceptionDetails } = reply.result;
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value ?? null;
  } finally {
    ws.close();
  }
}
