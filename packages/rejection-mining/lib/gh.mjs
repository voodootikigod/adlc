// gh.mjs — GitHub CLI boundary.
// All gh calls are isolated here so tests can inject a mock.
// Pure I/O boundary — no logic.

import { execFileSync } from 'node:child_process';

const GH_MAX_BUFFER = 64 * 1024 * 1024;
const GH_TIMEOUT_MS = 60_000;

function withPinnedRepo(args, repo) {
  if (!repo || args[0] !== 'pr') return args;
  if (args.includes('--repo') || args.includes('-R')) return args;
  return [...args, '--repo', repo];
}

/**
 * Default gh runner: calls gh CLI via execFileSync.
 * Pins `--repo <repo>` on `gh pr` commands when `repo` (or `GH_REPO`) is set.
 * @param {string[]} args
 * @param {typeof execFileSync} [execFn]
 * @param {{ repo?: string }} [opts]
 * @returns {string} raw stdout
 */
export function runGh(args, execFn = execFileSync, { repo = process.env.GH_REPO } = {}) {
  return execFn('gh', withPinnedRepo(args, repo), {
    encoding: 'utf8',
    maxBuffer: GH_MAX_BUFFER,
    timeout: GH_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
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
export function fetchPRList(limit, ghRunner = runGh, { repo } = {}) {
  const args = [
    'pr', 'list',
    '--state', 'all',
    '--limit', String(limit),
    '--json', 'number,title',
  ];
  const raw = ghRunner(repo ? [...args, '--repo', repo] : args);
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
 * @param {{ repo?: string }} [opts]
 * @returns {{ reviews: Array, comments: Array }}
 */
export function fetchPRDetail(prNumber, ghRunner = runGh, { repo } = {}) {
  const args = [
    'pr', 'view', String(prNumber),
    '--json', 'reviews,comments',
  ];
  const raw = ghRunner(repo ? [...args, '--repo', repo] : args);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw Object.assign(
      new Error(`Failed to parse PR detail for PR #${prNumber}: ${err.message}`),
      { code: 'GH_PARSE_ERROR' }
    );
  }
}
