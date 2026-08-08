// Tiny OS differences so the rest of the code can stay free of `win32` checks.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

const require = createRequire(import.meta.url);

/** mcp-hub's CLI entry — spawn via node so Windows never has to resolve `npx.cmd`. */
export function hubCliPath() {
  return require.resolve('mcp-hub/dist/cli.js');
}

/** Env every child of `npm start` should inherit — ensures `${HOME}` placeholders in mcp-hub config resolve on Windows. */
export function childEnv(extra = {}) {
  const home = process.env.HOME || os.homedir();
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: process.env.USERPROFILE || home,
    ...extra,
  };
}

export function spawnNode(scriptOrArgs, opts = {}) {
  const args = Array.isArray(scriptOrArgs) ? scriptOrArgs : [scriptOrArgs];
  return spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true, ...opts });
}

export function openUrl(url) {
  if (IS_MAC) execFileSync('open', [url]);
  else if (IS_WIN) execFileSync('cmd', ['/c', 'start', '', url], { windowsHide: true });
  else execFileSync('xdg-open', [url]);
}

export function findChrome() {
  if (IS_MAC) return null; // launched via `open -a`
  if (IS_WIN) {
    const candidates = [
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return candidates.find((p) => p && existsSync(p)) || null;
  }
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      execFileSync('which', [bin], { stdio: 'ignore' });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function execCapture(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15_000, windowsHide: true, ...opts }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}
