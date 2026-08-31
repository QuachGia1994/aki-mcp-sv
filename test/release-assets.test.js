import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_ENTRIES } from '../scripts/build/targets.js';

test('standalone payload includes every Postman walkthrough screenshot', () => {
  for (const step of [1, 2, 3]) {
    assert.ok(
      APP_ENTRIES.includes(`public/img/aki-mcp-instruct-postman-${step}.png`),
      `missing Postman screenshot ${step} from APP_ENTRIES`,
    );
  }
});
