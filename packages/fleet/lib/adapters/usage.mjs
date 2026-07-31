// Usage parsing shared across WorkerAdapters (T152, operating-stack §8a).
//
// Each adapter owns an ADAPTER-SPECIFIC parser of its own harness's documented
// machine-readable output — there is deliberately no generic "read a `usage`
// property off the exec result" path, because production `spawnAsync` never
// emits one (it returns status/signal/stdout/stderr/error/timedOut and nothing
// else). What lives here is only the part that is genuinely common: the
// normalized shape, the no-fabrication rule, and the counter validation every
// parser applies to whatever it managed to pull out of its harness.

/**
 * THE NO-FABRICATION RULE (binding; mirrors @adlc/core's existing contract).
 *
 * A harness that reports no usage gets NO `usage` key — never a zeroed object.
 * `aggregateSpend` counts one call per entry carrying `data.usage` and sums its
 * counters, so a zeroed object would book an UNMEASURED call as a measured free
 * one and collapse "we don't know" into "it cost nothing". The distinction is
 * carried by `usageStatus` instead, which is always present.
 */
export const UNREPORTED = Object.freeze({ usageStatus: 'unreported' });

/**
 * `reported` is RESERVED for usage an adapter parsed out of its harness's own
 * machine-readable output — i.e. telemetry the harness attested to. Caller-
 * supplied packet counters record as `claimed` on the P5 path instead: shape
 * validation cannot prove a provider ever emitted those numbers, and letting
 * them enter as `reported` would let a caller mint attested telemetry.
 */
export function reported(usage, raw) {
  return raw === undefined
    ? { usage, usageStatus: 'reported' }
    : { usage, usageStatus: 'reported', usageRaw: raw };
}

/**
 * A token counter is a non-negative integer. Anything else — a float, a
 * negative, a numeric string, NaN — means we did not understand the payload,
 * and a misunderstood payload is UNREPORTED, not a guess. `aggregateSpend`
 * coerces with `?? 0` and never validates, so this is the only place a bad
 * counter can be caught before it silently pollutes the ledger.
 */
export function isCount(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * Build the normalized `{inputTokens, outputTokens, cachedTokens}` triple that
 * `spend.mjs` defines, rejecting the whole thing if any counter is not a clean
 * count. Returns null on rejection so callers fall through to UNREPORTED —
 * partial usage is never emitted, since a half-parsed payload aggregating as
 * though it were complete is exactly the silent under-report this module exists
 * to prevent.
 */
export function normalizeUsage({ inputTokens, outputTokens, cachedTokens }) {
  if (!isCount(inputTokens) || !isCount(outputTokens) || !isCount(cachedTokens)) return null;
  return { inputTokens, outputTokens, cachedTokens };
}

/**
 * Project a dispatch result into the `data` payload of a gate-manifest entry.
 *
 * The no-fabrication rule crosses the seam here: `usageStatus` is ALWAYS
 * present, `usage` only when the harness actually reported. A dispatch that
 * reported nothing therefore records `{usageStatus: 'unreported'}` — which
 * `aggregateSpend` skips entirely — rather than a zeroed object it would
 * happily count as a measured free call.
 *
 * Returns undefined for a missing result so a caller with nothing to say
 * records nothing, rather than asserting "unreported" about a call that may
 * never have happened.
 */
export function usageEvidence(result) {
  if (result === null || typeof result !== 'object') return undefined;
  const data = { usageStatus: result.usageStatus ?? 'unreported' };
  if (result.usage !== undefined) data.usage = result.usage;
  if (result.usageRaw !== undefined) data.usageRaw = result.usageRaw;
  return data;
}

/**
 * Parse JSONL defensively: harnesses interleave their event stream with
 * whatever they print to stderr, and adapters concatenate both. A line that is
 * not JSON is not an error — it is not an event. Returns only the objects.
 */
export function jsonLines(text) {
  if (typeof text !== 'string') return { events: [], malformed: false };
  const events = [];
  let malformed = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed[0] !== '{' && trimmed[0] !== '[') continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') events.push(parsed);
      else malformed = true;
    } catch {
      // A line that OPENS like JSON but does not parse is a truncation signal,
      // not noise: this reads the harness's STDOUT, which in machine-readable
      // mode is pure JSONL. Silently dropping it turned a pipe that died
      // mid-stream into a confident partial total (adversarial-review).
      malformed = true;
    }
  }
  return { events, malformed };
}
