import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_ENTRIES } from '../scripts/build/targets.js';

const browser = readFileSync(new URL('../skills/browser/SKILL.md', import.meta.url), 'utf8');
const imagegen = readFileSync(new URL('../skills/imagegen/SKILL.md', import.meta.url), 'utf8');
const panelClient = readFileSync(new URL('../public/panel-client.js', import.meta.url), 'utf8');

test('standalone payload ships native host skill docs', () => {
  assert.ok(APP_ENTRIES.includes('skills'), 'skills directory must ship in standalone payloads');
});

test('browser skill routes live/current evidence to host-native web tools without inventing fallback', () => {
  assert.match(browser, /^---\nname: aki-browser\n/m);
  assert.match(browser, /Prefer the current host's native browser\/web\/search capability/);
  assert.match(browser, /Do not invent a browser tool or silently install Playwright\/Chrome automation/);
  assert.match(browser, /browser evidence pass first, then apply `\.\.\/imagegen\/SKILL\.md`/);
});

test('imagegen skill routes concepts and edits to host-native generation and refuses fake substitutes', () => {
  assert.match(imagegen, /^---\nname: aki-imagegen\n/m);
  assert.match(imagegen, /Prefer the current host's native image generation\/editing tool/);
  assert.match(imagegen, /Do not substitute unrelated web images or claim an image was generated when no image tool ran/);
  assert.match(imagegen, /first apply `\.\.\/browser\/SKILL\.md`/);
});

test('default Prompt Instructions route browser and imagegen skills through the Aki repo', () => {
  assert.match(panelClient, /Aki skills ' \+ REPO_ROOT \+ '\/skills: web\/live=>browser; concept\/art\/image\/edit=>imagegen\. Read SKILL\.md; use host-native tools\./);
});
