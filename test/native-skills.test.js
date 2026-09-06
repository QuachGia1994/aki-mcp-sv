import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_ENTRIES } from '../scripts/build/targets.js';

const browser = readFileSync(new URL('../skills/browser/SKILL.md', import.meta.url), 'utf8');
const imagegen = readFileSync(new URL('../skills/imagegen/SKILL.md', import.meta.url), 'utf8');
const ponytail = readFileSync(new URL('../skills/ponytail/SKILL.md', import.meta.url), 'utf8');
const mobileNative = readFileSync(new URL('../skills/mobile-native/SKILL.md', import.meta.url), 'utf8');
const strix = readFileSync(new URL('../skills/strix/SKILL.md', import.meta.url), 'utf8');
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

test('ponytail skill prefers deletion/reuse/native behavior without weakening safety floors', () => {
  assert.match(ponytail, /^---\nname: aki-ponytail\n/m);
  assert.match(ponytail, /Does the repo already have the behavior or abstraction\? Reuse it/);
  assert.match(ponytail, /native platform\/framework already provide it/);
  assert.match(ponytail, /Never simplify away authentication\/authorization/);
});

test('mobile-native skill keeps real system navigation across iOS 27+, Expo, and Tauri mobile', () => {
  assert.match(mobileNative, /^---\nname: aki-mobile-native\n/m);
  assert.match(mobileNative, /Use `TabView` \+ `Tab`/);
  assert.match(mobileNative, /`expo-router\/unstable-native-tabs`/);
  assert.match(mobileNative, /Tauri with React renders the frontend in a system webview; it is not React Native/);
  assert.match(mobileNative, /Preserve that stack unless the user explicitly asks for a migration/);
});

test('strix skill separates passive GitHub repo risk review from authorized active pentesting', () => {
  assert.match(strix, /^---\nname: aki-strix\n/m);
  assert.match(strix, /Active probing of a live domain\/API\/IP requires that the user owns the target or is authorized/);
  assert.match(strix, /A zero-finding result is not proof of safety if the run stopped early/);
  assert.match(strix, /\*\*CERTAIN\*\*.*deterministic test/s);
});

test('default Prompt Instructions route browser, imagegen, ponytail, mobile-native, and strix skills through the Aki repo', () => {
  assert.match(panelClient, /Skills ' \+ REPO_ROOT \+ '\/skills: web=browser;img=imagegen;code=ponytail;mobile=mobile-native;risk=strix; read SKILL\.md\./);
});
