// The host-bound `gh` wrapper (spec §9.1a, §4.1; AC 54, 74, 163) and the
// GitHub read/write helpers every other module calls.
//
// Every gh spawn is host-bound twice over: `--repo <host>/<owner>/<name>` on
// every command that accepts it (never cwd inference), `--hostname <host>` on
// `gh api` / `gh auth status`, and `GH_HOST=<host>` in the env — with no other
// GH_*/GITHUB_* variable but the token gh itself manages. Enumeration is one
// page per call, never `--paginate`, with a 4 MiB stdout cap and a 50-page bound.

import { DEADLINES, withRetry } from './spawn.mjs';
import { validateIssueNumber } from './input.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['github.dropHostBinding', 'github.paginateAll', 'github.ignoreTruncation',
  'github.firstEditsPageOnly',
  'github.retryComments',
  'github.firstPrPageOnly',
]);

export const PER_PAGE = 100;
export const MAX_PAGES = 50;
export const PAGE_CAP_BYTES = 4 * 1024 * 1024;

/** Subcommands that accept `--repo` (§9.1a). */
const REPO_SUBCOMMANDS = new Set(['issue', 'pr', 'repo', 'run', 'label']);

export class GhError extends Error {
  constructor(code, detail, res = null) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.res = res; this.exitCode = 1; }
}

/**
 * @param opts.spawn     the shared spawner
 * @param opts.gh        pinned absolute gh path
 * @param opts.host      the verified host (github.com or a GHES host)
 * @param opts.repo      owner/name
 * @param opts.env       the sanitized base env (PATH/HOME…); GH_HOST is added here
 * @param opts.cwd
 */
export function createGh({ spawn, gh, host, repo, env, cwd, sleep }) {
  const repoSpec = `${host}/${repo}`;
  const baseEnv = () => {
    const out = {};
    for (const [k, v] of Object.entries(env ?? {})) if (!/^(GH_|GITHUB_)/.test(k)) out[k] = v;
    out.GH_HOST = host;
    return out;
  };
  /** Build the argv for a gh command, injecting the host binding. */
  function argvFor(args) {
    const [sub] = args;
    const out = [gh, ...args];
    // Mutation seam `github.dropHostBinding`: gh is spawned with cwd inference only.
    if (active('github.dropHostBinding')) return out;
    if (sub === 'api' || sub === 'auth') {
      if (!args.includes('--hostname')) out.push('--hostname', host);
    } else if (REPO_SUBCOMMANDS.has(sub) && !args.includes('--repo')) {
      out.push('--repo', repoSpec);
    }
    return out;
  }
  async function run(args, { stdoutCap = PAGE_CAP_BYTES, retries = true, stdinBytes } = {}) {
    const attempt = () => spawn({ argv: argvFor(args), cwd, env: baseEnv(), deadlineMs: DEADLINES.gh, stdoutCap, label: `gh ${args[0]} ${args[1] ?? ''}`.trim(), stdinBytes });
    // 3× with backoff; a 4xx other than 429 is not retried (§12.1).
    const retryable = (r) => {
      if (r.status === 0) return false;
      if (/HTTP 4(0[0-9]|1[0-9]|2[0-8])/.test(r.stderr ?? '')) return false;
      return true;
    };
    const res = retries ? await withRetry(attempt, { retryable, sleep }) : await attempt();
    return res;
  }
  async function json(args, opts) {
    const res = await run(args, opts);
    if (res.status !== 0) throw new GhError('gh-failed', `${args.join(' ')} exited ${res.status}: ${String(res.stderr ?? '').trim().slice(0, 300)}`, res);
    if (res.truncated) throw new GhError('gh-truncated', args.join(' '), res);
    try { return JSON.parse(res.stdout); } catch (e) { throw new GhError('gh-bad-json', `${args.join(' ')}: ${e.message}`, res); }
  }
  return { run, json, argvFor, repoSpec, host, repo };
}

/**
 * The candidate set (§4.1, AC 54/74): one page per call, `page=1..`, stop at a
 * short page, never page 51. Any failure → { ok:false, reason:'candidate-set-truncated', pagesReached }.
 */
export async function listOpenIssues(ghc, { perPage = PER_PAGE, maxPages = MAX_PAGES } = {}) {
  const issues = [];
  // Mutation seam `github.paginateAll`: one --paginate call instead of one page per call.
  if (active('github.paginateAll')) {
    const all = await ghc.run(['api', '--paginate', `repos/${ghc.repo}/issues?state=open&per_page=${perPage}`], { stdoutCap: PAGE_CAP_BYTES });
    try { return { ok: true, issues: JSON.parse(all.stdout).filter((el) => !('pull_request' in el)), pagesReached: 1 }; } catch { return { ok: false, reason: 'candidate-set-truncated', pagesReached: 0 }; }
  }
  for (let page = 1; page <= maxPages; page++) {
    const res = await ghc.run(['api', `repos/${ghc.repo}/issues?state=open&per_page=${perPage}&page=${page}`], { stdoutCap: PAGE_CAP_BYTES });
    // Mutation seam `github.ignoreTruncation`: a truncated page is parsed as if complete.
    if (res.status !== 0 || (res.truncated && !active('github.ignoreTruncation'))) return { ok: false, reason: 'candidate-set-truncated', pagesReached: page - 1, detail: res.truncated ? 'page exceeded 4 MiB' : `gh exited ${res.status}` };
    let arr;
    try { arr = JSON.parse(res.stdout); } catch { return { ok: false, reason: 'candidate-set-truncated', pagesReached: page - 1, detail: 'page is not JSON' }; }
    if (!Array.isArray(arr)) return { ok: false, reason: 'candidate-set-truncated', pagesReached: page - 1, detail: 'page is not an array' };
    for (const el of arr) {
      if (el === null || typeof el !== 'object' || !Number.isInteger(el.number)) return { ok: false, reason: 'candidate-set-truncated', pagesReached: page - 1, detail: 'malformed element' };
      if ('pull_request' in el) continue; // the issues API interleaves PRs
      issues.push(el);
    }
    if (arr.length < perPage) return { ok: true, issues, pagesReached: page };
    if (page === maxPages) return { ok: false, reason: 'candidate-set-truncated', pagesReached: page, detail: `${maxPages} full pages` };
  }
  return { ok: false, reason: 'candidate-set-truncated', pagesReached: maxPages, detail: 'unreachable' };
}

/** `gh issue view <n> --json …` with exactly the fields the caller names (title,body — never comments for model input). */
export function viewIssue(ghc, n, fields) {
  return ghc.json(['issue', 'view', String(validateIssueNumber(n)), '--json', fields.join(',')]);
}

/** The issue timeline (label events, renames) — one page per call, bounded. */
export async function issueTimeline(ghc, n, { perPage = PER_PAGE, maxPages = MAX_PAGES } = {}) {
  const events = [];
  for (let page = 1; page <= maxPages; page++) {
    let arr;
    try { arr = await ghc.json(['api', `repos/${ghc.repo}/issues/${validateIssueNumber(n)}/timeline?per_page=${perPage}&page=${page}`]); } catch (e) { return { ok: false, reason: 'timeline-unreadable', detail: e.message }; }
    if (!Array.isArray(arr)) return { ok: false, reason: 'timeline-unreadable', detail: 'not an array' };
    events.push(...arr);
    if (arr.length < perPage) return { ok: true, events };
  }
  return { ok: false, reason: 'timeline-unreadable', detail: 'too many pages' };
}

/**
 * Every open pull request (number, headRefName, body) across EVERY page (bounded), the same
 * fail-closed contract as `listOpenIssues`: a truncated or unreadable listing is
 * `{ ok:false, reason:'open-prs-truncated' }` — selection must not run on a partial exclusion set
 * (codex r5 A4). Seam `github.firstPrPageOnly`: only the first page is read.
 */
export async function listOpenPrs(ghc, { perPage = PER_PAGE, maxPages = MAX_PAGES } = {}) {
  const prs = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await ghc.run(['api', `repos/${ghc.repo}/pulls?state=open&per_page=${perPage}&page=${page}`], { stdoutCap: PAGE_CAP_BYTES });
    if (res.status !== 0 || res.truncated) return { ok: false, reason: 'open-prs-truncated', pagesReached: page - 1, detail: res.truncated ? 'page output truncated' : `gh exited ${res.status}` };
    let arr;
    try { arr = JSON.parse(res.stdout); } catch { return { ok: false, reason: 'open-prs-truncated', pagesReached: page - 1, detail: 'page is not JSON' }; }
    if (!Array.isArray(arr)) return { ok: false, reason: 'open-prs-truncated', pagesReached: page - 1, detail: 'page is not an array' };
    for (const el of arr) {
      if (el === null || typeof el !== 'object' || !Number.isInteger(el.number)) return { ok: false, reason: 'open-prs-truncated', pagesReached: page - 1, detail: 'malformed element' };
      prs.push({ number: el.number, headRefName: el.head?.ref ?? null, body: typeof el.body === 'string' ? el.body : '' });
    }
    if (arr.length < perPage || active('github.firstPrPageOnly')) return { ok: true, prs, pagesReached: page };
    if (page === maxPages) return { ok: false, reason: 'open-prs-truncated', pagesReached: page, detail: `${maxPages} full pages` };
  }
  return { ok: false, reason: 'open-prs-truncated', pagesReached: maxPages, detail: 'unreachable' };
}

/** GraphQL `userContentEdits` for the issue body (editor logins + editedAt). */
export async function issueBodyEdits(ghc, n, { pageSize = PER_PAGE, maxPages = MAX_PAGES } = {}) {
  const [owner, name] = ghc.repo.split('/');
  // EVERY page of the edit history is read (bounded); a history longer than the bound or an
  // unreadable page fails closed — a partial history could hide the untrusted editor (codex r3 A3).
  const query = `query($o:String!,$r:String!,$n:Int!,$first:Int!,$after:String){ repository(owner:$o,name:$r){ issue(number:$n){ lastEditedAt userContentEdits(first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ editedAt editor{ login } } } } } }`;
  const editors = [];
  let after = null; let lastEditedAt = null;
  try {
    for (let page = 1; page <= maxPages; page++) {
      const doc = await ghc.json(['api', 'graphql', '-f', `query=${query}`, '-F', `o=${owner}`, '-F', `r=${name}`, '-F', `n=${validateIssueNumber(n)}`, '-F', `first=${pageSize}`, ...(after ? ['-f', `after=${after}`] : [])]);
      const issue = doc?.data?.repository?.issue;
      if (!issue) return { ok: false, reason: 'edits-unreadable' };
      lastEditedAt = issue.lastEditedAt ?? null;
      const conn = issue.userContentEdits;
      if (!conn || !Array.isArray(conn.nodes)) return { ok: false, reason: 'edits-unreadable', detail: 'userContentEdits is not a connection' };
      editors.push(...conn.nodes.map((e) => ({ login: e?.editor?.login ?? null, editedAt: e?.editedAt ?? null })));
      // Mutation seam `github.firstEditsPageOnly`: later pages are never read (the truncated-history defect).
      if (!conn.pageInfo?.hasNextPage || active('github.firstEditsPageOnly')) return { ok: true, lastEditedAt, editors };
      if (page === maxPages) return { ok: false, reason: 'edits-truncated', detail: `more than ${maxPages} pages of edits` };
      after = conn.pageInfo.endCursor;
      if (typeof after !== 'string' || after.length === 0) return { ok: false, reason: 'edits-unreadable', detail: 'hasNextPage without an endCursor' };
    }
  } catch (e) { return { ok: false, reason: 'edits-unreadable', detail: e.message }; }
  return { ok: false, reason: 'edits-truncated' };
}

/** Repository permission of a login: admin | maintain | write | triage | read | null. */
export async function permissionOf(ghc, login) {
  try { const r = await ghc.json(['api', `repos/${ghc.repo}/collaborators/${encodeURIComponent(login)}/permission`]); return typeof r?.permission === 'string' ? r.permission : null; }
  catch { return null; }
}
export const isMaintainer = (perm) => perm === 'admin' || perm === 'maintain';

/** A mutating gh command prints a URL, not JSON: check the exit status only. */
async function mutate(ghc, args, opts) {
  const res = await ghc.run(args, opts);
  if (res.status !== 0) throw new GhError('gh-failed', `${args.join(' ')} exited ${res.status}: ${String(res.stderr ?? '').trim().slice(0, 300)}`, res);
  return res;
}

/** Idempotent label add / remove (read first, mutate only when needed). */
export async function ensureLabel(ghc, n, label, { present }) {
  const cur = await viewIssue(ghc, n, ['labels']);
  const has = (cur.labels ?? []).some((l) => l.name === label);
  if (present && !has) { await mutate(ghc, ['issue', 'edit', String(n), '--add-label', label]); return { mutated: true }; }
  if (!present && has) { await mutate(ghc, ['issue', 'edit', String(n), '--remove-label', label]); return { mutated: true }; }
  return { mutated: false };
}

/** Post a comment only if no comment carries `sentinel` (searched via the API, never the record). */
export async function ensureComment(ghc, n, sentinel, body, { perPage = PER_PAGE, maxPages = MAX_PAGES } = {}) {
  // The sentinel search covers EVERY page (bounded); an unreadable page fails closed —
  // a duplicate terminal comment is worse than a retried one.
  for (let page = 1; page <= maxPages; page++) {
    const comments = await ghc.json(['api', `repos/${ghc.repo}/issues/${validateIssueNumber(n)}/comments?per_page=${perPage}&page=${page}`]);
    if (!Array.isArray(comments)) throw new GhError('gh-bad-json', 'comments page is not an array');
    if (comments.some((c) => typeof c?.body === 'string' && c.body.includes(sentinel))) return { posted: false };
    // Mutation seam `github.paginateAll`: only the first page is searched (the duplicate-comment defect).
    if (comments.length < perPage || active('github.paginateAll')) break;
    // Mutation seam `github.ignoreTruncation`: an exhausted page budget is treated as "not found".
    if (page === maxPages && !active('github.ignoreTruncation')) throw new GhError('gh-truncated', `comment search exceeded ${maxPages} pages`);
  }
  // The POST itself is NOT retried (codex r5 A3): a failure after the comment landed would post it
  // twice; the next iteration's sentinel search is the idempotent retry. Seam `github.retryComments`.
  await mutate(ghc, ['issue', 'comment', String(n), '--body-file', '-'], { stdinBytes: `${sentinel}\n${body}`, retries: active('github.retryComments') });
  return { posted: true };
}
