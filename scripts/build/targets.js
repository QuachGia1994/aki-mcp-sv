// Single source of truth for every per-OS/arch value the release build needs — Node download
// shape and the launcher-to-Node-target mapping. Mirrors scripts/open-browser.js's LAUNCHER
// table pattern: platform difference is a data row, never a branch in build logic.
// docs/plan/standalone-release-delivery.md § Required implementation sequence, step 2.

// Node dist target -> how to fetch/extract/locate its binary. Keys match nodejs.org/dist naming
// via `dist`, not Node's own `process.platform-arch` pairs (win-x64 vs win32-x64).
export const NODE_TARGETS = {
  'darwin-arm64': { dist: 'darwin-arm64', ext: 'tar.gz', mainBin: 'bin/node' },
  'darwin-x64': { dist: 'darwin-x64', ext: 'tar.gz', mainBin: 'bin/node' },
  'linux-x64': { dist: 'linux-x64', ext: 'tar.gz', mainBin: 'bin/node' },
  'win32-x64': { dist: 'win-x64', ext: 'zip', mainBin: 'node.exe' },
};

// One row per shipped launcher asset. `nodeTargets` lists every Node target that launcher must
// be able to install (macOS ships one launcher covering both Apple Silicon and Intel — it picks
// between its two Node targets at first-run time via `uname -m`, never via a second asset).
export const LAUNCHERS = {
  macos: { assetSuffix: 'macos.command', nodeTargets: ['darwin-arm64', 'darwin-x64'], appArchiveExt: 'tar.gz' },
  windows: { assetSuffix: 'windows.cmd', nodeTargets: ['win32-x64'], appArchiveExt: 'zip' },
  linux: { assetSuffix: 'linux.run', nodeTargets: ['linux-x64'], appArchiveExt: 'tar.gz' },
};

// App payload files, platform-neutral only while NATIVE_FILE_GLOBS finds nothing (see payload.js).
export const APP_ENTRIES = ['scripts', 'mcp-hub.config.json', 'package.json', 'LICENSE'];

export const NATIVE_FILE_EXTS = ['.node', '.dylib', '.so', '.dll'];
