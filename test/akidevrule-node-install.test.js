import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

test('Aki panels install the QuachGia fork through Node, never the retired Python installer', () => {
  const panel = read('scripts/panel.js');
  const pmcontrol = read('scripts/aki-pmcontrol/index.js');
  const config = read('scripts/config-page.js');

  for (const source of [panel, pmcontrol]) {
    assert.match(source, /QuachGia1994\/akidevrule\.git/);
    assert.match(source, /install\.mjs/);
    assert.doesNotMatch(source, /install\.py|py -3 install\.py|No Python 3 found/);
  }

  assert.match(config, /QuachGia1994\/akidevrule/);
  assert.match(config, /node install\.mjs/);
  assert.doesNotMatch(config, /py -3 install\.py/);
});
