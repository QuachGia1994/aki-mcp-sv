import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listInboxImages, readInboxImage, resolveImageInboxDir } from '../scripts/image-inbox.js';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlZbDMAAAAASUVORK5CYII=', 'base64');

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aki-image-inbox-'));
  const inbox = path.join(root, 'Postman-Image-Inbox');
  mkdirSync(inbox);
  return { root, inbox };
}

test('image inbox resolves beneath the enclosing allowed root', () => {
  const { root, inbox } = fixture();
  assert.equal(resolveImageInboxDir({ env: {}, cwd: path.join(root, 'repo'), roots: [root] }), inbox);
});

test('image inbox lists newest supported direct-child images only', () => {
  const { inbox } = fixture();
  writeFileSync(path.join(inbox, 'one.png'), PNG_1X1);
  writeFileSync(path.join(inbox, 'note.txt'), 'not an image');
  const rows = listInboxImages({ dir: inbox });
  assert.deepEqual(rows.map((row) => row.name), ['one.png']);
  assert.equal(rows[0].mimeType, 'image/png');
});

test('image inbox returns MCP-native image content', () => {
  const { inbox } = fixture();
  writeFileSync(path.join(inbox, 'screen.png'), PNG_1X1);
  const result = readInboxImage({ dir: inbox, name: 'screen.png' });
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].mimeType, 'image/png');
  assert.equal(Buffer.from(result.content[1].data, 'base64').equals(PNG_1X1), true);
});

test('image inbox rejects traversal, fake image extensions, and oversized payloads', () => {
  const { root, inbox } = fixture();
  writeFileSync(path.join(root, 'outside.png'), PNG_1X1);
  writeFileSync(path.join(inbox, 'fake.png'), 'plain text');
  const huge = Buffer.alloc(8 * 1024 * 1024 + 1);
  PNG_1X1.copy(huge, 0, 0, Math.min(PNG_1X1.length, huge.length));
  writeFileSync(path.join(inbox, 'huge.png'), huge);
  assert.throws(() => readInboxImage({ dir: inbox, name: '..\\outside.png' }), /direct-child basename/);
  assert.throws(() => readInboxImage({ dir: inbox, name: '../outside.png' }), /direct-child basename/);
  assert.throws(() => readInboxImage({ dir: inbox, name: 'fake.png' }), /unsupported image type/);
  assert.throws(() => readInboxImage({ dir: inbox, name: 'huge.png' }), /exceeds 8388608 byte limit/);
});
