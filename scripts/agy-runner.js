import { execFile } from 'node:child_process';

export const DEFAULT_AGY_MODEL = 'gemini-3.7-flash-medium';
export const DEFAULT_AGY_TIMEOUT_MS = 120_000;
export const DEFAULT_AGY_MAX_BUFFER = 4 * 1024 * 1024;

export function buildAgyArgs({ prompt, mode = 'plan', model = DEFAULT_AGY_MODEL, effort, outputFormat }) {
  const args = ['--mode', mode, '--model', model];
  if (effort) args.push('--effort', effort);
  if (outputFormat) args.push('--output-format', outputFormat);
  args.push('-p', prompt);
  return args;
}

export function runAgyProcess(
  { prompt, mode = 'plan', model = DEFAULT_AGY_MODEL, effort, outputFormat, cwd, agyBin = 'agy' },
  { execFileImpl = execFile, timeoutMs = DEFAULT_AGY_TIMEOUT_MS, maxBuffer = DEFAULT_AGY_MAX_BUFFER, signal } = {},
) {
  const args = buildAgyArgs({ prompt, mode, model, effort, outputFormat });
  return new Promise((resolve, reject) => {
    execFileImpl(agyBin, args, { cwd, timeout: timeoutMs, maxBuffer, signal, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stdout || stderr || error.message).trim()));
        return;
      }
      if (!stdout || !stdout.trim()) {
        reject(new Error('agy returned no output — the call may have been silently denied rather than a clean empty result. Re-check the prompt/scope.'));
        return;
      }
      resolve(stdout);
    });
  });
}
