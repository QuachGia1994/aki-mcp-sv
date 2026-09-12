// Whole-tree search MCP tool in one call. The filesystem MCP's search_files returns no directories and times out on a large root.
import { execFile } from 'node:child_process';
import { existsSync, opendirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getRoots, resolveRealUnderRootSync } from './roots.js';
import { ok, fail } from './mcp-tool.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt', '.output', '.cache',
  'vendor', '.venv', 'venv', '__pycache__', 'target', 'Pods', 'DerivedData',
  '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems',
]);
const MAX_DEPTH = 12;
const DEFAULT_LIMIT = 100;
const MAX_GLOB_PATTERN_LENGTH = 256;

export function resolveGrepExecutable({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform !== 'win32') return 'grep';
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const rawEntry of pathValue.split(';')) {
    const trimmedEntry = rawEntry.trim();
    if (!trimmedEntry) continue;
    const entry = trimmedEntry.startsWith('"') && trimmedEntry.endsWith('"') ? trimmedEntry.slice(1, -1) : trimmedEntry;
    const gitExecutable = path.win32.join(entry, 'git.exe');
    if (!exists(gitExecutable)) continue;
    const gitBin = path.win32.dirname(gitExecutable);
    const gitBinName = path.win32.basename(gitBin).toLowerCase();
    const gitParent = path.win32.dirname(gitBin);
    const gitParentName = path.win32.basename(gitParent).toLowerCase();
    const gitRoots = gitBinName === 'cmd'
      ? [gitParent]
      : gitBinName === 'bin' && ['mingw64', 'mingw32', 'clangarm64', 'clangarm', 'usr'].includes(gitParentName)
        ? [path.win32.dirname(gitParent)]
        : gitBinName === 'bin'
          ? [gitParent]
          : [];
    for (const gitRoot of gitRoots) {
      const bundledGrep = path.win32.join(gitRoot, 'usr', 'bin', 'grep.exe');
      if (exists(bundledGrep)) return bundledGrep;
    }
  }
  return 'grep';
}

function wildcardMatch(pattern, value) {
  const needle = pattern.toLowerCase();
  const candidate = value.toLowerCase();
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starValueIndex = 0;

  while (valueIndex < candidate.length) {
    const token = needle[patternIndex];
    if (patternIndex < needle.length && (token === '?' || token === candidate[valueIndex])) {
      patternIndex += 1;
      valueIndex += 1;
      continue;
    }
    if (token === '*') {
      starIndex = patternIndex;
      patternIndex += 1;
      starValueIndex = valueIndex;
      continue;
    }
    if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
      continue;
    }
    return false;
  }

  while (needle[patternIndex] === '*') patternIndex += 1;
  return patternIndex === needle.length;
}

export function toMatcher(query) {
  if (!/[*?]/.test(query)) {
    const needle = query.toLowerCase();
    return (rel) => rel.toLowerCase().includes(needle);
  }
  if (query.length > MAX_GLOB_PATTERN_LENGTH) throw new Error(`glob pattern exceeds ${MAX_GLOB_PATTERN_LENGTH} characters`);
  const scoped = query.includes('/');
  return (rel) => wildcardMatch(query, scoped ? rel : path.basename(rel));
}

function walk(base, matches) {
  const stack = [[base, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let handle;
    try {
      handle = opendirSync(dir);
    } catch {
      continue;
    }
    let entry;
    while ((entry = handle.readSync())) {
      const full = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      matches(full, isDir);
      if (isDir && depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) stack.push([full, depth + 1]);
    }
    handle.closeSync();
  }
}

export function findPath(query, from, limit) {
  const base = resolveRealUnderRootSync(from);
  const test = toMatcher(query);
  const found = [];
  walk(base, (full, isDir) => {
    const rel = path.relative(base, full);
    if (test(rel)) found.push(isDir ? `${full}${path.sep}` : full);
  });
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  const head = found.slice(0, limit);
  if (!found.length) return `nothing matched "${query}" under ${base}`;
  const note = found.length > head.length ? `\n… ${found.length - head.length} more result(s) (raise limit or narrow the query)` : '';
  return `${found.length} result(s) under ${base}:\n${head.join('\n')}${note}`;
}

export function searchContent(query, from, glob, limit, { run = execFile, resolveGrep = resolveGrepExecutable } = {}) {
  const base = resolveRealUnderRootSync(from);
  const args = ['-rniIE', '--binary-files=without-match', ...[...SKIP_DIRS].map((d) => `--exclude-dir=${d}`)];
  if (glob) args.push(`--include=${glob}`);
  args.push('-e', query, base);
  return new Promise((resolve, reject) => {
    run(resolveGrep(), args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err.code !== 1 || err.killed || err.signal)) {
        const message = err.code === 'ENOENT' ? 'grep executable not found on PATH or in Git for Windows usr/bin; install or expose the required Unix tools (Git for Windows on Windows)' : stderr?.trim() || err.message;
        return reject(new Error(message));
      }
      const lines = (stdout || '').split('\n').filter(Boolean);
      if (!lines.length) return resolve(`no lines matched "${query}" under ${base}`);
      const head = lines.slice(0, limit);
      const note = lines.length > head.length ? `\n… ${lines.length - head.length} more line(s)` : '';
      resolve(`${lines.length} matching line(s):\n${head.join('\n')}${note}`);
    });
  });
}

export function register(server) {
  server.registerTool(
    'find_path',
    {
      title: 'Find Path',
      description: 'Find files AND directories anywhere under the configured roots in one call — use this first when locating a project, repo, or file by name, instead of walking directories one level at a time. query is a case-insensitive substring by default ("mcp" finds aki-mcp-sv), or a glob when it contains * or ? ("*.config.js", "src/**/*.ts"). Globs without a slash match the basename. Skips node_modules/.git/build output automatically. Directories come back with a trailing slash.',
      inputSchema: {
        query: z.string(),
        path: z.string().optional().describe('subdirectory to search under, absolute or relative to the root'),
        limit: z.number().optional(),
      },
    },
    ({ query, path: from, limit }) => {
      try {
        return ok(findPath(query, from, limit ?? DEFAULT_LIMIT));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'search_content',
    {
      title: 'Search Content',
      description: 'Search file contents recursively under the configured roots and return file:line:text. Case-insensitive extended regex (grep -iE): put every alias in one query with | — "funnel|ingress|thay.*funnel" hits EN+VI+synonym in one call, no need for separate calls per term. Use after find_path when you need where a string actually appears. glob narrows by filename (e.g. "*.json"). Skips binaries and build/vendor directories.',
      inputSchema: {
        query: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async ({ query, path: from, glob, limit }) => {
      try {
        return ok(await searchContent(query, from, glob, limit ?? DEFAULT_LIMIT));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
