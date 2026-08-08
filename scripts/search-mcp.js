#!/usr/bin/env node
// Whole-tree search in one call. The filesystem MCP's search_files returns no directories and times out on a large root.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { opendirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ROOT, resolveUnderRoot } from './roots.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt', '.output', '.cache',
  'vendor', '.venv', 'venv', '__pycache__', 'target', 'Pods', 'DerivedData',
  '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems',
]);
const MAX_DEPTH = 12;
const DEFAULT_LIMIT = 100;

function toMatcher(query) {
  if (!/[*?]/.test(query)) {
    const needle = query.toLowerCase();
    return (rel) => rel.toLowerCase().includes(needle);
  }
  const source = query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const re = new RegExp(`^${source}$`, 'i');
  const scoped = query.includes('/');
  return (rel) => re.test(scoped ? rel : path.basename(rel));
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

function findPath(query, from, limit) {
  const base = resolveUnderRoot(from);
  const test = toMatcher(query);
  const found = [];
  walk(base, (full, isDir) => {
    const rel = path.relative(base, full);
    if (test(rel)) found.push(isDir ? `${full}/` : full);
  });
  found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const head = found.slice(0, limit);
  if (!found.length) return `nothing matched "${query}" under ${base}`;
  const note = found.length > head.length ? `\n… ${found.length - head.length} more result(s) (raise limit or narrow the query)` : '';
  return `${found.length} result(s) under ${base}:\n${head.join('\n')}${note}`;
}

function nameMatchesGlob(name, glob) {
  if (!glob) return true;
  const source = `^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
  return new RegExp(source, 'i').test(name);
}

// Pure-JS fallback when system grep isn't available (typical on Windows without Git usr\bin).
function searchContentNode(query, base, glob, limit) {
  const needle = query.toLowerCase();
  const found = [];
  walk(base, (full, isDir) => {
    if (isDir || found.length >= limit * 4) return;
    if (!nameMatchesGlob(path.basename(full), glob)) return;
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      return;
    }
    if (text.includes('\0')) return;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        found.push(`${full}:${i + 1}:${lines[i]}`);
        if (found.length >= limit * 4) break;
      }
    }
  });
  if (!found.length) return `no lines matched "${query}" under ${base}`;
  const head = found.slice(0, limit);
  const note = found.length > head.length ? `\n… ${found.length - head.length} more line(s)` : '';
  return `${found.length} matching line(s):\n${head.join('\n')}${note}`;
}

function searchContent(query, from, glob, limit) {
  const base = resolveUnderRoot(from);
  if (process.platform === 'win32') {
    return Promise.resolve(searchContentNode(query, base, glob, limit));
  }
  const args = ['-rnI', '--binary-files=without-match', ...[...SKIP_DIRS].map((d) => `--exclude-dir=${d}`)];
  if (glob) args.push(`--include=${glob}`);
  args.push('-e', query, base);
  return new Promise((resolve) => {
    execFile('grep', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return resolve(searchContentNode(query, base, glob, limit));
      const lines = (stdout || '').split('\n').filter(Boolean);
      if (!lines.length) return resolve(err && stderr ? `error: ${stderr.trim()}` : `no lines matched "${query}" under ${base}`);
      const head = lines.slice(0, limit);
      const note = lines.length > head.length ? `\n… ${lines.length - head.length} more line(s)` : '';
      resolve(`${lines.length} matching line(s):\n${head.join('\n')}${note}`);
    });
  });
}

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (e) => ({ content: [{ type: 'text', text: `rejected: ${e.message}` }], isError: true });

const server = new McpServer({ name: 'search', version: '1.0.0' });

server.registerTool(
  'find_path',
  {
    description: `Find files AND directories anywhere under ${ROOT} in one call — use this first when locating a project, repo, or file by name, instead of walking directories one level at a time. query is a case-insensitive substring by default ("mcp" finds aki-mcp-sv), or a glob when it contains * or ? ("*.config.js", "src/**/*.ts"). Globs without a slash match the basename. Skips node_modules/.git/build output automatically. Directories come back with a trailing slash.`,
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
    description: `Search file contents recursively under ${ROOT} and return file:line:text. Use after find_path when you need where a string actually appears. glob narrows by filename (e.g. "*.json"). Skips binaries and build/vendor directories.`,
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

await server.connect(new StdioServerTransport());
