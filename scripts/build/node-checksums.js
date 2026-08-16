// Fetches the official published SHA-256 manifest for a Node release, once at build time, and
// reads out the hash for one target's archive filename. This is the only network call allowed
// to determine a value that gets baked into a launcher — the launcher itself embeds the result,
// never re-fetches it (docs/plan/standalone-release-delivery.md § Installation layout: "Do not
// fetch an unpinned `latest` manifest at startup").

/** @param {string} nodeVersion @returns {Promise<Map<string, string>>} filename -> lowercase hex sha256 */
export async function fetchNodeShasums(nodeVersion) {
  const url = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch Node checksum manifest: ${res.status} ${url}`);
  const text = await res.text();
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+\S*?([^\s/]+)$/);
    if (m) map.set(m[2], m[1]);
  }
  if (map.size === 0) throw new Error(`Node checksum manifest at ${url} parsed to zero entries`);
  return map;
}

/** @param {Map<string,string>} shasums @param {string} nodeVersion @param {{dist:string, ext:string}} distTarget */
export function nodeArchiveInfo(shasums, nodeVersion, distTarget) {
  const filename = `node-v${nodeVersion}-${distTarget.dist}.${distTarget.ext}`;
  const sha256 = shasums.get(filename);
  if (!sha256) throw new Error(`no checksum found for ${filename} in the fetched Node manifest`);
  return { filename, url: `https://nodejs.org/dist/v${nodeVersion}/${filename}`, sha256 };
}
