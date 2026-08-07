// Minimal CDP client, no dependency: Node 22 ships WebSocket. Chrome opens its debug port only at launch, so quitting a running Chrome is unavoidable — and confined to restartChrome(); everything else here never closes anything.
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CDP_PORT = Number(process.env.CHROME_CDP_PORT || 9222);
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const CHROME_APP = 'Google Chrome';
const READY_TIMEOUT_MS = 20_000;

const exec = (bin, args) =>
  new Promise((resolve) => execFile(bin, args, { timeout: 15_000 }, (err, stdout) => resolve(err ? null : stdout)));

async function probe() {
  try {
    return await (await fetch(`${CDP_BASE}/json`)).json();
  } catch {
    return null;
  }
}

// `quit app` is AppleScript's graceful quit: Chrome writes its session out, so --restore-last-session brings every tab back. A kill would lose them.
const isRunning = async () => (await exec('pgrep', ['-x', CHROME_APP])) !== null;
const quitChrome = () => exec('osascript', ['-e', `quit app "${CHROME_APP}"`]);
const launchChrome = () =>
  exec('open', ['-a', CHROME_APP, '--args', `--remote-debugging-port=${CDP_PORT}`, '--restore-last-session']);

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
  throw new Error(`Chrome didn't open debug port ${CDP_PORT} within ${READY_TIMEOUT_MS / 1000}s — try opening it manually: open -a "${CHROME_APP}" --args --remote-debugging-port=${CDP_PORT}`);
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
