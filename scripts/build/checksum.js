import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}
