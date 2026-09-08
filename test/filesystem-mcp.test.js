import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readTextFile, register } from '../scripts/filesystem-mcp.js';

import { resolveRealUnderRoot } from '../scripts/roots.js';

const handlers = new Map();
register({ registerTool(name, _schema, handler) { handlers.set(name, handler); } });

async function fixture(t) {
  const scratch = path.join(process.cwd(), 'scratch');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'filesystem-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('move_file refuses an existing destination and preserves both files', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'destination.txt');
  await writeFile(source, 'source');
  await writeFile(destination, 'destination');
  const result = await handlers.get('move_file')({ source, destination });
  assert.equal(result.isError, true);
  assert.equal(await readFile(source, 'utf8'), 'source');
  assert.equal(await readFile(destination, 'utf8'), 'destination');
});

test('move_file still moves files and directories to absent destinations', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'destination.txt');
  await writeFile(source, 'content');
  assert.notEqual((await handlers.get('move_file')({ source, destination })).isError, true);
  assert.equal(await readFile(destination, 'utf8'), 'content');
  await assert.rejects(stat(source), { code: 'ENOENT' });
  const sourceDir = path.join(root, 'source-dir');
  const destinationDir = path.join(root, 'destination-dir');
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, 'child.txt'), 'child');
  assert.notEqual((await handlers.get('move_file')({ source: sourceDir, destination: destinationDir })).isError, true);
  assert.equal(await readFile(path.join(destinationDir, 'child.txt'), 'utf8'), 'child');
});

test('create_directory creates multiple missing parents and is repeatable', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'one', 'two', 'three');
  for (let i = 0; i < 2; i++) {
    const result = await handlers.get('create_directory')({ path: target });
    assert.notEqual(result.isError, true, JSON.stringify(result));
  }
  assert.equal((await stat(target)).isDirectory(), true);
});

test('head preserves multibyte characters across read chunks', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'unicode.txt');
  const first = 'a'.repeat(1023) + 'ệ😀';
  await writeFile(target, first + '\nlast');
  assert.equal(await readTextFile({ path: target, head: 1 }), first);
});

test('tail preserves multibyte characters across reverse read chunks', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'unicode.txt');
  const last = 'ệ😀' + 'a'.repeat(1023);
  await writeFile(target, 'first\n' + last);
  assert.equal(await readTextFile({ path: target, tail: 1 }), last);
});

test('head and tail count physical lines consistently for LF and CRLF', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'lines.txt');
  for (const eol of ['\n', '\r\n']) {
    await writeFile(target, 'first' + eol + 'last' + eol);
    assert.equal(await readTextFile({ path: target, head: 1 }), 'first');
    assert.equal(await readTextFile({ path: target, tail: 1 }), 'last');
    assert.equal(await readTextFile({ path: target, tail: 5 }), 'first\nlast');
    await writeFile(target, 'first' + eol + eol);
    assert.equal(await readTextFile({ path: target, tail: 1 }), '');
  }
});

test('line limits reject invalid counts and allow zero without returning the entire file', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'lines.txt');
  await writeFile(target, 'private content');
  assert.equal(await readTextFile({ path: target, head: 0 }), '');
  assert.equal(await readTextFile({ path: target, tail: 0 }), '');
  for (const count of [-1, 1.5, NaN, Infinity]) {
    await assert.rejects(readTextFile({ path: target, head: count }), /non-negative integer/);
    await assert.rejects(readTextFile({ path: target, tail: count }), /non-negative integer/);
  }
  await assert.rejects(readTextFile({ path: target, head: 0, tail: 1 }), /both head and tail/);
});

test('concurrent file moves never overwrite a shared destination', async (t) => {
  const root = await fixture(t);
  const sources = [path.join(root, 'one.txt'), path.join(root, 'two.txt')];
  const destination = path.join(root, 'shared.txt');
  await Promise.all(sources.map((source, i) => writeFile(source, String(i))));
  const results = await Promise.all(sources.map((source) => handlers.get('move_file')({ source, destination })));
  const winner = results.findIndex((result) => !result.isError);
  assert.equal(results.filter((result) => !result.isError).length, 1);
  assert.equal(await readFile(destination, 'utf8'), String(winner));
  assert.equal(await readFile(sources[1 - winner], 'utf8'), String(1 - winner));
});

test('move_file refuses existing empty directories', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'source-dir');
  const destination = path.join(root, 'destination-dir');
  await mkdir(source);
  await mkdir(destination);
  assert.equal((await handlers.get('move_file')({ source, destination })).isError, true);
  assert.equal((await stat(source)).isDirectory(), true);
  assert.equal((await stat(destination)).isDirectory(), true);
});

test('head and tail match line selection around byte boundaries', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'boundaries.txt');
  for (const length of [0, 1, 1022, 1023, 1024, 2047]) {
    const lines = ['ệ😀' + 'a'.repeat(length), '', 'last😀'];
    for (const eol of ['\n', '\r\n']) {
      for (const trailing of ['', eol]) {
        const text = lines.join(eol) + trailing;
        await writeFile(target, text);
        assert.equal(await readTextFile({ path: target }), text);
        for (const count of [1, 2, 4]) {
          assert.equal(await readTextFile({ path: target, head: count }), lines.slice(0, count).join('\n'));
          assert.equal(await readTextFile({ path: target, tail: count }), lines.slice(-count).join('\n'));
        }
      }
    }
  }
  await writeFile(target, '');
  assert.equal(await readTextFile({ path: target, head: 1 }), '');
  assert.equal(await readTextFile({ path: target, tail: 1 }), '');
});

test('recursive directory resolution stays within roots, including junctions', async (t) => {
  const root = await fixture(t);
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  await mkdir(allowed);
  await mkdir(outside);
  const nested = path.join(allowed, 'one', 'two');
  await assert.rejects(resolveRealUnderRoot(nested, { roots: [allowed] }), /parent directory does not exist/);
  assert.equal(await resolveRealUnderRoot(nested, { roots: [allowed], allowMissingParents: true }), nested);
  await assert.rejects(resolveRealUnderRoot(path.join(outside, 'new'), { roots: [allowed], allowMissingParents: true }), /outside the allowed roots/);
  const escape = path.join(allowed, 'escape');
  await symlink(outside, escape, 'junction');
  await assert.rejects(resolveRealUnderRoot(path.join(escape, 'one', 'two'), { roots: [allowed], allowMissingParents: true }), /escapes the allowed roots/);
  const dangling = path.join(allowed, 'dangling');
  await symlink(path.join(outside, 'missing'), dangling, 'junction');
  await assert.rejects(resolveRealUnderRoot(path.join(dangling, 'one', 'two'), { roots: [allowed], allowMissingParents: true }), /symlink target does not exist/);
});
