// preflight/lib/runner.mjs — orchestrate all checks given parsed flags.

import {
  checkBash,
  checkGit,
  checkWrite,
  checkBranch,
  checkWorktrees,
  checkTestCmd,
  checkGh,
  checkLlm,
} from './checks.mjs';

/**
 * The one message both boundaries (CLI and API) emit for a --test-cmd that was
 * PASSED but carries no command. Shared so the bin's pre-check and the
 * runChecks guard cannot drift apart.
 */
export const EMPTY_TEST_CMD_MESSAGE =
  '--test-cmd requires a non-empty command (received an empty value); pass a command or omit the flag';

/**
 * True when a --test-cmd value was PRESENT but is not a usable command.
 *
 * `undefined` means the flag was never passed — nothing was requested, so
 * nothing is blank. Anything else must be a string with non-whitespace
 * content. This is deliberately NOT plain truthiness: `--test-cmd ""` (what
 * `--test-cmd "$TEST_CMD"` produces in CI with an unset variable) is falsy,
 * and treating it as "absent" is exactly the fail-open the gate exists to
 * prevent (#712) — the user asked for a check, it silently never ran, and the
 * verdict said PASS.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBlankTestCmd(value) {
  if (value === undefined) return false;
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Run all applicable checks based on flags.
 *
 * @param {object} opts
 * @param {string}  opts.cwd         - working directory (default process.cwd())
 * @param {boolean} opts.worktrees   - run worktrees check
 * @param {string}  opts.testCmd     - run test-cmd check with this command
 * @param {boolean} opts.gh          - run gh check
 * @param {boolean} opts.llm         - run llm check
 * @param {object}  opts.env         - environment override (for tests)
 * @returns {Promise<Array<{name, status, detail, required}>>}
 * @throws {Error} when testCmd is present but blank — an explicitly requested
 *   check that cannot run is an operational error, never a silent skip.
 */
export async function runChecks(opts = {}) {
  // Fail closed BEFORE any check runs (and before any side effect is created):
  // a caller that requested the test-cmd check with nothing to run gets an
  // error, not a 4-row pass that looks identical to "never requested".
  if (isBlankTestCmd(opts.testCmd)) {
    throw new Error(EMPTY_TEST_CMD_MESSAGE);
  }

  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const results = [];

  // ── REQUIRED checks ─────────────────────────────────────────────────────────
  // Run sequentially so failures in one don't mask others, and cleanup is safe.

  const bash = await checkBash();
  results.push({ ...bash, required: true });

  const gitCheck = await checkGit(cwd);
  results.push({ ...gitCheck, required: true });

  const writeCheck = await checkWrite(cwd);
  results.push({ ...writeCheck, required: true });

  const branchCheck = await checkBranch(cwd);
  results.push({ ...branchCheck, required: true });

  // ── OPTIONAL checks ──────────────────────────────────────────────────────────

  if (opts.worktrees) {
    const wt = await checkWorktrees(cwd);
    results.push({ ...wt, required: true }); // required because explicitly requested
  }

  // Presence, not truthiness: a blank value was already rejected above, so any
  // defined value here is a real command that the caller explicitly asked to run.
  if (opts.testCmd !== undefined) {
    const tc = await checkTestCmd(opts.testCmd, cwd);
    results.push({ ...tc, required: true }); // required because explicitly requested
  }

  if (opts.gh) {
    const gh = await checkGh();
    results.push({ ...gh, required: true }); // required because explicitly requested
  }

  if (opts.llm) {
    const llm = await checkLlm(env);
    results.push({ ...llm, required: true }); // required because explicitly requested
  }

  return results;
}
