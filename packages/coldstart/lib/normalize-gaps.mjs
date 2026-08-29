// normalize-gaps.mjs — the ONE shape authority for an executability verdict
// (issue #594).
//
// The auditor is instructed to answer `{"gaps": [...]}`. Before this module,
// anything that parsed as JSON but was not literally an array at `.gaps` was
// coerced to `[]` — so a model that returned its blockers as a bare top-level
// array, or `{"blockers": [...]}`, or `{"gaps": "two gaps found"}`, produced
// "[PASS] ticket is fully executable", exit 0, and a cached clean verdict. The
// gate could not tell "the auditor said clean" from "the auditor's answer was
// unreadable", and resolved the ambiguity as clean.
//
// Contract:
//   - `{gaps: Array}`            → the gaps
//   - a bare `Array`             → the gaps (the most common deviation, recovered)
//   - entry: object with string `what` → kept (copied)
//   - entry: string              → `{ what, why_blocking: 'unspecified' }`
//   - ANYTHING else              → throws (message starts with
//                                   UNREADABLE_VERDICT_PREFIX), which the CLI
//                                   reports as an operational error (exit 1),
//                                   never as a pass.
// Pure: no I/O, no env. Used by the real LLM path, the ADLC_GATE_MOCK_RESPONSE
// test seam and the cache reader, so all three agree on what "readable" means.

export const UNREADABLE_VERDICT_PREFIX = 'coldstart: unreadable executability verdict —';

/** Hard cap on how much of the received shape an error message may describe. */
const MAX_SHAPE_CHARS = 160;
const MAX_KEYS_SHOWN = 8;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Describe a value's SHAPE (type, length, top-level keys) for an error
 * message — never its content, so a hostile or huge model reply cannot
 * flood the operator's terminal or a log.
 */
export function describeShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return `string(${value.length} chars)`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const shown = keys.slice(0, MAX_KEYS_SHOWN).join(', ');
    const more = keys.length > MAX_KEYS_SHOWN ? ', …' : '';
    return `object with keys [${shown}${more}]`.slice(0, MAX_SHAPE_CHARS);
  }
  return typeof value;
}

function unreadable(detail) {
  return new Error(`${UNREADABLE_VERDICT_PREFIX} ${detail}`);
}

/**
 * Normalize a parsed auditor reply into the gaps list, or throw.
 *
 * @param {unknown} parsed - output of extractJson / JSON.parse / a cache entry's gaps
 * @returns {Array<{what: string, why_blocking?: string}>} a NEW array (no aliasing of model output)
 * @throws {Error} whose message starts with UNREADABLE_VERDICT_PREFIX
 */
export function normalizeGaps(parsed) {
  let list;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (isPlainObject(parsed) && Array.isArray(parsed.gaps)) {
    list = parsed.gaps;
  } else {
    throw unreadable(`expected {"gaps":[...]} or a bare array, got ${describeShape(parsed)}`);
  }
  return list.map((entry, i) => {
    if (typeof entry === 'string') return { what: entry, why_blocking: 'unspecified' };
    if (isPlainObject(entry) && typeof entry.what === 'string') return { ...entry };
    throw unreadable(`gaps[${i}] must be an object with a string "what" (or a string), got ${describeShape(entry)}`);
  });
}
