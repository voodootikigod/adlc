// Line-level mutation operators, shared by hollow-test (kill-the-mutant gate)
// and review-calibration (plant-the-bug recall measurement).
// Text-based by design: language-agnostic-enough for JS/TS/Python-style code,
// cheap, and deterministic.

// Loose-equality null checks. Deliberately excludes strict === / !== (which
// invert-comparison already handles) via negative look-around: a run of
// exactly two '=' (or '!' + '=') not adjacent to another '='.
const LOOSE_EQ_NULL_RE = /(?<![=!])==(?!=)\s*null\b/;
const LOOSE_NEQ_NULL_RE = /(?<!!)!=(?!=)\s*null\b/;

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
      const m = line.match(/(?<![\w.])(\d+)(?![\w.])/);
      if (!m) return null;
      const n = parseInt(m[1], 10);
      return line.replace(m[1], String(n + 1));
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
