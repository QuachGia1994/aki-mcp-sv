import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBody } from '../scripts/http.js';
import { dcrRateLimitAvailable, dcrRegistrationAvailable, handleRegister, isAllowedRedirect, pruneUnusedDcrClients, shouldRotateRefresh, rotateRefreshGrant } from '../scripts/oauth.js';
import { DEFAULT_ALLOWLIST, parseSettingsText } from '../scripts/allowlist.js';
import { containedIn, pathIdentity, resolveRealUnderRoot, resolveRealUnderRootSync } from '../scripts/roots.js';
import { resolveExecFileTarget, trustedInterpreterScriptArg, validateAllowedCommandArgs } from '../scripts/shell-mcp.js';

test('readBody rejects declared and streamed bodies above the configured cap', async () => {
  const declared = Readable.from(['small']);
  declared.headers = { 'content-length': '1000' };
  await assert.rejects(readBody(declared, 32), (error) => error?.code === 'BODY_TOO_LARGE' && error.limit === 32);

  const streamed = Readable.from([Buffer.alloc(20), Buffer.alloc(20)]);
  streamed.headers = {};
  await assert.rejects(readBody(streamed, 32), (error) => error?.code === 'BODY_TOO_LARGE' && error.limit === 32);
});

test('public OAuth registration applies the body cap before parsing or persistence', async () => {
  const req = Readable.from(['{}']);
  req.headers = { 'content-length': String(64 * 1024 + 1) };
  const res = {
    status: null,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = body; },
  };
  await handleRegister(req, res);
  assert.equal(res.status, 413);
  assert.match(res.body, /invalid_client_metadata/);
});

test('trusted interpreter preallow only accepts a script as argv[0]', () => {
  const trusted = 'C:\\Users\\User\\.aki\\scripts\\safe.js';
  assert.equal(trustedInterpreterScriptArg('node', [trusted, '--flag']), trusted);
  assert.equal(trustedInterpreterScriptArg('node', ['--require', trusted, '-e', 'process.exit()']), null);
  assert.equal(trustedInterpreterScriptArg('python3', ['-c', 'print(1)']), null);
  assert.equal(trustedInterpreterScriptArg('bash', [trusted]), null);
});

test('default shell allowlist excludes package-script execution entrypoints', () => {
  assert.deepEqual(DEFAULT_ALLOWLIST.npm, ['list', 'ls', 'outdated']);
  assert.equal('npx' in DEFAULT_ALLOWLIST, false);
});

test('malformed settings fail closed instead of becoming an empty/default configuration', () => {
  assert.throws(() => parseSettingsText('{broken'), /JSON/);
  assert.throws(() => parseSettingsText('[]'), /settings root must be a JSON object/);
  assert.deepEqual(parseSettingsText('{"folders":["D:\\\\Safe"]}').folders, ['D:\\Safe']);
});

test('path identity lowercases only on Windows-like filesystems', () => {
  const mixed = path.resolve('CaseSensitive', 'Repo');
  assert.equal(pathIdentity(mixed, { platform: 'linux' }), mixed);
  assert.equal(pathIdentity(mixed, { platform: 'win32' }), mixed.toLowerCase());
});

test('filesystem-root containment accepts descendants without duplicating the root separator', () => {
  const filesystemRoot = path.parse(process.execPath).root;
  assert.equal(containedIn(process.execPath, filesystemRoot), true);
  assert.doesNotThrow(() => resolveRealUnderRootSync(process.execPath, { roots: [filesystemRoot] }));
});

test('real-root resolver rejects a symlink or junction whose target leaves the allowed root', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'aki-root-boundary-'));
  const root = path.join(temp, 'root');
  const outside = path.join(temp, 'outside');
  const escape = path.join(root, 'escape');
  mkdirSync(root);
  mkdirSync(outside);
  try {
    symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(pathIdentity(resolveRealUnderRootSync(root, { roots: [root] })), pathIdentity(root));
    assert.throws(() => resolveRealUnderRootSync(escape, { roots: [root] }), /escapes the allowed roots/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('async real-root resolver canonicalizes an allowed symlink or junction root', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'aki-async-root-'));
  const realRoot = path.join(temp, 'real-root');
  const linkedRoot = path.join(temp, 'linked-root');
  const file = path.join(realRoot, 'file.txt');
  mkdirSync(realRoot);
  try {
    symlinkSync(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, 'ok'));
    const resolved = await resolveRealUnderRoot(path.join(linkedRoot, 'file.txt'), { roots: [linkedRoot] });
    assert.equal(pathIdentity(resolved), pathIdentity(file));
    const newFile = path.join(linkedRoot, 'new.txt');
    assert.equal(pathIdentity(await resolveRealUnderRoot(newFile, { roots: [linkedRoot] })), pathIdentity(newFile));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('default shell policy rejects filesystem escape args and mutating git query subcommands', () => {
  const root = path.resolve('sandbox-root');
  const outside = path.resolve(root, '..', 'outside.txt');
  assert.throws(() => validateAllowedCommandArgs('cat', [outside], root, { roots: [root] }), /escapes the allowed roots/);
  assert.throws(() => validateAllowedCommandArgs('grep', [`-f${outside}`], root, { roots: [root] }), /escapes the allowed roots/);
  assert.throws(() => validateAllowedCommandArgs('git', ['branch', '-D', 'main'], root, { roots: [root] }), /restricted to listing/);
  assert.throws(() => validateAllowedCommandArgs('git', ['remote', 'remove', 'origin'], root, { roots: [root] }), /restricted to listing/);
  assert.throws(() => validateAllowedCommandArgs('git', ['tag', '-d', 'v1'], root, { roots: [root] }), /restricted to listing/);
  assert.throws(() => validateAllowedCommandArgs('git', ['diff', '--ext-diff'], root, { roots: [root] }), /execute helpers or write output/);
  assert.doesNotThrow(() => validateAllowedCommandArgs('git', ['branch', '--show-current'], root, { roots: [root] }));
});

test('Windows npm shims run through node instead of execFile on .cmd', () => {
  const execPath = String.raw`D:\Program Files\nodejs\node.exe`;
  const npmCli = String.raw`D:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`;
  const resolved = resolveExecFileTarget('npm', ['test'], {
    platform: 'win32',
    execPath,
    exists: (candidate) => candidate === npmCli,
  });
  assert.equal(resolved.file, execPath);
  assert.deepEqual(resolved.args, [npmCli, 'test']);
});

test('non-Windows shell commands remain untouched', () => {
  assert.deepEqual(resolveExecFileTarget('npm', ['test'], { platform: 'linux' }), { file: 'npm', args: ['test'] });
});

test('DCR redirect allowlist includes Antigravity 2.0 callback and rejects unrelated paths', () => {
  assert.equal(isAllowedRedirect('https://antigravity.google/oauth-callback'), true);
  assert.equal(isAllowedRedirect('https://antigravity.google/not-the-callback'), false);
});

test('DCR registration storage is bounded and stale unauthenticated registrations are reclaimable', () => {
  assert.equal(dcrRegistrationAvailable({}, 2), true);
  assert.equal(dcrRegistrationAvailable({ a: {}, b: {} }, 2), false);
  const map = { stale: { registeredAt: 1 }, active: { registeredAt: 1 }, legacy: {} };
  pruneUnusedDcrClients(map, { now: 10_000, ttlMs: 1000, activeClientIds: new Set(['active']) });
  assert.equal('stale' in map, false);
  assert.equal('active' in map, true);
  assert.equal('legacy' in map, true);
  assert.equal(map.legacy.registeredAt, 10_000);
});

test('DCR registration burst limiter expires old events instead of filling storage indefinitely', () => {
  const events = [100, 200, 950];
  assert.equal(dcrRateLimitAvailable(events, { now: 1000, windowMs: 500, max: 2 }), true);
  assert.deepEqual(events, [950]);
  events.push(990);
  assert.equal(dcrRateLimitAvailable(events, { now: 1000, windowMs: 500, max: 2 }), false);
});

test('public clients rotate refresh grants while confidential clients retain compatibility', () => {
  assert.equal(shouldRotateRefresh({ tokenEndpointAuthMethod: 'none' }), true);
  assert.equal(shouldRotateRefresh({ tokenEndpointAuthMethod: 'client_secret_post' }), false);

  const store = new Map([['old-refresh', { clientId: 'client-1' }]]);
  const next = rotateRefreshGrant(store, 'old-refresh', 'client-1', () => 'new-refresh');
  assert.equal(next, 'new-refresh');
  assert.equal(store.has('old-refresh'), false);
  assert.deepEqual(store.get('new-refresh'), { clientId: 'client-1' });
});
