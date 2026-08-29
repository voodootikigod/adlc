/**
 * The rail-density floor — the ONE validator every entry point runs.
 *
 * The floor is the P3 gate's threshold: a non-frontier ticket whose
 * railDensity is below it is forced to frontier and reported as a P3 finding
 * (exit 2). Rule 1b in assign.mjs and the P3 filter in router.mjs are both
 * strict `density < floor` comparisons, so a floor of 0 (or -0) makes them
 * unsatisfiable: every ticket set exits 0 and a ticket with NO rails at all
 * (density 0) silently leaves frontier for whatever the priors say (#697).
 * That is a gate that prosecutes nothing while printing the success path, so
 * the accepted range is the open-closed interval (0, 1] and 0 is an
 * operational error — never a silent kill switch.
 *
 * The bin, `runRouter` and `assignAll`/`assignTicket` all call this, so a
 * library caller cannot disable the gate any more than the CLI can.
 */

export const DEFAULT_FLOOR = 0.2;

export const FLOOR_RANGE_MESSAGE =
  '--floor must be a number greater than 0 and at most 1 — 0 would disable the P3 rail-density gate: ' +
  'every ticket passes and unrailed tickets leave frontier';

/**
 * Assert `floor` is a finite number in (0, 1]. Returns it unchanged.
 *
 * @param {unknown} floor - the parsed floor value
 * @param {string} [raw] - the flag text as typed (echoed in the error); defaults to String(floor)
 * @returns {number}
 * @throws {Error & { isOpError: true }} outside the range, NaN, ±0, ±Infinity, or not a number
 */
export function assertFloor(floor, raw) {
  const inRange = typeof floor === 'number' && Number.isFinite(floor) && floor > 0 && floor <= 1;
  if (!inRange) {
    const got = raw !== undefined ? String(raw) : (Object.is(floor, -0) ? '-0' : String(floor));
    throw Object.assign(new Error(`${FLOOR_RANGE_MESSAGE}; got: ${got}`), { isOpError: true });
  }
  return floor;
}

/**
 * Parse the `--floor` flag text as a strict decimal (optional sign, digits,
 * optional fraction, optional exponent; surrounding whitespace ignored).
 * Anything else — `0.5abc`, `0x1`, `1,5`, `` — is NaN, which assertFloor then
 * refuses. parseFloat would have accepted `0.5abc` as 0.5 (Codex review r2),
 * silently honouring a mistyped value as a real floor.
 *
 * @param {string} raw
 * @returns {number} the value, or NaN when the text is not a plain decimal
 */
export function parseFloor(raw) {
  const text = String(raw).trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
}
