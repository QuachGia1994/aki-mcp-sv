import test from 'node:test';
import assert from 'node:assert/strict';
import { searchContent, toMatcher } from '../scripts/search-mcp.js';

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
