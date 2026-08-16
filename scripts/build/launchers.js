// Renders the three release launcher scripts. Every value inside them is resolved and pinned
// here, at build time — Node download URL/hash (fetched from nodejs.org's own published manifest)
// and the app payload's GitHub Release asset URL/hash (predictable from repo+tag+filename; the
// upload does not need to have happened yet for the URL to be correct once it does).
// docs/plan/standalone-release-delivery.md § Installation layout: "no unpinned `latest` fetch at
// launcher runtime."
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { NODE_TARGETS, LAUNCHERS } from './targets.js';
import { fetchNodeShasums, nodeArchiveInfo } from './node-checksums.js';
import { renderPosixLauncher } from './launcher-templates/posix.js';
import { renderWindowsLauncher } from './launcher-templates/windows.js';
import { REPO_MCP } from '../update-check.js';

// `assetBaseUrl` override exists only for scripts/build/smoke-test.js, which serves the just-built
// payload over a throwaway local HTTP server instead of the real (not-yet-uploaded) GitHub Release
// — same launcher templates, same install mechanism, no dependency on a release actually existing.
function releaseAssetUrl(version, assetName, assetBaseUrl) {
  const base = assetBaseUrl ?? `https://github.com/${REPO_MCP}/releases/download/${version}`;
  return `${base}/${assetName}`;
}

function macosTargetDetectSh(nodeInfoByTarget) {
  const arm = nodeInfoByTarget['darwin-arm64'];
  const x64 = nodeInfoByTarget['darwin-x64'];
  return `UNAME_M="$(uname -m)"
case "$UNAME_M" in
  arm64) NODE_TARGET="darwin-arm64"; NODE_DIST_NAME="darwin-arm64"; NODE_URL="${arm.url}"; NODE_SHA256="${arm.sha256}" ;;
  x86_64) NODE_TARGET="darwin-x64"; NODE_DIST_NAME="darwin-x64"; NODE_URL="${x64.url}"; NODE_SHA256="${x64.sha256}" ;;
  *) echo "[aki-mcp-sv] unsupported architecture: $UNAME_M" >&2; exit 1 ;;
esac`;
}

function linuxTargetDetectSh(nodeInfoByTarget) {
  const info = nodeInfoByTarget['linux-x64'];
  return `NODE_TARGET="linux-x64"
NODE_DIST_NAME="linux-x64"
NODE_URL="${info.url}"
NODE_SHA256="${info.sha256}"`;
}

/**
 * @param {object} opts
 * @param {string} opts.nodeVersion
 * @param {string} opts.appVersion
 * @param {string} opts.appArchiveBaseName  e.g. "aki-mcp-sv-1.9.0-app"
 * @param {string} opts.appTarSha256
 * @param {string} opts.appZipSha256
 * @param {string} opts.outDir
 * @returns {Promise<{ macos: string, windows: string, linux: string }>} written file paths
 */
export async function buildLaunchers(opts) {
  const { nodeVersion, appVersion, appArchiveBaseName, appTarSha256, appZipSha256, outDir, assetBaseUrl } = opts;

  const shasums = await fetchNodeShasums(nodeVersion);
  const nodeInfoByTarget = Object.fromEntries(
    Object.entries(NODE_TARGETS).map(([target, distTarget]) => [target, nodeArchiveInfo(shasums, nodeVersion, distTarget)])
  );

  mkdirSync(outDir, { recursive: true });
  const written = {};

  // macOS — one asset, two possible Node targets chosen at first-run time by `uname -m`.
  const macosPath = path.join(outDir, `aki-mcp-sv-${appVersion}-${LAUNCHERS.macos.assetSuffix}`);
  writeFileSync(
    macosPath,
    renderPosixLauncher({
      label: 'macOS',
      appDataRootSh: '$HOME/Library/Application Support/aki-mcp-sv',
      targetDetectSh: macosTargetDetectSh(nodeInfoByTarget),
      nodeVersion,
      appVersion,
      appUrl: releaseAssetUrl(appVersion, `${appArchiveBaseName}.tar.gz`, assetBaseUrl),
      appSha256: appTarSha256,
      appArchiveDirName: appArchiveBaseName,
    })
  );
  chmodSync(macosPath, 0o755);
  written.macos = macosPath;

  // Linux — one asset, one Node target.
  const linuxPath = path.join(outDir, `aki-mcp-sv-${appVersion}-${LAUNCHERS.linux.assetSuffix}`);
  writeFileSync(
    linuxPath,
    renderPosixLauncher({
      label: 'Linux',
      appDataRootSh: '${XDG_DATA_HOME:-$HOME/.local/share}/aki-mcp-sv',
      targetDetectSh: linuxTargetDetectSh(nodeInfoByTarget),
      nodeVersion,
      appVersion,
      appUrl: releaseAssetUrl(appVersion, `${appArchiveBaseName}.tar.gz`, assetBaseUrl),
      appSha256: appTarSha256,
      appArchiveDirName: appArchiveBaseName,
    })
  );
  chmodSync(linuxPath, 0o755);
  written.linux = linuxPath;

  // Windows — the app archive it installs is the .zip (Expand-Archive has no tar.gz support).
  const windowsPath = path.join(outDir, `aki-mcp-sv-${appVersion}-${LAUNCHERS.windows.assetSuffix}`);
  const win = nodeInfoByTarget['win32-x64'];
  writeFileSync(
    windowsPath,
    renderWindowsLauncher({
      nodeVersion,
      nodeUrl: win.url,
      nodeSha256: win.sha256,
      appVersion,
      appUrl: releaseAssetUrl(appVersion, `${appArchiveBaseName}.zip`, assetBaseUrl),
      appSha256: appZipSha256,
      appArchiveDirName: appArchiveBaseName,
    })
  );
  written.windows = windowsPath;

  console.log(`[launchers] built ${macosPath}`);
  console.log(`[launchers] built ${linuxPath}`);
  console.log(`[launchers] built ${windowsPath}`);
  return written;
}
