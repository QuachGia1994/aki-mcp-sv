import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGrepExecutable, searchContent, toMatcher } from '../scripts/search-mcp.js';

test('glob matcher keeps documented star/question semantics without regex backtracking', () => {
  const basename = toMatcher('*.test.js');
  assert.equal(basename('src/security.test.js'), true);
  assert.equal(basename('src/security.test.ts'), false);

  const oneChar = toMatcher('file?.txt');
  assert.equal(oneChar('nested/file1.txt'), true);
  assert.equal(oneChar('nested/file10.txt'), false);

  const adversarial = toMatcher('*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b');
  assert.equal(adversarial(`nested/${'a'.repeat(256)}c`), false);
});

test('glob matcher rejects oversized wildcard patterns before tree traversal', () => {
  assert.throws(() => toMatcher('*'.repeat(257)), /glob pattern exceeds 256 characters/);
});

test('Windows resolves Git for Windows grep beside git on PATH without changing PATH', () => {
  const git = String.raw`C:\Program Files\Git\cmd\git.exe`;
  const grep = String.raw`C:\Program Files\Git\usr\bin\grep.exe`;
  const pathValue = [String.raw`C:\Windows\System32`, `"${String.raw`C:\Program Files\Git\cmd`}"`].join(';');
  const checked = [];
  const originalPath = process.env.PATH;
  const resolved = resolveGrepExecutable({ platform: 'win32', env: { PATH: pathValue }, exists: (candidate) => {
    checked.push(candidate);
    return candidate === git || candidate === grep;
  } });
  assert.equal(resolved, grep);
  assert.ok(checked.includes(git));
  assert.ok(checked.includes(grep));
  assert.equal(process.env.PATH, originalPath);
});

test('non-Windows keeps the bare GNU grep name', () => {
  assert.equal(resolveGrepExecutable({ platform: 'linux', env: {}, exists: () => { throw new Error('must not inspect PATH'); } }), 'grep');
});

test('Windows resolves grep from the Git for Windows MinGW layout', () => {
  const git = String.raw`C:\Program Files\Git\mingw64\bin\git.exe`;
  const grep = String.raw`C:\Program Files\Git\usr\bin\grep.exe`;
  const resolved = resolveGrepExecutable({
    platform: 'win32',
    env: { PATH: String.raw`C:\Program Files\Git\mingw64\bin` },
    exists: (candidate) => candidate === git || candidate === grep,
  });
  assert.equal(resolved, grep);
});

test('Windows falls back to PATH grep when Git for Windows has no bundled grep', () => {
  const git = String.raw`C:\Program Files\Git\cmd\git.exe`;
  const resolved = resolveGrepExecutable({
    platform: 'win32',
    env: { PATH: String.raw`C:\Program Files\Git\cmd` },
    exists: (candidate) => candidate === git,
  });
  assert.equal(resolved, 'grep');
});

test('search_content passes the resolved executable to execFile', async () => {
  const expected = String.raw`C:\Program Files\Git\usr\bin\grep.exe`;
  const run = (executable, _args, _options, callback) => {
    assert.equal(executable, expected);
    callback(Object.assign(new Error('no match'), { code: 1 }), '', '');
  };
  assert.match(await searchContent('needle', process.cwd(), undefined, 10, { run, resolveGrep: () => expected }), /no lines matched/);
});

test('Windows search_content runs with the bundled GNU grep', { skip: process.platform !== 'win32' }, async () => {
  const executable = resolveGrepExecutable();
  assert.match(executable, /[\\/]usr[\\/]bin[\\/]grep\.exe$/i);
  const result = await searchContent('resolveGrepExecutable', process.cwd(), 'search-mcp.js', 1);
  assert.match(result, /matching line\(s\):/);
});

test('search_content rejects execution failures instead of reporting no matches or partial success', async () => {
  for (const [error, stdout, stderr] of [
    [Object.assign(new Error('spawn grep ENOENT'), { code: 'ENOENT' }), '', ''],
    [Object.assign(new Error('grep timed out'), { code: null, killed: true }), 'file:1:partial\n', ''],
    [Object.assign(new Error('grep failed'), { code: 2 }), '', 'invalid regular expression'],
  ]) {
    const run = (_bin, _args, options, callback) => {
      assert.equal(options.windowsHide, true);
      callback(error, stdout, stderr);
    };
    await assert.rejects(searchContent('needle', process.cwd(), undefined, 10, { run }), /grep|regular expression/);
  }
});

test('search_content distinguishes no matches from a successful bounded result', async () => {
  const missing = (_bin, _args, _options, callback) => callback(Object.assign(new Error('no match'), { code: 1 }), '', '');
  assert.match(await searchContent('needle', process.cwd(), undefined, 10, { run: missing }), /no lines matched/);
  const found = (_bin, _args, _options, callback) => callback(null, 'one:1:needle\ntwo:2:needle\n', '');
  const result = await searchContent('needle', process.cwd(), '*.js', 1, { run: found });
  assert.match(result, /2 matching line/);
  assert.match(result, /one:1:needle/);
  assert.doesNotMatch(result, /two:2:needle/);
});
