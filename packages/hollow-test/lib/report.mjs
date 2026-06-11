// hollow-test/lib/report.mjs
// Formats mutation results for human-readable and JSON output.

/**
 * @typedef {Object} MutantResult
 * @property {string} file
 * @property {number} line
 * @property {string} operator
 * @property {boolean} killed
 * @property {boolean} timedOut
 * @property {string} original  - The original line text
 * @property {string} mutated   - The mutated line text
 */

/**
 * Print a human-readable mutation table to stdout.
 * Survivors are highlighted; summary is printed at the end.
 *
 * @param {MutantResult[]} results
 */
export function printTable(results) {
  if (results.length === 0) return;

  const survivors = results.filter((r) => !r.killed);
  const killed = results.filter((r) => r.killed);

  console.log('');
  console.log('Mutation Results');
  console.log('='.repeat(72));

  for (const r of results) {
    const status = r.killed ? 'KILLED  ' : 'SURVIVED';
    const loc = `${r.file}:${r.line}`;
    console.log(`${status}  ${loc}  [${r.operator}]`);
    if (!r.killed) {
      console.log(`         original: ${r.original.trim()}`);
      console.log(`         mutated:  ${r.mutated.trim()}`);
    }
  }

  console.log('');
  console.log(`Total: ${results.length}  Killed: ${killed.length}  Survived: ${survivors.length}`);
  console.log('');
}

/**
 * Build a machine-readable JSON report object.
 *
 * @param {MutantResult[]} results
 * @returns {object}
 */
export function buildJsonReport(results) {
  const survivors = results.filter((r) => !r.killed);
  const killed = results.filter((r) => r.killed);

  return {
    tool: 'hollow-test',
    summary: {
      total: results.length,
      killed: killed.length,
      survived: survivors.length,
    },
    mutants: results.map((r) => ({
      file: r.file,
      line: r.line,
      operator: r.operator,
      status: r.killed ? 'killed' : 'survived',
      timedOut: r.timedOut,
      original: r.original,
      mutated: r.mutated,
    })),
  };
}
