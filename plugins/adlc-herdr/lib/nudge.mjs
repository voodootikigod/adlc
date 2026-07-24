// Pure dedupe-bucket helpers for the agent-idle nudge (t-herdr-5). The time
// window is encoded in the marker NAME so the claim is a single atomic
// exclusive-create (see bin/on-event.mjs). Names are `<sha256(key)>-<bucket>`
// so all of a key's markers — and every bucket — are enumerable for cleanup.
import { createHash } from 'node:crypto';

/** The window bucket for `nowMs`, or null when dedupe is disabled (windowMs<=0). */
export function bucketFor(nowMs, windowMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  if (!Number.isFinite(nowMs)) return null;
  return Math.floor(nowMs / windowMs);
}

/** Marker filename for a dedupe key in a given bucket. */
export function markerName(key, bucket) {
  return `${createHash('sha256').update(String(key)).digest('hex')}-${bucket}`;
}

/** Parse the bucket number out of a marker filename, or null if it isn't one. */
export function markerBucket(name) {
  if (typeof name !== 'string') return null;
  const i = name.lastIndexOf('-');
  if (i < 0) return null;
  const n = Number(name.slice(i + 1));
  return Number.isInteger(n) ? n : null;
}

/** A marker is stale (safe to delete) when its bucket is older than the current
 *  one — regardless of which key it belongs to, so a single pass bounds the
 *  whole directory to the current window's markers. */
export function isStaleMarker(name, currentBucket) {
  const b = markerBucket(name);
  return b !== null && b < currentBucket;
}
