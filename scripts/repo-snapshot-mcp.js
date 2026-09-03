// One-call bounded repository snapshot for clients with per-tool approval/deadline limits (notably Gemini Spark).
// It performs only local filesystem reads: no nested AI worker, shell, network, or subprocess. The output is a
// compact tree plus prioritized source/config/docs excerpts so the calling model can analyze a codebase from one MCP call.
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveRealUnderRoot } from './roots.js';
import { ok, fail } from './mcp-tool.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt', '.output', '.cache',
  '.gradle', '.idea', '.vscode', 'vendor', '.venv', 'venv', '__pycache__', 'target', 'Pods', 'DerivedData',
  '.dart_tool', '.terraform', '.serverless', '.wrangler', 'coverage', 'tmp', 'temp', 'logs',
]);

const SKIP_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Podfile.lock', 'Cargo.lock',
  'Package.resolved', 'gradle.lockfile', '.DS_Store', 'Thumbs.db', 'local.properties',
]);

const TEXT_EXTS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.plist', '.properties', '.gradle', '.kts', '.kt', '.java', '.swift', '.m', '.mm', '.h', '.hpp',
  '.c', '.cc', '.cpp', '.cs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py',
  '.rb', '.php', '.go', '.rs', '.dart', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gql', '.proto',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.xcconfig', '.pbxproj', '.entitlements', '.strings',
]);

const SPECIAL_TEXT_FILES = new Set([
  'README', 'LICENSE', 'Dockerfile', 'Makefile', 'Procfile', 'Gemfile', 'Podfile', 'Package.swift',
  'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'gradle.properties',
  '.gitignore', '.gitattributes', '.editorconfig', '.env.example', '.env.sample', '.env.template',
]);

const HIGH_VALUE_NAMES = new Set([
  'readme.md', 'readme.mdx', 'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'cargo.toml',
  'package.swift', 'project.yml', 'androidmanifest.xml', 'settings.gradle', 'settings.gradle.kts', 'build.gradle',
  'build.gradle.kts', 'gradle.properties', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'tsconfig.json',
  'vite.config.ts', 'next.config.js', 'next.config.mjs', 'nuxt.config.ts', 'dockerfile', 'docker-compose.yml',
  'docker-compose.yaml', 'cloudflare.toml', 'vercel.json', 'netlify.toml', 'info.plist',
]);

const SECRET_EXACT = new Set([
  '.env', '.npmrc', '.pypirc', '.netrc', 'tokens.json', 'credentials.json', 'client_secret.json',
  'service-account.json', 'service_account.json', 'id_rsa', 'id_ed25519',
]);
const SECRET_EXTS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore']);

const MAX_DEPTH = 12;
const MAX_SCAN_FILES = 8_000;
const MAX_SCAN_ENTRIES = 12_000;
const TREE_LINE_LIMIT = 1_500;
const DEFAULT_MAX_FILES = 80;
const DEFAULT_MAX_CHARS = 180_000;
const MAX_PER_FILE_CHARS = 24_000;

const slash = (p) => p.split(path.sep).join('/');

function isSecretLike(name) {
  const lower = name.toLowerCase();
  if (lower === '.env.example' || lower === '.env.sample' || lower === '.env.template') return false;
  if (SECRET_EXACT.has(lower) || SECRET_EXTS.has(path.extname(lower))) return true;
  if (/^\.env\./.test(lower)) return true;
  return /^(?:.*[-_.])?(?:secrets?|credentials?)(?:[-_.].*)?\.json$/i.test(name);
}

function isTextCandidate(name) {
  if (SKIP_FILES.has(name)) return false;
  if (SPECIAL_TEXT_FILES.has(name)) return true;
  return TEXT_EXTS.has(path.extname(name).toLowerCase());
}

function scoreFile(rel, size) {
  const normalized = slash(rel);
  const lower = normalized.toLowerCase();
  const base = path.basename(lower);
  const depth = normalized.split('/').length - 1;
  let score = Math.max(0, 70 - depth * 8);
  if (HIGH_VALUE_NAMES.has(base)) score += 260;
  if (lower.startsWith('.github/workflows/')) score += 180;
  if (lower.startsWith('docs/arch/') || lower === 'docs/index.md' || lower.endsWith('/architecture.md')) score += 150;
  if (/(^|\/)(src|app|lib|ios|android|backend|server|client)\//.test(lower)) score += 55;
  if (/(^|[-_.])(main|app|application|index|root|server|router|config|model|service|controller|screen|view)([-_.]|$)/.test(base)) score += 90;
  if (['.md', '.json', '.jsonc', '.toml', '.yaml', '.yml'].includes(path.extname(lower))) score += 25;
  if (size <= 64 * 1024) score += 25;
  if (size > 512 * 1024) score -= 80;
  return score;
}

async function scanRepository(base) {
  const stack = [{ dir: base, depth: 0 }];
  const entries = [];
  const candidates = [];
  let fileCount = 0;
  let dirCount = 0;
  let secretOmissions = 0;
  let symlinkOmissions = 0;
  let scanTruncated = false;

  while (stack.length) {
    const { dir, depth } = stack.pop();
    let children;
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of children) {
      if (entries.length >= MAX_SCAN_ENTRIES) {
        scanTruncated = true;
        stack.length = 0;
        break;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full);
      if (entry.isSymbolicLink()) {
        symlinkOmissions++;
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        dirCount++;
        entries.push({ rel, isDir: true, suffix: '' });
        if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (fileCount >= MAX_SCAN_FILES) {
        scanTruncated = true;
        stack.length = 0;
        break;
      }
      fileCount++;
      if (isSecretLike(entry.name)) {
        secretOmissions++;
        continue;
      }
      entries.push({ rel, isDir: false, suffix: '' });
      if (!isTextCandidate(entry.name)) continue;
      try {
        const stat = await fs.stat(full);
        candidates.push({ full, rel, size: stat.size, score: scoreFile(rel, stat.size) });
      } catch {
        // A disappearing file during a snapshot is non-fatal; the tree remains useful.
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return { entries, candidates, fileCount, dirCount, secretOmissions, symlinkOmissions, scanTruncated };
}

async function readPrefix(file, maxChars) {
  const byteLimit = Math.min(Math.max(maxChars * 4, 4096), 256 * 1024);
  const handle = await fs.open(file.full, 'r');
  try {
    const buf = Buffer.alloc(Math.min(byteLimit, Math.max(file.size, 1)));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const slice = buf.subarray(0, bytesRead);
    if (slice.includes(0)) return null;
    const decoded = slice.toString('utf8').replace(/\r\n/g, '\n');
    const text = decoded.slice(0, maxChars);
    const truncated = file.size > bytesRead || decoded.length > maxChars;
    return { text, truncated };
  } finally {
    await handle.close();
  }
}

function renderTree(entries, maxChars) {
  const lines = [];
  let used = 0;
  for (const entry of entries.slice(0, TREE_LINE_LIMIT)) {
    const line = `${slash(entry.rel)}${entry.isDir ? '/' : ''}${entry.suffix}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  const omitted = entries.length - lines.length;
  if (omitted > 0) lines.push(`... ${omitted} tree entr${omitted === 1 ? 'y' : 'ies'} omitted by output budget`);
  return lines.join('\n');
}

export async function createRepoSnapshot({ path: requestedPath, maxFiles = DEFAULT_MAX_FILES, maxChars = DEFAULT_MAX_CHARS }) {
  const base = await resolveRealUnderRoot(requestedPath);
  const stat = await fs.stat(base);
  if (!stat.isDirectory()) throw new Error('repo_snapshot path must be a directory');

  const scan = await scanRepository(base);
  const treeBudget = Math.min(36_000, Math.floor(maxChars * 0.22));
  const tree = renderTree(scan.entries, treeBudget);
  const header = [
    '# Aki Repository Snapshot',
    `root: ${base}`,
    `discovered: ${scan.fileCount} files, ${scan.dirCount} directories`,
    `candidate text files: ${scan.candidates.length}`,
    `security omissions: ${scan.secretOmissions} secret-like files, ${scan.symlinkOmissions} symlinks`,
    `scan truncated: ${scan.scanTruncated ? `yes at bounded scan limit (${MAX_SCAN_FILES} files / ${MAX_SCAN_ENTRIES} entries)` : 'no'}`,
    '',
    '## TREE',
    tree,
    '',
    '## PRIORITIZED FILE CONTENT',
  ].join('\n');

  let output = header;
  let selected = 0;
  let binarySkipped = 0;
  const selectedPaths = [];

  for (const file of scan.candidates) {
    if (selected >= maxFiles) break;
    const remaining = maxChars - output.length;
    if (remaining < 700) break;
    const rel = slash(file.rel);
    const fileBudget = Math.min(MAX_PER_FILE_CHARS, Math.max(500, remaining - rel.length - 120));
    let content;
    try {
      content = await readPrefix(file, fileBudget);
    } catch {
      continue;
    }
    if (!content) {
      binarySkipped++;
      continue;
    }
    const block = `\n\n--- FILE: ${rel} (${file.size} bytes) ---\n${content.text}${content.truncated ? '\n[...truncated by snapshot budget...]' : ''}`;
    if (output.length + block.length > maxChars) break;
    output += block;
    selected++;
    selectedPaths.push(rel);
  }

  const summary = `\n\n## SNAPSHOT SUMMARY\nselected files: ${selected}/${scan.candidates.length} candidates\nbinary-looking candidates skipped: ${binarySkipped}\nselected paths: ${selectedPaths.join(', ') || '(none)'}`;
  if (output.length + summary.length <= maxChars) output += summary;
  return output.slice(0, maxChars);
}

export function register(server) {
  server.registerTool(
    'repo_snapshot',
    {
      title: 'Aki One-Call Repository Snapshot',
      description: 'Preferred first tool for broad local repository/codebase analysis when the client asks approval per MCP call or has a short tool deadline. In one read-only local pass it returns a bounded repository tree plus prioritized source/config/docs contents; it does not invoke Agy/Kiro/OpenCode, shell, network, or nested MCP calls. Secret-like files and symlinks are omitted. Use granular find/search/read only when the snapshot is insufficient.',
      inputSchema: {
        path: z.string().describe('absolute repository/project directory under an allowed root'),
        maxFiles: z.number().int().min(10).max(200).optional().describe(`maximum prioritized text files to include; default ${DEFAULT_MAX_FILES}`),
        maxChars: z.number().int().min(20_000).max(400_000).optional().describe(`maximum returned characters; default ${DEFAULT_MAX_CHARS}`),
      },
    },
    async (args) => {
      try {
        return ok(await createRepoSnapshot(args));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
