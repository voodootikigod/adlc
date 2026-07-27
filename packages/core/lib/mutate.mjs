// Line-level mutation operators, shared by hollow-test (kill-the-mutant gate)
// and review-calibration (plant-the-bug recall measurement).
// Text-based by design: language-agnostic-enough for JS/TS/Python-style code,
// cheap, and deterministic.

// Loose-equality null checks. Deliberately excludes strict === / !== (which
// invert-comparison already handles) via negative look-around: a run of
// exactly two '=' (or '!' + '=') not adjacent to another '='.
const LOOSE_EQ_NULL_RE = /(?<![=!])==(?!=)\s*null\b/;
const LOOSE_NEQ_NULL_RE = /(?<!!)!=(?!=)\s*null\b/;

// ── Tuning constants are not boundaries (#359) ──────────────────────────────
// off-by-one exists to catch BOUNDARY mistakes — an index, a length, a count.
// A duration in milliseconds or a size in bytes is a tuning knob, and +1 there is
// an EQUIVALENT MUTANT: no test can observe 60000 -> 60001 ms on a subprocess
// timeout, or 512 -> 513 MiB of buffer. Generating it made the gate demand a test
// that cannot exist, and the only way to satisfy that demand was a source-text pin
// assertion — i.e. adding a hollow test to placate the anti-hollow-test gate.
// (Found landing #353, where `timeout: 60000` in rails-guard-ci's git() helper
// survived and there was no honest way to kill it.)
//
// Deliberately EXCLUDES counts — maxRetries, attempts, limit, concurrency, max.
// +1 on a count IS observable: a test can count attempts or returned items. Those
// are the boundary bugs this operator exists to prosecute, and they stay mutable.
//
// KNOWN LIMIT — the value must be a BARE NUMERIC LITERAL directly after the separator.
// Two shapes are therefore still mutated, and both can still produce an unkillable
// mutant (cross-model review round 2 raised these; they are residual, NOT regressions —
// each behaved identically before this operator learned to mask at all):
//   - a bare call argument:  setTimeout(fn, 1000)   sleep(30000)
//   - a COMPUTED value:      timeout: isDev ? 1000 : 60000    timeout = delay || 60000
// Widening to "mask every number between the key and the next terminator" would fix
// those and break something worse: in `timeout: cfg.max > arr.length - 1 ? 100 : 200`
// it swallows `arr.length - 1`, a REAL boundary, silently deleting prosecution of it.
// Precision beats breadth here — extend only when a concrete survivor demands it.
//
// Floats are a non-issue for a different reason: off-by-one's digit-run pattern rejects
// a run adjacent to `.`, so `ttl: 0.0` is unmutatable whether masked or not.
//
// Extend the key list only for a key whose ±1 is genuinely unobservable — every
// addition removes real prosecution, so the bar is "no test could ever tell", not
// "no test currently does".
const TUNING_KEYS = String.raw`timeout|timeout_?ms|delay|delay_?ms|interval|interval_?ms`
  + String.raw`|backoff|backoff_?ms|ttl|ttl_?ms|max_?age|keep_?alive(?:_?msecs)?`
  + String.raw`|max_?buffer|high_?water_?mark|buffer_?size|chunk_?size|max_?bytes`;

// The key, its separator, and its whole NUMERIC VALUE EXPRESSION. The value class
// spans arithmetic so `512 * 1024 * 1024` is covered end to end — matching only
// `512` would leave `1024` exposed and reproduce the same unkillable mutant one
// factor to the right. Letters are excluded from the value class, so a match can
// never run past this key's value into the next key's name.
// The leading `-?` matters: a NEGATIVE duration is a sentinel ("disabled", "wait
// forever"), so -1 -> -2 takes the same branch and is unkillable for exactly the
// reason 60001 was. Without the sign the mask misses it and the bug recurs.
const TUNING_ASSIGNMENT_RE = new RegExp(
  String.raw`\b(?:${TUNING_KEYS})\s*[:=]\s*(-?\d[\d\s*+\-/_.]*)`,
  'gi'
);

// A value of exactly ZERO is never masked. The whole rationale for masking is that
// ±1 is unobservable, and that holds at MAGNITUDE but fails at zero: across every
// key in TUNING_KEYS, 0 means disabled / none / immediate, so 0 -> 1 flips a real
// semantic branch that a test can and should catch. `{ ttl: 0 }` is a discrete
// boundary wearing a tuning key's name — prosecute it. (Cross-model review finding,
// HIGH: masking it let a security-relevant sentinel escape the gate entirely.)
const ZERO_VALUE_RE = /^-?0+$/;

// Blank out tuning assignments, PRESERVING LENGTH so an index into the masked line
// addresses the same character in the original.
function maskTuningAssignments(line) {
  return line.replace(TUNING_ASSIGNMENT_RE, (match, value) => (
    ZERO_VALUE_RE.test(value.trim()) ? match : ' '.repeat(match.length)
  ));
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
    if (SKIP_LINE.test(original)) continue;
    for (const op of OPERATORS) {
      const mutated = op.apply(original);
      if (mutated !== null && mutated !== original) {
        mutants.push({ line: lineNo, operator: op.name, original, mutated });
        if (mutants.length >= maxMutants) break;
      }
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
