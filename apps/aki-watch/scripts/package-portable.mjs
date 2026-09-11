import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  throw new Error('Aki Watch portable staging is Windows-only');
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const tauriDir = path.join(appDir, 'src-tauri');
const releaseDir = path.join(tauriDir, 'target', 'release');
const portableDir = path.join(releaseDir, 'portable', 'Aki-Watch-portable');
const executable = path.join(releaseDir, 'aki-watch.exe');
const configPath = path.join(tauriDir, 'tauri.conf.json');
const packagePath = path.join(appDir, 'package.json');

if (!existsSync(executable)) {
  throw new Error(`release executable not found: ${executable}`);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const resources = config?.bundle?.resources;
if (!resources || Array.isArray(resources) || typeof resources !== 'object') {
  throw new Error('tauri.conf.json bundle.resources must be an object map');
}

rmSync(portableDir, { recursive: true, force: true });
mkdirSync(portableDir, { recursive: true });
cpSync(executable, path.join(portableDir, 'aki-watch.exe'));

for (const [sourceSpec, destinationSpec] of Object.entries(resources)) {
  const source = path.resolve(tauriDir, sourceSpec);
  const destination = path.resolve(portableDir, destinationSpec);
  const relative = path.relative(portableDir, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`portable resource escapes output directory: ${destinationSpec}`);
  }
  if (!existsSync(source)) {
    throw new Error(`portable resource source missing: ${source}`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

writeFileSync(
  path.join(portableDir, 'README.txt'),
  [
    `Aki Watch Portable ${pkg.version}`,
    '',
    'No installation is required. Keep aki-watch.exe and aki-watch-runtime together in this folder.',
    'Host prerequisites are still required: Node.js, Python 3 with telethon + selenium, and LibreWolf with signed-in Postman profiles.',
    'User configuration remains outside this folder under ~/.aki/mcpsv/postman-pool.json.',
    '',
  ].join('\r\n'),
  'utf8',
);

console.log(portableDir);
