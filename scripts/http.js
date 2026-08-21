// Shared plumbing for the two HTTP front-ends; the static server is a security boundary, kept single-copy so its path-traversal guard can't diverge.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const PUBLIC_DIR = join(process.cwd(), 'public');
const MIME = {
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain; charset=utf-8',
};

export class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
    this.code = 'BODY_TOO_LARGE';
    this.limit = limit;
  }
}

export function readBody(req, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume?.();
      reject(new BodyTooLargeError(maxBytes));
      return;
    }

    const chunks = [];
    let total = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      total += c.length;
      if (total > maxBytes) {
        failed = true;
        chunks.length = 0;
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!failed) reject(error);
    });
  });
}

export function json(res, status, body, headers) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function serveStatic(res, urlPath, aliases = {}) {
  const rel = normalize(aliases[urlPath] || urlPath).replace(/^([/\\.]+)/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + sep)) return false;
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
