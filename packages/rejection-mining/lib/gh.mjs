// gh.mjs — GitHub CLI boundary.
// All gh calls are isolated here so tests can inject a mock.
// Pure I/O boundary — no logic.

import { execFileSync } from 'node:child_process';

/**
 * Default gh runner: calls gh CLI via execFileSync.
 * Returns parsed JSON output.
 * @param {string[]} args
 * @returns {string} raw stdout
 */
export function runGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

/**
 * Verify gh is installed and authenticated.
 * Throws if gh is missing or auth fails.
 * @param {function} ghRunner - injectable gh runner
 */
export function checkGhAvailable(ghRunner = runGh) {
  try {
    ghRunner(['--version']);
  } catch (err) {
    const isNotFound =
      err.code === 'ENOENT' ||
      (err.message && err.message.includes('ENOENT'));
    if (isNotFound) {
      throw Object.assign(
        new Error(
          'gh CLI not found. Install from https://cli.github.com/ and run `gh auth login`.'
        ),
        { code: 'GH_NOT_FOUND' }
      );
    }
    throw Object.assign(
      new Error(`gh --version failed: ${err.message}`),
      { code: 'GH_ERROR' }
    );
  }
}

/**
 * Fetch list of PRs.
 * @param {number} limit
 * @param {function} ghRunner
 * @returns {Array<{number: number, title: string}>}
 */
export function fetchPRList(limit, ghRunner = runGh) {
  const raw = ghRunner([
    'pr', 'list',
    '--state', 'all',
    '--limit', String(limit),
    '--json', 'number,title',
  ]);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw Object.assign(
      new Error(`Failed to parse PR list: ${err.message}`),
      { code: 'GH_PARSE_ERROR' }
    );
  }
}

/**
 * Fetch reviews and comments for a single PR.
 * @param {number} prNumber
 * @param {function} ghRunner
 * @returns {{ reviews: Array, comments: Array }}
 */
export function fetchPRDetail(prNumber, ghRunner = runGh) {
  const raw = ghRunner([
    'pr', 'view', String(prNumber),
    '--json', 'reviews,comments',
  ]);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw Object.assign(
      new Error(`Failed to parse PR detail for PR #${prNumber}: ${err.message}`),
      { code: 'GH_PARSE_ERROR' }
    );
  }
}
