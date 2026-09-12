import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeImageWithOpenCode,
  OPENCODE_VISION_DEFAULT_MODEL,
  resolveOpenCodeExecutable,
} from '../scripts/opencode-vision.js';

const ONE_BYTE = Buffer.from([0]);

test('OpenCode vision defaults to the zero-cost Muse vision model', () => {
  assert.equal(OPENCODE_VISION_DEFAULT_MODEL, 'opencode/muse-spark-1.3-contributor-free');
});

test('OpenCode executable honors the explicit bridge override', () => {
  assert.equal(resolveOpenCodeExecutable({ AKI_OPENCODE_EXE: 'X:\\tools\\opencode.exe' }), 'X:\\tools\\opencode.exe');
});

test('OpenCode vision rejects unsupported media before launching a server', async () => {
  await assert.rejects(
    analyzeImageWithOpenCode({ buffer: ONE_BYTE, mimeType: 'image/heic', filename: 'photo.heic' }),
    /supports PNG, JPEG, GIF, or WebP/,
  );
});

test('OpenCode vision rejects malformed model ids before launching a server', async () => {
  await assert.rejects(
    analyzeImageWithOpenCode({ buffer: ONE_BYTE, mimeType: 'image/png', filename: 'screen.png', model: 'broken-model-id' }),
    /invalid OpenCode vision model/,
  );
});
