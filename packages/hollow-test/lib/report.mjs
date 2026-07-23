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

  // Invalid mutants belong to neither bucket (#293) — showing an unparseable
  // mutation as SURVIVED blames the tests for code that was never valid.
  const invalid = results.filter((r) => r.invalid);
  const undetermined = results.filter((r) => r.undetermined);
  const survivors = results.filter((r) => !r.killed && !r.invalid && !r.undetermined);
  const killed = results.filter((r) => r.killed && !r.invalid && !r.undetermined);

  console.log('');
  console.log('Mutation Results');
  console.log('='.repeat(72));

  for (const r of results) {
    const status = r.undetermined ? 'UNDETERMINED' : r.invalid ? 'INVALID ' : r.killed ? 'KILLED  ' : 'SURVIVED';
    const loc = `${r.file}:${r.line}`;
    console.log(`${status}  ${loc}  [${r.operator}]`);
    if (!r.killed || r.invalid || r.undetermined) {
      console.log(`         original: ${r.original.trim()}`);
      console.log(`         mutated:  ${r.mutated.trim()}`);
    }
    if (r.invalid) {
      console.log('         (did not parse — discarded, not counted as a kill)');
    }
    if (r.undetermined) {
      console.log(`         (not scored — ${r.reason ?? 'validity unknown'})`);
    }
  }

  console.log('');
  const invalidNote = invalid.length > 0 ? `  Invalid: ${invalid.length}` : '';
  const checkNote = undetermined.length > 0 ? `  Undetermined: ${undetermined.length}` : '';
  console.log(`Total: ${results.length}  Killed: ${killed.length}  Survived: ${survivors.length}${invalidNote}${checkNote}`);
  console.log('');
}

/**
 * Build a machine-readable JSON report object.
 *
 * @param {MutantResult[]} results
 * @returns {object}
 */
export function buildJsonReport(results) {
  // Invalid mutants are counted in NEITHER bucket (#293). They never parsed, so
  // "killed" would fake coverage and "survived" would blame the tests for a
  // mutation that was never valid code.
  const invalid = results.filter((r) => r.invalid);
  const undetermined = results.filter((r) => r.undetermined);
  const survivors = results.filter((r) => !r.killed && !r.invalid && !r.undetermined);
  const killed = results.filter((r) => r.killed && !r.invalid && !r.undetermined);

  return {
    tool: 'hollow-test',
    summary: {
      total: results.length,
      killed: killed.length,
      survived: survivors.length,
      invalid: invalid.length,
      undetermined: undetermined.length,
    },
    mutants: results.map((r) => ({
      file: r.file,
      line: r.line,
      operator: r.operator,
      status: r.undetermined ? 'undetermined' : r.invalid ? 'invalid' : r.killed ? 'killed' : 'survived',
      // Why it could not be scored. Without this an undetermined trial is
      // indistinguishable from a tooling bug, and the operator cannot tell a
      // syntax-check failure from a test command that would not launch.
      ...(r.undetermined && r.reason ? { reason: r.reason } : {}),
      timedOut: r.timedOut,
      original: r.original,
      mutated: r.mutated,
    })),
  };
}
