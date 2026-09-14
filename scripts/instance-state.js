import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { USER_DIR } from './userdata.js';

export const INSTANCE_STATE_PATH = path.join(USER_DIR, 'instance.json');

export function readInstanceState(file = INSTANCE_STATE_PATH) {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && value.instanceId ? value : null;
  } catch {
    return null;
  }
}

export function writeInstanceState(record, file = INSTANCE_STATE_PATH) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  renameSync(temp, file);
  return record;
}

export function clearInstanceState(instanceId, file = INSTANCE_STATE_PATH) {
  const current = readInstanceState(file);
  if (!current || current.instanceId !== instanceId) return false;
  writeFileSync(file, '', { mode: 0o600 });
  return true;
}

function instanceUrl(state, pathname) {
  return `http://127.0.0.1:${state.panelPort}${pathname}`;
}

export async function probeLiveInstance(state, { fetchImpl = fetch, timeoutMs = 800 } = {}) {
  if (!state?.instanceId || !state?.panelPort || !state?.token) return null;
  try {
    const response = await fetchImpl(instanceUrl(state, '/api/instance'), {
      headers: { 'x-panel-token': state.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const live = await response.json();
    return live?.instanceId === state.instanceId ? live : null;
  } catch {
    return null;
  }
}

export async function requestInstanceHandoff(state, { fetchImpl = fetch, timeoutMs = 800 } = {}) {
  if (!state?.panelPort || !state?.token) return false;
  try {
    const response = await fetchImpl(instanceUrl(state, '/api/instance-handoff'), {
      method: 'POST',
      headers: { 'x-panel-token': state.token, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForInstanceRelease(state, { timeoutMs = 3000, pollMs = 50, probe = probeLiveInstance } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await probe(state)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !await probe(state);
}

export async function prepareExistingInstance(state, currentRuntimeId, {
  probe = probeLiveInstance,
  handoff = requestInstanceHandoff,
  wait = waitForInstanceRelease,
} = {}) {
  if (!state) return { action: 'continue' };
  const live = await probe(state);
  if (!live) return { action: 'continue' };
  if (live.runtimeId === currentRuntimeId) return { action: 'reuse', state, live };
  if (!await handoff(state)) throw new Error(`running akimcp v${live.version || 'unknown'} did not accept the handoff request`);
  if (!await wait(state)) throw new Error(`running akimcp v${live.version || 'unknown'} did not release its local endpoints in time`);
  return { action: 'continue' };
}
