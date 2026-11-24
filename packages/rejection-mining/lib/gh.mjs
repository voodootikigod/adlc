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

const GRAPHQL_MAX_PAGE = 100;

const PR_SIGNALS_GRAPHQL_QUERY = `
query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $after, states: [OPEN, CLOSED, MERGED], orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number
        title
        reviews(first: 100) {
          nodes {
            body
            author { login }
          }
          pageInfo { hasNextPage }
        }
        comments(first: 100) {
          nodes {
            body
            author { login }
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`.trim();

function graphqlRepoArgs(repo) {
  if (typeof repo === 'string' && repo.includes('/')) {
    const parts = repo.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return ['-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`];
    }
  }
  return ['-F', 'owner={owner}', '-F', 'name={repo}'];
}

/**
 * Fetch up to `limit` PRs with their reviews and comments via paginated
 * `gh api graphql` calls (1 call for <=100 PRs instead of 1 + N `gh pr view` spawns).
 *
 * @param {number} limit
 * @param {function} [ghRunner]
 * @param {{ repo?: string }} [opts]
 * @returns {Array<{ number: number, title: string, reviews: Array, comments: Array }>}
 */
export function fetchPRsGraphQL(limit, ghRunner = runGh, { repo = process.env.GH_REPO } = {}) {
  const maxItems = Math.max(0, Number(limit) || 0);
  if (maxItems === 0) return [];

  const prs = [];
  let cursor = null;
  const repoArgs = graphqlRepoArgs(repo);

  while (prs.length < maxItems) {
    const first = Math.min(GRAPHQL_MAX_PAGE, maxItems - prs.length);
    const args = [
      'api', 'graphql',
      ...repoArgs,
      '-F', `first=${first}`,
      ...(cursor ? ['-f', `after=${cursor}`] : []),
      '-f', `query=${PR_SIGNALS_GRAPHQL_QUERY}`,
    ];
    const raw = ghRunner(args);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw Object.assign(
        new Error(`Failed to parse GraphQL PR response: ${err.message}`),
        { code: 'GH_PARSE_ERROR' }
      );
    }
    if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
      const msg = parsed.errors.map((e) => e?.message || String(e)).join('; ');
      throw Object.assign(new Error(`GraphQL error: ${msg}`), { code: 'GH_GRAPHQL_ERROR' });
    }
    const conn = parsed?.data?.repository?.pullRequests;
    if (!conn || !Array.isArray(conn.nodes)) {
      throw Object.assign(
        new Error('Unexpected GraphQL pullRequests response shape'),
        { code: 'GH_PARSE_ERROR' }
      );
    }
    for (const node of conn.nodes) {
      if (!node || typeof node.number !== 'number') continue;
      const truncated = Boolean(node.reviews?.pageInfo?.hasNextPage || node.comments?.pageInfo?.hasNextPage);
      prs.push({
        number: node.number,
        title: node.title ?? '',
        reviews: Array.isArray(node.reviews?.nodes) ? node.reviews.nodes : [],
        comments: Array.isArray(node.comments?.nodes) ? node.comments.nodes : [],
        truncated,
      });
      if (prs.length >= maxItems) break;
    }
    const pageInfo = conn.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor || conn.nodes.length === 0) {
      break;
    }
    cursor = pageInfo.endCursor;
  }

  return prs;
}
