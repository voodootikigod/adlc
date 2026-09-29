/**
 * The incrementality cache (spec §4).
 *
 * Keyed per issue on `(updatedAt, contentHash)`: an issue is re-verified when
 * either its own text or the code it cites has changed.
 *
 * THE RULE THAT KEEPS THE CACHE HONEST: an issue whose key has no contentHash —
 * no referenced paths, or any cited path unreadable at the revision — is keyed
 * on `updatedAt` alone, so no code change can ever invalidate it. Such an entry
 * may only record that nothing could be concluded (`unverifiable`,
 * `unverified`). A conclusion about code (`valid`, `fixed`, `moved`) under that
 * key would be served after the code changed: the bug fixed and still `valid`,
 * or the fix reverted and still `fixed`. That is the decay this package exists
 * to detect, reintroduced inside its own cache, so the entry is refused on write
 * AND treated as a miss on read.
 *
 * A miss is the ABSENCE of an answer, never an optimistic one.
 */

/**
 * Bump when verification, parsing or verdict semantics change.
 *
 * Raised in cross-model review, and it is the same failure this package exists
 * to detect, turned inward: without it, an older release stores a wrong verdict,
 * a newer release fixes the verifier, and the fixed code never runs — the issue
 * text and the file bytes are unchanged, so the key still matches and the stale
 * verdict is served indefinitely. Every fix to the verifier that this version
 * does not accompany is a fix that does not reach a cached backlog.
 *
 * 2: excerpts became a list per citation and are aggregated conservatively, so
 *    verdicts computed under the single-excerpt rule are no longer trustworthy.
 * 3: entries carry `verifiedPaths` (the per-citation verified locations that
 *    clustering and area relabels rely on), and a cited directory is no longer
 *    read as a file.
 */
export const CACHE_SCHEMA_VERSION = 3;

/** The only verdicts and routes a cache entry may claim. */
const VALID_VERDICTS = new Set(['valid', 'fixed', 'moved', 'unverifiable', 'unverified']);
const VALID_ROUTES = new Set(['mechanical', 'model', 'unverifiable']);

/** Verdicts that conclude nothing about code, and so need no code component in their key. */
const CODELESS_VERDICTS = new Set(['unverifiable', 'unverified']);

/** Whether `verdict` may be held under `key`: a conclusion about code needs a contentHash. */
function bindsToCode(key, verdict) {
  return key.contentHash != null || CODELESS_VERDICTS.has(verdict);
}

function isPathList(value) {
  return Array.isArray(value) && value.every((p) => typeof p === 'string');
}

/** Unambiguous composite key: length-delimited so two fields cannot alias. */
export function cacheKeyFor({ updatedAt, contentHash }) {
  const u = String(updatedAt ?? '');
  const c = contentHash == null ? '' : String(contentHash);
  const v = String(CACHE_SCHEMA_VERSION);
  return `v${v.length}:${v}|${u.length}:${u}|${c.length}:${c}`;
}

/**
 * Read a cached verdict, or null.
 *
 * A malformed entry — not an object, or carrying no verdict — is a MISS rather
 * than a hit, so a corrupted cache degrades into extra work instead of into
 * fabricated conclusions.
 */
export function cacheGet(store, key) {
  const entry = store?.[String(key.number)];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  // Validated against ENUMS, not merely "is a string". The documented contract
  // is that a corrupt cache costs a slow run and never a wrong answer, and an
  // entry claiming `verdict: "fixed!"` or an unknown route is corrupt — it has
  // to become a miss, or the contract only holds for corruption clumsy enough to
  // drop the field entirely.
  if (!VALID_VERDICTS.has(entry.verdict)) return null;
  if (entry.route !== undefined && !VALID_ROUTES.has(entry.route)) return null;
  // Evidence, when present, must be an object — a cached string or array would
  // flow into a close proposal's evidence field unchecked.
  if (entry.evidence !== undefined && entry.evidence !== null
      && (typeof entry.evidence !== 'object' || Array.isArray(entry.evidence))) return null;
  if (!isPathList(entry.verifiedPaths)) return null;
  if (!bindsToCode(key, entry.verdict)) return null;
  if (entry.key !== cacheKeyFor(key)) return null;
  return entry;
}

/**
 * Store a verdict, unless doing so would create an entry that cannot be
 * invalidated by a code change.
 *
 * Returns whether the entry was stored, so a caller can report the refusal
 * rather than silently believing it cached.
 */
export function cachePut(store, key, value) {
  // `contentHash` covers the referenced FILES, never the issue body, so
  // `updatedAt` is the only component that notices a premise being rewritten.
  // Without it the key cannot be invalidated by an edit, and a verdict computed
  // from the old premise would be served forever.
  if (key.updatedAt == null || String(key.updatedAt).length === 0) return false;
  if (!bindsToCode(key, value?.verdict)) return false;
  store[String(key.number)] = { ...value, key: cacheKeyFor(key) };
  return true;
}
