#!/usr/bin/env node
import assert from 'node:assert/strict';
import { ROUTES } from '../scripts/panel.js';

const result = await ROUTES['POST /api/alibaba-review']({}, {});
assert.equal(result.ok, true);
assert.equal(result.launched, true);
assert.ok(Number.isInteger(result.pid) && result.pid > 0);
assert.match(result.message, /Claude PM/i);
console.log('alibaba-review.test.js: ok');
