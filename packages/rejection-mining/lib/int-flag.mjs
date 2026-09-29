// int-flag.mjs — strict parser for positive-integer CLI flags.
//
// parseInt accepts a numeric prefix ('1e3' is 1, '50x' is 50), which turns a
// typo into a silently different cap. The whole token must be a plain positive
// decimal integer that JavaScript represents exactly, or it is refused.

const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

/**
 * @param {unknown} raw - the flag's string value
 * @returns {{ok: true, value: number} | {ok: false}}
 */
export function parsePositiveInt(raw) {
  if (typeof raw !== 'string' || !POSITIVE_DECIMAL.test(raw)) return { ok: false };
  const value = Number(raw);
  return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false };
}
