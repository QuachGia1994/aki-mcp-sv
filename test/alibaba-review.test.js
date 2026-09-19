#!/usr/bin/env node
import assert from 'node:assert/strict';
import { ROUTES } from '../scripts/panel.js';

const result = await ROUTES['POST /api/alibaba-review']({}, {});
assert.ok(result && (result.mode === 'json' || result.mode === 'text'));
if (result.mode === 'json') {
  assert.equal(typeof result.output, 'object');
}
console.log('alibaba-review.test.js: ok');
