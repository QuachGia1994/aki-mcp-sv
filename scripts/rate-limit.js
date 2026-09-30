// Failure-only sliding-window limiter for the public gatekeeper: a caller who keeps failing is refused, a caller with valid credentials is never counted (docs/ref/security-model.md § Rate limiting).
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function createLimiter({ max, windowMs, maxKeys = 10000, now = Date.now }) {
  const hits = new Map();
  const recent = (key) => {
    const cutoff = now() - windowMs;
    const list = (hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  return {
    retryAfterSeconds(key) {
      const list = recent(key);
      return list.length >= max ? Math.ceil((list[0] + windowMs - now()) / 1000) : 0;
    },
    record(key) {
      const list = recent(key);
      list.push(now());
      hits.set(key, list);
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      return list.length >= max;
    },
  };
}

// Tunnelled traffic reaches the gatekeeper from the tunnel client on loopback, so the socket address alone would put every remote caller in one bucket.
// The forwarding headers are read only when the peer is loopback (a local process is already inside the trust boundary); the last X-Forwarded-For entry is the one the nearest proxy appended.
export function clientKey(req) {
  const peer = req.socket.remoteAddress || 'unknown';
  if (!LOOPBACK.has(peer)) return peer;
  const cloudflare = req.headers['cf-connecting-ip'];
  if (typeof cloudflare === 'string' && cloudflare) return cloudflare.trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',').pop().trim();
  return 'loopback';
}
