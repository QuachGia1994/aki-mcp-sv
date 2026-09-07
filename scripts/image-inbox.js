import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { containedIn, getRoots, resolveRealUnderRootSync } from './roots.js';
import { err } from './mcp-tool.js';

const DEFAULT_DIR_NAME = 'Postman-Image-Inbox';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_LIST = 20;

function directoryRoots(roots = getRoots()) {
  return roots.filter((root) => {
    try { return statSync(root).isDirectory(); } catch { return false; }
  });
}

export function resolveImageInboxDir({ env = process.env, cwd = process.cwd(), roots = getRoots() } = {}) {
  const dirs = directoryRoots(roots);
  const explicit = String(env.AKI_IMAGE_INBOX_DIR || '').trim();
  if (explicit) return resolveRealUnderRootSync(explicit, { roots: dirs });
  const enclosing = dirs.filter((root) => containedIn(cwd, root)).sort((a, b) => a.length - b.length);
  const base = enclosing[0] || dirs[0] || cwd;
  return resolveRealUnderRootSync(path.join(base, DEFAULT_DIR_NAME), { roots: dirs.length ? dirs : [cwd] });
}

function sniffMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
  }
  return null;
}

function safeBasename(name) {
  const value = String(name || '').trim();
  if (!value || value !== path.basename(value) || value === '.' || value === '..') throw new Error('image name must be one direct-child basename');
  return value;
}

function imageEntry(dir, name) {
  const safe = safeBasename(name);
  const requested = path.join(dir, safe);
  const real = resolveRealUnderRootSync(requested, { roots: [dir] });
  if (path.dirname(real) !== path.resolve(dir)) throw new Error('image must be a direct child of the inbox');
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error('image target is not a regular file');
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte limit`);
  const buffer = readFileSync(real);
  const mimeType = sniffMime(buffer);
  if (!mimeType) throw new Error('unsupported image type; use PNG, JPEG, WebP, GIF, HEIC, or HEIF');
  return { name: safe, path: real, size: stat.size, modifiedMs: stat.mtimeMs, mimeType, buffer };
}

export function listInboxImages({ dir, limit = MAX_LIST } = {}) {
  const inbox = dir || resolveImageInboxDir();
  const max = Math.max(1, Math.min(MAX_LIST, Number(limit) || MAX_LIST));
  const rows = [];
  for (const dirent of readdirSync(inbox, { withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    try {
      const entry = imageEntry(inbox, dirent.name);
      rows.push({ name: entry.name, size: entry.size, modifiedMs: entry.modifiedMs, mimeType: entry.mimeType });
    } catch { /* unsupported or unsafe files do not enter the inbox listing */ }
  }
  return rows.sort((a, b) => b.modifiedMs - a.modifiedMs || a.name.localeCompare(b.name)).slice(0, max);
}

function formatList(dir, rows) {
  if (!rows.length) return `Image inbox: ${dir}\nNo supported images found.`;
  const lines = rows.map((row, index) => `${index + 1}. ${row.name} | ${row.mimeType} | ${row.size} bytes | ${new Date(row.modifiedMs).toISOString()}`);
  return `Image inbox: ${dir}\n${lines.join('\n')}`;
}

export function readInboxImage({ dir, name } = {}) {
  const inbox = dir || resolveImageInboxDir();
  const entry = imageEntry(inbox, name);
  return {
    content: [
      { type: 'text', text: `Image inbox file: ${entry.name}\nMIME: ${entry.mimeType}\nSize: ${entry.size} bytes\nModified: ${new Date(entry.modifiedMs).toISOString()}` },
      { type: 'image', data: entry.buffer.toString('base64'), mimeType: entry.mimeType },
    ],
  };
}

export function runImageInbox({ action = 'latest', name, limit = MAX_LIST } = {}) {
  try {
    const dir = resolveImageInboxDir();
    if (action === 'list') return { content: [{ type: 'text', text: formatList(dir, listInboxImages({ dir, limit })) }] };
    if (action === 'read') return readInboxImage({ dir, name });
    const latest = listInboxImages({ dir, limit: 1 })[0];
    if (!latest) return err(`image inbox is empty: ${dir}`);
    return readInboxImage({ dir, name: latest.name });
  } catch (error) {
    return err(`image inbox: ${error.message || String(error)}`);
  }
}

export function register(server) {
  server.registerTool('image_inbox', {
    title: 'Postman Image Inbox',
    description: 'Read images the owner drops into the local Postman image inbox. Use action=latest when the user says “xem ảnh mới nhất” or refers to the just-added image; action=list to disambiguate; action=read with an exact basename for a named image. latest/read return an MCP image content block for visual analysis, not OCR text.',
    inputSchema: {
      action: z.enum(['latest', 'read', 'list']).optional().default('latest'),
      name: z.string().max(255).optional().describe('exact direct-child filename, required for action=read'),
      limit: z.number().int().min(1).max(MAX_LIST).optional().default(MAX_LIST),
    },
  }, async (args) => runImageInbox(args));
}
