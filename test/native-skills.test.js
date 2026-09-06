import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_ENTRIES } from '../scripts/build/targets.js';

const browser = readFileSync(new URL('../skills/browser/SKILL.md', import.meta.url), 'utf8');
const imagegen = readFileSync(new URL('../skills/imagegen/SKILL.md', import.meta.url), 'utf8');
const ponytail = readFileSync(new URL('../skills/ponytail/SKILL.md', import.meta.url), 'utf8');
const antiVibe = readFileSync(new URL('../skills/anti-vibecoding/SKILL.md', import.meta.url), 'utf8');
const mobileNative = readFileSync(new URL('../skills/mobile-native/SKILL.md', import.meta.url), 'utf8');
const iconSilhouette = readFileSync(new URL('../skills/icon-silhouette/SKILL.md', import.meta.url), 'utf8');
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
  assert.match(imagegen, /app\/launcher icon, also apply `\.\.\/icon-silhouette\/SKILL\.md`/);
});

test('ponytail skill prefers deletion/reuse/native behavior without weakening safety floors', () => {
  assert.match(ponytail, /^---\nname: aki-ponytail\n/m);
  assert.match(ponytail, /Does the repo already have the behavior or abstraction\? Reuse it/);
  assert.match(ponytail, /native platform\/framework already provide it/);
  assert.match(ponytail, /Never simplify away authentication\/authorization/);
});

test('anti-vibecoding skill requires evidence, deterministic verification, and convergence', () => {
  assert.match(antiVibe, /^---\nname: aki-anti-vibecoding\n/m);
  assert.match(antiVibe, /A screenshot, error string, or model explanation is a lead, not proof of root cause/);
  assert.match(antiVibe, /After two failed implementations of the same hypothesis, stop stacking patches/);
  assert.match(antiVibe, /Never report a task as fixed\/complete merely because/);
  assert.match(antiVibe, /Does the implementation satisfy the stated goal\?/);
  assert.match(antiVibe, /Use `\.\.\/ponytail\/SKILL\.md` to keep the eventual fix minimal/);
});

test('mobile-native skill keeps real system navigation across iOS 27+, Expo, and Tauri mobile', () => {
  assert.match(mobileNative, /^---\nname: aki-mobile-native\n/m);
  assert.match(mobileNative, /Use `TabView` \+ `Tab`/);
  assert.match(mobileNative, /`expo-router\/unstable-native-tabs`/);
  assert.match(mobileNative, /Tauri with React renders the frontend in a system webview; it is not React Native/);
  assert.match(mobileNative, /Preserve that stack unless the user explicitly asks for a migration/);
  assert.match(mobileNative, /square-white-corner bugs, load `\.\.\/icon-silhouette\/SKILL\.md`/);
});

test('icon-silhouette skill forbids baked white squares and preserves platform masking contracts', () => {
  assert.match(iconSilhouette, /^---\nname: aki-icon-silhouette\n/m);
  assert.match(iconSilhouette, /silhouette-first, container-second/);
  assert.match(iconSilhouette, /Do not solve an Android white-corner bug by manually rounding the PNG/);
  assert.match(iconSilhouette, /provide square, \*\*unmasked\*\* icon layers\/source and let the system apply the final rounded shape/);
  assert.match(iconSilhouette, /foregroundImage.*transparent silhouette asset/s);
  assert.match(iconSilhouette, /Build\/install and inspect the icon on at least one real Android launcher/);
});

test('strix skill separates passive GitHub repo risk review from authorized active pentesting', () => {
  assert.match(strix, /^---\nname: aki-strix\n/m);
  assert.match(strix, /Active probing of a live domain\/API\/IP requires that the user owns the target or is authorized/);
  assert.match(strix, /A zero-finding result is not proof of safety if the run stopped early/);
  assert.match(strix, /\*\*CERTAIN\*\*.*deterministic test/s);
});

test('default Prompt Instructions route primary skills while chained skills cover Ponytail and Icon Silhouette', () => {
  assert.match(panelClient, /Skills ' \+ REPO_ROOT \+ '\/skills: web=browser;img=imagegen;code=anti-vibecoding;mobile=mobile-native;risk=strix; read SKILL\.md\./);
  assert.match(imagegen, /icon-silhouette\/SKILL\.md/);
  assert.match(mobileNative, /icon-silhouette\/SKILL\.md/);
  assert.match(antiVibe, /ponytail\/SKILL\.md/);
});
