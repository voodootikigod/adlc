// limit.mjs — the ONE validator for `--limit <n>`.
//
// The value bounds how many issues a listing fetches, and the provider treats a
// full page as possible truncation. A lenient parse would turn a typo into a
// silently different cap: `Number('1e3')` is 1000, `parseInt('10abc')` is 10,
// `Number(' 5')` is 5. So nothing is coerced — the token is either a plain
// positive decimal integer or it is refused, and the caller exits 1.

const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

export const MISSING_LIMIT = '--limit requires a positive integer value';

/**
 * @param {unknown} raw - the argv token following `--limit` (undefined when absent)
 * @returns {{ok: true, value: number} | {ok: false, error: string}}
 */
export function parseLimit(raw) {
  // A following flag means the value was forgotten, not that `--json` is a bad number.
  if (raw === undefined || (typeof raw === 'string' && raw.startsWith('--'))) {
    return { ok: false, error: MISSING_LIMIT };
  }
  if (typeof raw === 'string' && POSITIVE_DECIMAL.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return { ok: true, value };
  }
  return { ok: false, error: `invalid --limit: ${raw} (expected a positive integer)` };
}
