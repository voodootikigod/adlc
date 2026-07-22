// hollow-test/lib/runner.mjs
// Runs a single mutant: writes mutated content, executes test command, restores file.
// Returns { killed: boolean, timedOut: boolean, exitCode: number | null }

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Strip NODE_TEST_CONTEXT from the child environment so that a test command
// using `node --test` does not hit Node.js v22's recursive-invocation guard
// (which causes it to skip all test files and exit 0, making every mutant
// look like it survived).
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Run the test command once against whatever is currently on disk. Does NOT
 * mutate or restore any file — the caller controls file state. Used both for
 * the green-baseline check (unmutated code) and inside runMutant (mutated
 * code), so baseline and mutant runs are byte-for-byte identical in their
 * spawn settings (shell, env, timeout, cwd).
 *
 * @param {string} testCmd   - Shell command to run the test suite.
 * @param {number} timeoutMs - Maximum time in ms to wait for the test command.
 * @param {string} cwd       - Working directory for the test command.
 * @returns {{ status: number | null, timedOut: boolean }}
 */
export function runTest(testCmd, timeoutMs, cwd) {
  const result = spawnSync(testCmd, {
    shell: true,
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: 'pipe',
    env: childEnv(),
  });

  const timedOut = result.signal === 'SIGTERM' || result.status === null;

  return { status: result.status, timedOut };
}

/**
 * Run one mutant trial. Writes mutated content to disk, runs test command,
 * always restores original content (finally-like pattern using try/finally).
 *
 * @param {string} filePath  - Absolute path to the file to mutate.
 * @param {string} original  - The file's original content (used for restore).
 * @param {string} mutated   - The mutated content to test.
 * @param {string} testCmd   - Shell command to run the test suite.
 * @param {number} timeoutMs - Maximum time in ms to wait for the test command.
 * @param {string} cwd       - Working directory for the test command.
 * @returns {{ killed: boolean, timedOut: boolean, exitCode: number | null }}
 */
export function runMutant(filePath, original, mutated, testCmd, timeoutMs, cwd) {
  let trial;
  // No initialiser: it is assigned unconditionally below, so a literal here is
  // dead weight the mutation gate would flag forever.
  let invalid;
  let syntax;
  try {
    writeFileSync(filePath, mutated, 'utf8');
    // SYNTAX GATE, before the test command (#293).
    //
    // `killed` is inferred from a non-zero exit, and a file that does not PARSE
    // also exits non-zero — so without this check an unparseable mutant is
    // credited as a kill while nothing was tested. Line-based operators produce
    // these routinely: `null-return` rewrites a multiline `return {` to
    // `return null;` and strands the object literal's remaining lines. At a
    // per-file quota of one, that single invalid mutant can be the only trial,
    // and the gate reports success having exercised no assertion at all.
    //
    // `node --check` rather than a parser dependency: @adlc/hollow-test is
    // published, and this asks exactly the right question — would Node accept
    // this file — honouring the real extension and package type instead of
    // approximating them.
    syntax = checkSyntax(filePath, cwd);
    invalid = syntax === 'invalid';
    if (syntax === 'valid') trial = runTest(testCmd, timeoutMs, cwd);
  } finally {
    // Always restore original content, even if the test run threw.
    writeFileSync(filePath, original, 'utf8');
  }

  // An invalid mutant is DISCARDED — neither killed nor survived. Counting it
  // either way is wrong: as a kill it fakes coverage, as a survivor it blames
  // the tests for a mutation that was never valid code.
  // Could not determine validity — refuse to score it either way. The caller
  // turns this into an operational failure; guessing is what reopens #293.
  if (syntax === 'unknown') {
    return { killed: false, invalid: false, checkFailed: true, timedOut: false, exitCode: null };
  }

  if (invalid) {
    return { killed: false, invalid: true, checkFailed: false, timedOut: false, exitCode: null };
  }

  const killed = trial.timedOut || (trial.status !== 0);

  return {
    killed,
    invalid: false,
    checkFailed: false,
    timedOut: trial.timedOut,
    exitCode: trial.status,
  };
}

/**
 * TRI-STATE syntax check: 'valid' | 'invalid' | 'unknown'.
 *
 * "Could not determine" must never collapse into "valid". If the checker is
 * killed, times out, or cannot spawn, assuming validity reopens the exact
 * false-kill path this exists to close: the test command then runs against
 * unparseable source, exits non-zero on the parse error, and that is scored as a
 * kill. Transient process exhaustion would become coverage evidence.
 *
 * Exported so the three outcomes can be tested directly, including the one that
 * needs an injected failure.
 *
 * @param {string} filePath absolute path to the (currently mutated) file
 * @param {string} cwd
 * @param {string} [execPath] node binary to check with; overridable for tests
 * @returns {'valid'|'invalid'|'unknown'}
 */
export function checkSyntax(filePath, cwd, execPath = process.execPath) {
  const r = spawnSync(execPath, ['--check', filePath], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.error || r.signal || typeof r.status !== 'number') return 'unknown';
  return r.status === 0 ? 'valid' : 'invalid';
}
