/**
 * The flag table, rendered into help rather than written as prose.
 *
 * Help text as a single literal is untestable in the way that matters: the only
 * assertion available is that the source says what the source says. Rendering it
 * from data makes the CLI's documented surface a function of its actual option
 * set, so `renderUsage` can be tested and help cannot drift from the parser
 * without a test noticing.
 */
export const FLAGS = [
  { name: 'profile', arg: 'path', help: 'profile JSON (default .claude/backlog-groom-profile.json)' },
  { name: 'cache', arg: 'path', help: 'cache file (default .adlc/backlog-groom-cache.json; gitignored)' },
  { name: 'no-cache', arg: null, help: 'verify everything, ignoring and not writing the cache' },
  { name: 'threshold', arg: 'n', default: '0.2', help: 'relation candidate-filter threshold (default 0.2)' },
  { name: 'json', arg: null, help: 'emit the groomed set as JSON instead of the report' },
  { name: 'out', arg: 'path', help: 'write the groomed set JSON to a file' },
  { name: 'apply', arg: null, help: 'apply gated conclusions to GitHub (writes; off by default)' },
  { name: 'set', arg: 'path', help: 'with --apply: the groomed set JSON to act on' },
  { name: 'help', arg: null, help: 'show this message' },
];

/**
 * The `parseArgs` options object, DERIVED from the same table that renders help.
 *
 * One table feeding both is what actually enforces "help cannot drift from the
 * parser". Two hand-maintained lists would let a flag exist and go undocumented,
 * or be documented and not exist, and nothing would notice.
 *
 * Every boolean defaults FALSE. A boolean flag that defaults true is a switch
 * the operator cannot turn off by omission, and `--no-cache` defaulting true
 * would silently disable the cache for every run.
 */
export function parseOptions(flags = FLAGS) {
  const out = {};
  for (const f of flags) {
    out[f.name] = f.arg ? { type: 'string' } : { type: 'boolean', default: false };
    if (f.arg && f.default !== undefined) out[f.name].default = f.default;
  }
  return out;
}

/** Render the usage block from the flag table. */
/** The help column the flag list pads to, when the flag is short enough to fit. */
const COLUMN = 22;

export function renderUsage(flags = FLAGS) {
  const lines = ['backlog-groom — groom a GitHub issue backlog against the code (read-only)', ''];
  for (const f of flags) {
    const left = f.arg ? `--${f.name} <${f.arg}>` : `--${f.name}`;
    // At least ONE space, always. A bare padEnd collapses to zero padding once a
    // flag outgrows the column, and the help text then runs straight into the
    // flag name — which reads as a different, longer flag.
    lines.push(`  ${left.padEnd(Math.max(COLUMN, left.length + 1))}${f.help}`);
  }
  lines.push('', 'Without --apply this command never writes to GitHub.');
  lines.push('With --apply, every action is gated by an independent reviewer and bounded by');
  lines.push('the autonomy floor; nothing is written that both did not permit.');
  return lines.join('\n');
}

/**
 * Validate `--threshold`, returning the number or throwing an operational error.
 *
 * In lib rather than the binary so its BOUNDARIES can be tested without a
 * network call: 0 and 1 are both legal (groom everything / groom nothing), and
 * the binary's own path past this point reaches `gh`.
 */
export function validateThreshold(raw) {
  // Parsed STRICTLY, not coerced. `Number('')` is 0, so an empty `--threshold ''`
  // would silently mean "surface every pair" — a value the operator never typed.
  // Same trap `model-router/lib/floor.mjs` documents for `parseFloat('0.5abc')`:
  // a lenient parser invents a setting out of a typo.
  const text = String(raw).trim();
  const n = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw Object.assign(new Error(`--threshold must be a number between 0 and 1, got: ${raw}`), { isOpError: true });
  }
  return n;
}

/**
 * Validate the `--apply` flag combination. Returns an error message, or null.
 *
 * IN LIB FOR THE SAME REASON THE REST OF THIS FILE IS: a guard left in the
 * binary is reachable only by spawning the process, so it goes untested and an
 * inverted comparison — demanding `--set` only when it was already supplied —
 * passes every suite while making the write path unusable or, worse, usable
 * without the set it is supposed to act on.
 */
export function validateApplyArgs(values = {}) {
  if (!values.apply) return null;
  if (!values.set) return '--apply requires --set <path> — the groomed set to act on';
  return null;
}

/**
 * The message an operational error should print.
 *
 * An `isOpError` already carries a message written for an operator; anything
 * else is an unexpected failure and needs its context prefixed, or the operator
 * sees a bare `ENOENT` with no clue which file. Extracted because the ternary is
 * a branch, and a branch in the binary is a branch nothing tests.
 */
export function describeError(err, context) {
  return err?.isOpError ? err.message : `${context}: ${err?.message ?? err}`;
}
