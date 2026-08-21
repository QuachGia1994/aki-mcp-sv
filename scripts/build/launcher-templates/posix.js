// Shared body for the macOS (.command) and Linux (.run) launchers — both are POSIX sh, both do
// the same checksum-verified download/extract/atomic-rename dance (docs/plan/standalone-release-delivery.md
// § Installation layout), and differ only in: how many Node targets to choose between, and the
// per-OS application-data root. Rule of Three (pattern.A2): two near-identical scripts share one
// generator instead of being hand-duplicated.

// `sha256_of FILE` — tries sha256sum (Linux/GNU coreutils) then shasum -a 256 (macOS/BSD).
const SHA256_HELPER = `sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "no sha256sum or shasum found on this system" >&2
    exit 1
  fi
}`;

// install_verified URL SHA256 DEST_DIR EXTRACTED_TOP_NAME — no-op if DEST_DIR exists, else checksum-verifies in a sibling temp dir and atomically renames in; EXIT trap cleans up any failure.
const INSTALL_HELPER = `install_verified() {
  url="$1"; expected_sha="$2"; dest_dir="$3"; extracted_name="$4"
  if [ -d "$dest_dir" ]; then
    return 0
  fi
  parent_dir="$(dirname "$dest_dir")"
  mkdir -p "$parent_dir"
  tmp_dir="$parent_dir/.tmp-$$-$(basename "$dest_dir")"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir"
  trap 'rm -rf "$tmp_dir"' EXIT
  archive_path="$tmp_dir/$(basename "$url")"
  echo "[aki-mcp-sv] downloading $url"
  if ! curl -fsSL -o "$archive_path" "$url"; then
    echo "[aki-mcp-sv] download failed for $url" >&2
    exit 1
  fi
  actual_sha="$(sha256_of "$archive_path")"
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "[aki-mcp-sv] checksum mismatch for $url" >&2
    echo "[aki-mcp-sv] expected $expected_sha, got $actual_sha" >&2
    exit 1
  fi
  extract_dir="$tmp_dir/extract"
  mkdir -p "$extract_dir"
  case "$archive_path" in
    *.zip) unzip -q "$archive_path" -d "$extract_dir" ;;
    *) tar -xzf "$archive_path" -C "$extract_dir" ;;
  esac
  mv "$extract_dir/$extracted_name" "$dest_dir"
  trap - EXIT
  rm -rf "$tmp_dir"
}`;

/**
 * @param {object} opts
 * @param {string} opts.label - human-readable OS name for log lines
 * @param {string} opts.appDataRootSh - shell expression for the per-user app data root
 * @param {string} opts.targetDetectSh - shell snippet that sets NODE_TARGET, NODE_URL, NODE_SHA256
 * @param {string} opts.nodeVersion
 * @param {string} opts.appVersion
 * @param {string} opts.appUrl
 * @param {string} opts.appSha256
 * @param {string} opts.appArchiveDirName
 */
export function renderPosixLauncher(opts) {
  const { label, appDataRootSh, targetDetectSh, nodeVersion, appVersion, appUrl, appSha256, appArchiveDirName } = opts;
  return `#!/bin/sh
# aki-mcp-sv bootstrap launcher (${label}) — generated at release build time, do not hand-edit.
# First run downloads and checksum-verifies a private Node runtime + the app payload into a
# per-user application-data root; later runs reuse them with no network call.
# docs/plan/standalone-release-delivery.md § Installation layout
set -e

APP_DATA_ROOT="${appDataRootSh}"
NODE_VERSION="${nodeVersion}"
APP_VERSION="${appVersion}"

${SHA256_HELPER}

${INSTALL_HELPER}

${targetDetectSh}

RUNTIME_DIR="$APP_DATA_ROOT/runtime/$NODE_VERSION/$NODE_TARGET"
APP_DIR="$APP_DATA_ROOT/app/$APP_VERSION"

install_verified "$NODE_URL" "$NODE_SHA256" "$RUNTIME_DIR" "node-v$NODE_VERSION-$NODE_DIST_NAME"
install_verified "${appUrl}" "${appSha256}" "$APP_DIR" "${appArchiveDirName}"

NODE_BIN="$RUNTIME_DIR/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "[aki-mcp-sv] expected Node binary missing after install: $NODE_BIN" >&2
  exit 1
fi

cd "$APP_DIR"
exec "$NODE_BIN" "$APP_DIR/scripts/start.js" "$@"
`;
}
