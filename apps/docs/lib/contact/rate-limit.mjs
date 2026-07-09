// Fixed-window rate limiter. PM-B: keyed by caller (the route passes the first
// x-forwarded-for hop); expired windows are evicted on every call so the map
// cannot grow unbounded. NOTE: this is per-serverless-instance and therefore
// best-effort on Vercel — a cold instance starts empty. It is a secondary
// defense; Vercel BotID + the honeypot are the primary ones. Upgrade to a shared
// store (e.g. Upstash) if a globally-consistent limit is ever required.

/**
 * @param {{ max?: number, windowMs?: number, now?: () => number }} [opts]
 */
export function createRateLimiter({
  max = 5,
  windowMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const hits = new Map();

  return {
    check(key) {
      const t = now();
      // Evict expired windows so the map stays bounded.
      for (const [k, v] of hits) {
        if (v.resetAt <= t) hits.delete(k);
      }
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      const allowed = entry.count <= max;
      return { allowed, remaining: Math.max(0, max - entry.count) };
    },
  };
}
