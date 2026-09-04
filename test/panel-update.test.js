import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencyInstallArgs } from '../scripts/panel.js';

test('dependency refresh runs npm ci when package metadata changed and lockfile exists', () => {
  assert.deepEqual(dependencyInstallArgs('README.md\npackage-lock.json\n', true), ['ci']);
  assert.deepEqual(dependencyInstallArgs('package.json\n', true), ['ci']);
});

test('dependency refresh falls back to npm install without a lockfile', () => {
  assert.deepEqual(dependencyInstallArgs('package.json\n', false), ['install']);
});

test('dependency refresh skips npm when package metadata is unchanged', () => {
  assert.equal(dependencyInstallArgs('README.md\nscripts/panel.js\n', true), null);
  assert.equal(dependencyInstallArgs('', true), null);
});
