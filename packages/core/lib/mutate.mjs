// Line-level mutation operators, shared by hollow-test (kill-the-mutant gate)
// and review-calibration (plant-the-bug recall measurement).
// Text-based by design: language-agnostic-enough for JS/TS/Python-style code,
// cheap, and deterministic.

// Loose-equality null checks. Deliberately excludes strict === / !== (which
// invert-comparison already handles) via negative look-around: a run of
// exactly two '=' (or '!' + '=') not adjacent to another '='.
const LOOSE_EQ_NULL_RE = /(?<![=!])==(?!=)\s*null\b/;
const LOOSE_NEQ_NULL_RE = /(?<!!)!=(?!=)\s*null\b/;

// ── Tuning constants are not boundaries (#359, repaired by #372) ────────────
// off-by-one exists to catch BOUNDARY mistakes — an index, a length, a count.
// A duration in milliseconds or a size in bytes is a tuning knob, and +1 there is
// an EQUIVALENT MUTANT: no test can observe 60000 -> 60001 ms on a subprocess
// timeout, or 512 -> 513 MiB of buffer. Generating it made the gate demand a test
// that cannot exist, and the only way to satisfy that demand was a source-text pin
// assertion — i.e. adding a hollow test to placate the anti-hollow-test gate.
// (Found landing #353, where `timeout: 60000` in rails-guard-ci's git() helper
// survived and there was no honest way to kill it.)
//
// #359 spelled the rule as a KEY-NAME ALTERNATION anchored on `\b<key>\s*[:=]`.
// That shape is wrong twice over and #372 replaces it:
//   - a LEADING segment kills the `\b` — `GIT_TIMEOUT_MS`, `gitTimeoutMs` never
//     matched, because `_T`/`tT` is not a word boundary;
//   - a TRAILING segment kills the separator anchor — `MAX_BUFFER_BYTES`,
//     `maxBufferBytes` never matched, because `_BYTES` sits where `=` had to be.
// `*_BYTES` and `*_MS` are the IDIOMATIC spellings — naming the unit is what a
// reader wants — so the old rule penalized the clearer name. #363 renamed a real
// `MAX_BUFFER_BYTES` to `MAX_BUFFER` for no reason but to get the gate green.
//
// The rule is now stated over the identifier's SEGMENTS (snake_case and camelCase
// both split to the same list), with the TRAILING segment deciding first:
//
//   1. a trailing DISCRETE-QUANTITY word (retries, limit, count, size, index,
//      code, …) means the name denotes a COUNT — always mutable, whatever else
//      the name contains. This is what keeps `timeoutRetries` and `retryLimit`
//      prosecuted, and it is what returns `chunkSize`/`bufferSize` to
//      prosecution (#372 defect 2): a chunk size counts ELEMENTS, and a test can
//      assert the resulting batch length, so +1 there is observable — exactly the
//      boundary this operator exists to catch. #359 had them masked, which
//      silently deleted that prosecution.
//   2. a trailing UNOBSERVABLE-MAGNITUDE UNIT (ms, µs, ns, bytes, MiB, …) means
//      the name declares a physical magnitude — masked. Sub-second and byte units
//      only: `RETENTION_DAYS = 7 -> 8` IS observable under an injected clock, so
//      coarse time units stay mutable. The bar is "no test could ever tell".
//   3. otherwise, a known TUNING PHRASE anywhere in the segment run (timeout,
//      ttl, maxBuffer, highWaterMark, …) — masked.
//
// Rule 1 running BEFORE rules 2 and 3 is the whole safety property: widening the
// key match is the direction that DELETES real prosecution, and a count word in
// the tail is the strongest available signal that the value is countable.
//
// KNOWN LIMIT — the value must be a NUMERIC LITERAL EXPRESSION reached from its
// key by nothing but whitespace and closed `/* … */` comments. Two shapes are
// therefore still mutated, and both can still produce an unkillable mutant:
//   - a bare call argument:  setTimeout(fn, 1000)   sleep(30000)
//   - a COMPUTED value:      timeout: isDev ? 1000 : 60000    timeout = delay || 60000
// Widening to "mask every number between the key and the next terminator" would fix
// those and break something worse: in `timeout: cfg.max > arr.length - 1 ? 100 : 200`
// it swallows `arr.length - 1`, a REAL boundary, silently deleting prosecution of it.
// Precision beats breadth here — extend only when a concrete survivor demands it.
// (#372 defect 3 closed the two ASSIGNMENT shapes the old disclosure implied were
// covered and were not: a QUOTED property key `{ "timeout": 60000 }`, and a value
// separated from its key by an inline unit comment `{ timeout: /* ms */ 60000 }`.)
//
// Floats are a non-issue for a different reason: off-by-one's digit-run pattern rejects
// a run adjacent to `.`, so `ttl: 0.0` is unmutatable whether masked or not.
//
// Extend these lists only for a word whose ±1 is genuinely unobservable — every
// addition removes real prosecution, so the bar is "no test could ever tell", not
// "no test currently does".

/**
 * Split an identifier into lowercase segments. snake_case, SCREAMING_SNAKE,
 * camelCase, PascalCase and acronym runs all reduce to the same list, so the
 * classification below is stated ONCE instead of once per spelling — the failure
 * mode #372 defect 1 was made of.
 *
 *   MAX_BUFFER_BYTES -> [max, buffer, bytes]
 *   maxBufferBytes   -> [max, buffer, bytes]
 *   HTTPTimeoutMs    -> [http, timeout, ms]
 */
export function identifierSegments(name) {
  return String(name)
    .replace(/[_$\d]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

// Rule 1. A trailing segment naming a COUNTABLE thing. `max`/`min` are
// deliberately absent: they are modifiers, not units, so `BUFFER_MAX` keeps the
// magnitude reading its `buffer` segment gives it.
const DISCRETE_TAIL = new Set([
  'retries', 'retry', 'tries', 'attempts', 'attempt', 'count', 'counts',
  'limit', 'limits', 'size', 'sizes', 'length', 'len', 'index', 'idx',
  'offset', 'code', 'codes', 'id', 'ids', 'version', 'port', 'level',
  'priority', 'depth', 'concurrency', 'workers', 'slots', 'page', 'pages',
  'num', 'number', 'numbers', 'items', 'rows', 'lines', 'chars', 'columns',
]);

// Rule 2. A trailing segment naming a unit in which ±1 cannot be observed.
// Sub-second time and bytes only — see the note on coarse units above.
const MAGNITUDE_UNIT_TAIL = new Set([
  'ms', 'msec', 'msecs', 'milli', 'millis', 'millisecond', 'milliseconds',
  'us', 'usec', 'usecs', 'micro', 'micros', 'microsecond', 'microseconds',
  'ns', 'nsec', 'nsecs', 'nano', 'nanos', 'nanosecond', 'nanoseconds',
  'byte', 'bytes', 'kb', 'mb', 'gb', 'tb', 'kib', 'mib', 'gib', 'tib',
  'kbytes', 'mbytes', 'gbytes',
]);

// Rule 3. Known tuning phrases, written as the JOINED segment run they must
// match (so `max_age`, `maxAge` and `MAXAGE` are one entry, not three).
const TUNING_PHRASES = new Set([
  'timeout', 'delay', 'interval', 'backoff', 'ttl',
  'maxage', 'keepalive', 'maxbuffer', 'highwatermark', 'maxbytes',
]);

/**
 * Is this identifier a TUNING knob (mask it) rather than a BOUNDARY (mutate it)?
 * Exported so the property test can assert the decision is a function of the
 * identifier's SEGMENTS — i.e. that a new spelling of an already-classified name
 * needs no new enumerated case.
 */
export function isTuningIdentifier(name) {
  const segs = identifierSegments(name);
  if (segs.length === 0) return false;
  const tail = segs[segs.length - 1];
  if (DISCRETE_TAIL.has(tail)) return false;
  if (MAGNITUDE_UNIT_TAIL.has(tail)) return true;
  for (let i = 0; i < segs.length; i++) {
    let joined = '';
    for (let j = i; j < segs.length; j++) {
      joined += segs[j];
      if (TUNING_PHRASES.has(joined)) return true;
    }
  }
  return false;
}

// A CLOSED block comment. Masked (length-preserving) before anything else looks
// at the line, for two independent reasons: it lets a key reach its value across
// an inline unit comment (`timeout: /* ms */ 60000`, #372 defect 3), and it stops
// digits INSIDE a comment being picked as the boundary to mutate.
const BLOCK_COMMENT_RE = /\/\*(?:(?!\*\/)[\s\S])*?\*\//g;

// A key (bare identifier or quoted property name), its separator, and its whole
// NUMERIC VALUE EXPRESSION. The value class spans arithmetic so `512 * 1024 *
// 1024` is covered end to end — matching only `512` would leave `1024` exposed
// and reproduce the same unkillable mutant one factor to the right. Letters are
// excluded from the value class, so a match can never run past this key's value
// into the next key's name.
// The leading `-?` matters: a NEGATIVE duration is a sentinel ("disabled", "wait
// forever"), so -1 -> -2 takes the same branch and is unkillable for exactly the
// reason 60001 was. Without the sign the mask misses it and the bug recurs.
const ASSIGNMENT_RE = /(['"`]?)([A-Za-z_$][\w$]*)\1\s*[:=]\s*(-?\d[\d\s*+\-/_.]*)/g;

// A value of exactly ZERO is never masked. The whole rationale for masking is that
// ±1 is unobservable, and that holds at MAGNITUDE but fails at zero: across every
// key here, 0 means disabled / none / immediate, so 0 -> 1 flips a real
// semantic branch that a test can and should catch. `{ ttl: 0 }` is a discrete
// boundary wearing a tuning key's name — prosecute it. (Cross-model review finding,
// HIGH: masking it let a security-relevant sentinel escape the gate entirely.)
const ZERO_VALUE_RE = /^-?0+$/;

const blank = (s) => ' '.repeat(s.length);

// Blank out closed block comments and tuning assignments, PRESERVING LENGTH so an
// index into the masked line addresses the same character in the original.
function maskTuningAssignments(line) {
  const withoutComments = line.replace(BLOCK_COMMENT_RE, blank);
  return withoutComments.replace(ASSIGNMENT_RE, (match, _quote, key, value) => {
    if (!isTuningIdentifier(key)) return match;
    return ZERO_VALUE_RE.test(value.trim()) ? match : blank(match);
  });
}

// A simple array literal of 2+ quoted-string / bare-word elements, e.g.
// `['id', 'title', 'scope']` or `[a, b, c]`. Deliberately excludes nested
// brackets/braces/parens so it never mis-grabs function calls or object
// literals.
const ARRAY_LITERAL_ELEMENT = String.raw`(?:'[^']*'|"[^"]*"|\`[^\`]*\`|[\w$.]+)`;
const ARRAY_LITERAL_RE = new RegExp(
  `\\[\\s*(${ARRAY_LITERAL_ELEMENT}(?:\\s*,\\s*${ARRAY_LITERAL_ELEMENT})+)\\s*\\]`
);

/** Split a comma-joined element blob on top-level commas, quote-aware. */
function splitTopLevelCommas(str) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const ch of str) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// A single-line ternary `cond ? whenTrue : whenFalse`. Matches the `cond ?
// whenTrue :` head with a regex (whenTrue excludes `?:{}` so it never
// mis-fires on nested ternaries or object literals), then hands the rest of
// the line to a depth-aware scanner (see parseTernary/findTernaryEnd below)
// that finds where whenFalse actually ends — instead of assuming it runs to
// end-of-line. A naive `$`-anchored regex would happily absorb a trailing
// `//` comment or the remainder of an enclosing array/call-argument list
// into whenFalse and relocate it during the swap, corrupting the line
// rather than producing a clean mutant or failing closed.
const TERNARY_HEAD_RE = /^(.*?)\?(?!\.)\s*([^?:{}]+?)\s*:\s*/;

/**
 * Parse a single-line ternary into its four parts, or return null if the
 * line isn't a clean, swappable single-line ternary.
 *
 * whenFalse's true end is found with a bracket-depth scan (findTernaryEnd)
 * rather than assumed to run to end-of-line: it stops at the first
 * top-level `,`, `;`, `//` comment start, or unmatched closing `)`/`]` —
 * any of which mean the ternary is embedded in, or followed by, something
 * else on the line. Whatever trails whenFalse must then be nothing but an
 * optional `;` and whitespace, and whenFalse itself must not contain a
 * stray `?`, `:`, `{`, or `}` (nested ternary / object literal) — otherwise
 * this fails closed (returns null) instead of guessing.
 */
function parseTernary(line) {
  const head = line.match(TERNARY_HEAD_RE);
  if (!head) return null;
  const [full, prefix, whenTrue] = head;
  const rest = line.slice(full.length);
  const end = findTernaryEnd(rest);
  const whenFalse = rest.slice(0, end);
  const trailing = rest.slice(end);
  if (/[?:{}]/.test(whenFalse)) return null;
  if (!/^;?\s*$/.test(trailing)) return null;
  const suffix = trailing.includes(';') ? ';' : '';
  return { prefix, whenTrue, whenFalse, suffix };
}

/**
 * Find the index in `rest` (the text after the ternary's `:`) where
 * whenFalse actually ends: the first top-level (bracket-depth-0) `,`, `;`,
 * or `//`, or an unmatched closing `)`/`]` that must belong to an
 * enclosing construct rather than to whenFalse. Falls back to the full
 * string length when nothing stops it first.
 */
function findTernaryEnd(rest) {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(' || ch === '[') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']') {
      if (depth === 0) return i;
      depth--;
      continue;
    }
    if (depth === 0) {
      if (ch === ',' || ch === ';') return i;
      if (ch === '/' && rest[i + 1] === '/') return i;
    }
  }
  return rest.length;
}

export const OPERATORS = [
  {
    name: 'invert-comparison',
    apply(line) {
      const swaps = [
        [/===/g, '!=='], [/!==/g, '==='],
        [/<=/g, '>'], [/>=/g, '<'],
        [/(?<![<>=!])<(?![=<])/g, '>='], [/(?<![<>=!-])>(?![=>])/g, '<='],
      ];
      for (const [re, replacement] of swaps) {
        if (re.test(line)) return line.replace(re, replacement);
      }
      return null;
    },
  },
  {
    name: 'bool-flip',
    apply(line) {
      if (/\btrue\b/.test(line)) return line.replace(/\btrue\b/, 'false');
      if (/\bfalse\b/.test(line)) return line.replace(/\bfalse\b/, 'true');
      return null;
    },
  },
  {
    name: 'null-return',
    apply(line) {
      const m = line.match(/^(\s*)return\s+(?!null\b)(?!;)(.+);?\s*$/);
      if (!m) return null;
      return `${m[1]}return null;`;
    },
  },
  {
    name: 'off-by-one',
    apply(line) {
      // Search the MASKED line so a tuning constant is skipped (see
      // TUNING_ASSIGNMENT_RE), then splice into the ORIGINAL at the same index.
      // Masking preserves length, so the index is valid in both. Index-splicing
      // rather than `line.replace(digits, ...)` matters: replace() rewrites the
      // first occurrence of that digit RUN anywhere on the line, which for
      // `{ timeout: 3, limit: 3 }` would mutate the masked timeout instead of
      // the boundary actually selected.
      const m = maskTuningAssignments(line).match(/(?<![\w.])(\d+)(?![\w.])/);
      if (!m) return null;
      const digits = m[1];
      const n = parseInt(digits, 10);
      return line.slice(0, m.index) + String(n + 1) + line.slice(m.index + digits.length);
    },
  },
  {
    name: 'logic-swap',
    apply(line) {
      if (/&&/.test(line)) return line.replace(/&&/, '||');
      if (/\|\|/.test(line)) return line.replace(/\|\|/, '&&');
      return null;
    },
  },
  {
    // Negates one recognized guard sub-clause independently of the rest of
    // the condition on the line: an Array.isArray(...) call, a bare
    // identifier used for truthiness (`if (value)`), or a loose (`==`/`!=`)
    // null check. logic-swap only flips the combinator (&&/||) between
    // sub-clauses; this operator flips a sub-clause itself.
    name: 'negate-guard-subclause',
    apply(line) {
      if (/!Array\.isArray\(/.test(line)) {
        return line.replace(/!Array\.isArray\(/, 'Array.isArray(');
      }
      if (/\bArray\.isArray\(/.test(line)) {
        return line.replace(/\bArray\.isArray\(/, '!Array.isArray(');
      }
      const bareIf = line.match(/\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/);
      if (bareIf) {
        return line.replace(bareIf[0], `if (!${bareIf[1]})`);
      }
      if (LOOSE_EQ_NULL_RE.test(line)) {
        return line.replace(LOOSE_EQ_NULL_RE, '!= null');
      }
      if (LOOSE_NEQ_NULL_RE.test(line)) {
        return line.replace(LOOSE_NEQ_NULL_RE, '== null');
      }
      return null;
    },
  },
  {
    // Drops the last element of a simple array literal — catches a
    // silently-shrinkable list (e.g. a shared-fields constant) that no
    // comparison/boolean/return operator above can reach.
    name: 'array-literal-shrink',
    apply(line) {
      const m = line.match(ARRAY_LITERAL_RE);
      if (!m) return null;
      const items = splitTopLevelCommas(m[1]);
      if (items.length < 2) return null;
      const shrunk = items.slice(0, -1).join(', ');
      return `${line.slice(0, m.index)}[${shrunk}]${line.slice(m.index + m[0].length)}`;
    },
  },
  {
    // Swaps the two branches of a single-line ternary — the classic shape of
    // a recursive array-processing guard (`Array.isArray(x) ? recurse(x) :
    // x`). Fails closed (no match) on nested ternaries/object literals, and
    // on a ternary followed by anything other than optional whitespace/`;`
    // (a trailing comment, or embedding as one element of an array/object/
    // call-argument list) — see parseTernary.
    name: 'ternary-swap',
    apply(line) {
      const parsed = parseTernary(line);
      if (!parsed) return null;
      const { prefix, whenTrue, whenFalse, suffix } = parsed;
      const trueTrim = whenTrue.trim();
      const falseTrim = whenFalse.trim();
      if (!trueTrim || !falseTrim || trueTrim === falseTrim) return null;
      return `${prefix}? ${falseTrim} : ${trueTrim}${suffix}`;
    },
  },
];

const SKIP_LINE = /^\s*($|\/\/|\/\*|\*|#|import\b|export\s+\{|console\.)/;

// A CLOSED `/* … */` prefix followed by real code (#372 defect 4). SKIP_LINE
// skips ANY line starting with `/*`, so `/* x */ const limit = 3;` produced zero
// mutants while `const limit = 3;` produced one — a one-line comment prefix was a
// working, undocumented suppression of the gate, and mutation-gate's own failure
// message told authors no such thing existed.
//
// The prefix is STRIPPED before the operators run and re-attached to the mutant,
// rather than the line simply being un-skipped: every operator but off-by-one
// locates its target with `.replace(first-match)`, so handing them the comment
// text would let `/* if (a < b) */ const limit = 3;` mutate INSIDE the comment —
// an unkillable mutant, i.e. the same false gate failure in a new costume.
//
// An UNCLOSED opener (`/* start of a block comment`) does not match, so a real
// multi-line comment is still skipped by SKIP_LINE.
const CLOSED_COMMENT_PREFIX = /^(\s*(?:\/\*(?:(?!\*\/)[\s\S])*?\*\/\s*)+)(?=\S)/;

/**
 * Generate mutants for a source file.
 * targetLines: optional Set/array of 1-based line numbers to restrict to
 * (e.g. lines changed in a diff). maxMutants caps output.
 * Returns [{ line, operator, original, mutated }].
 */
export function generateMutants(content, { targetLines, maxMutants = 50 } = {}) {
  const lines = content.split('\n');
  const allow = targetLines ? new Set([...targetLines]) : null;
  const mutants = [];
  for (let i = 0; i < lines.length && mutants.length < maxMutants; i++) {
    const lineNo = i + 1;
    if (allow && !allow.has(lineNo)) continue;
    const original = lines[i];
    const prefix = original.match(CLOSED_COMMENT_PREFIX)?.[1] ?? '';
    const body = original.slice(prefix.length);
    if (SKIP_LINE.test(body)) continue;
    for (const op of OPERATORS) {
      const mutatedBody = op.apply(body);
      if (mutatedBody === null || mutatedBody === body) continue;
      // `original` stays the WHOLE line, including the stripped prefix, so
      // applyMutant's identity check still addresses the real file content.
      mutants.push({ line: lineNo, operator: op.name, original, mutated: prefix + mutatedBody });
      if (mutants.length >= maxMutants) break;
    }
  }
  return mutants;
}

/** Apply one mutant to file content; returns the mutated content. */
export function applyMutant(content, mutant) {
  const lines = content.split('\n');
  if (lines[mutant.line - 1] !== mutant.original) {
    throw new Error(
      `mutant line ${mutant.line} no longer matches original content — refusing to apply`
    );
  }
  lines[mutant.line - 1] = mutant.mutated;
  return lines.join('\n');
}

/**
 * Parse a unified diff into { file: Set(added/modified 1-based line numbers) }
 * for the *new* side. Used to diff-scope mutation.
 */
export function changedLinesFromDiff(diffText) {
  const result = {};
  let currentFile = null;
  let newLine = 0;
  for (const line of diffText.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      result[currentFile] = result[currentFile] ?? new Set();
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      result[currentFile].add(newLine);
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // deletion: new-side line number does not advance
    } else if (!line.startsWith('\\')) {
      newLine++;
    }
  }
  return result;
}
