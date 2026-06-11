// Line-level mutation operators, shared by hollow-test (kill-the-mutant gate)
// and review-calibration (plant-the-bug recall measurement).
// Text-based by design: language-agnostic-enough for JS/TS/Python-style code,
// cheap, and deterministic.

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
