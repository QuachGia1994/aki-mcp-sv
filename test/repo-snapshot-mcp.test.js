import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRepoSnapshot } from '../scripts/repo-snapshot-mcp.js';

test('repo_snapshot returns a bounded prioritized codebase snapshot without leaking secret-like files', async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.repo-snapshot-test-'));
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'docs', 'arch'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    await mkdir(path.join(root, 'build'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'snapshot-fixture', scripts: { test: 'node --test' } }, null, 2));
    await writeFile(path.join(root, 'src', 'main.ts'), 'export const main = () => "fixture-main";\n');
    await writeFile(path.join(root, 'docs', 'arch', 'system.md'), '# Architecture\nLocal-only pipeline.\n');
    await writeFile(path.join(root, '.env'), 'SUPER_SECRET=do-not-leak\n');
    await writeFile(path.join(root, 'credentials.json'), '{"token":"do-not-leak-either"}\n');
    await writeFile(path.join(root, 'node_modules', 'ignored', 'bad.js'), 'SHOULD_NOT_SCAN\n');
    await writeFile(path.join(root, 'build', 'generated.ts'), 'SHOULD_NOT_SCAN_BUILD\n');

    const started = Date.now();
    const snapshot = await createRepoSnapshot({ path: root, maxFiles: 20, maxChars: 40_000 });
    const elapsed = Date.now() - started;

    assert.match(snapshot, /# Aki Repository Snapshot/);
    assert.match(snapshot, /package\.json/);
    assert.match(snapshot, /fixture-main/);
    assert.match(snapshot, /docs\/arch\/system\.md/);
    assert.match(snapshot, /security omissions: 2 secret-like files/);
    assert.doesNotMatch(snapshot, /do-not-leak/);
    assert.doesNotMatch(snapshot, /SHOULD_NOT_SCAN/);
    assert.ok(snapshot.length <= 40_000, `snapshot exceeded maxChars: ${snapshot.length}`);
    assert.ok(elapsed < 10_000, `tiny local snapshot unexpectedly slow: ${elapsed}ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
