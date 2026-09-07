import test from 'node:test';
import assert from 'node:assert/strict';
import { toMatcher } from '../scripts/search-mcp.js';

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
