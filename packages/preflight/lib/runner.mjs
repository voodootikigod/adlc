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
 */
export async function runChecks(opts = {}) {
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

  if (opts.testCmd) {
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
