/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * `undefined` (top level, object value, array element) is written as `null`.
 * NOT interchangeable with `@adlc/core`'s `canonicalJson`, which drops
 * undefined-valued keys. The output is signed, so the format is frozen.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
