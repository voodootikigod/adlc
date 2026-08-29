// Verify → push → verify, and the head-bound PR upsert (spec §6.8; AC 6, 36,
// 57, 110, 144).
//
// The push runs from the NETWORK repository (`git --git-dir=<NET_GIT>`, no
// local branch refs) with an explicit OID refspec: the source is the immutable
// attested OID — never a branch name that could move — under a lease that
// expects the remote ref to be exactly what the autopilot last pushed (or
// absent). A lease failure is `oid-mismatch` and is never retried. After the
// push the remote ref must read back as `attestedHead`; only then is the PR
// upserted, and the upsert is itself bound on both sides.

import { branchFor, validateIssueNumber, validateOid } from './input.mjs';
import { headOf, isClean } from './review.mjs';
import { WITHHELD_BODY } from './redact.mjs';
import { DEADLINES } from './spawn.mjs';
import { childEnv } from './keys.mjs';
import { join } from 'node:path';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'push.skipLease',                // the push carries no --force-with-lease
  'push.skipHeadCheck',            // HEAD == attestedHead / clean are not asserted before the push
  'push.skipPostPushVerify',       // the post-push ls-remote read-back is skipped
  'push.upsertWithoutHeadBinding', // the upsert's before/after head checks are skipped
  'push.alwaysCreate',             // the upsert never edits an existing PR
  'push.useOriginName',            // the push names `origin` instead of the pinned URL
  'push.sourceIsBranchName',       // the push source is refs/heads/<b> instead of the attested OID
  'push.skipRemoteUrlCheck',       // the observed remote.origin.url is not re-checked before the push,
  'push.quarantineAnyFailure',
]);

export class PushError extends Error {
  constructor(code, detail, extra = {}) { super(detail ? `${code}: ${detail}` : code); this.name = 'PushError'; this.code = code; this.exitCode = 2; Object.assign(this, extra); }
}

/** `--force-with-lease=refs/heads/<b>:<expected>` — the empty-ref form expects the ref to be absent. */
export function leaseFor(branch, expectedRemoteOid) {
  if (active('push.skipLease')) return null;
  return `--force-with-lease=refs/heads/${branch}:${expectedRemoteOid ? validateOid(expectedRemoteOid, { field: 'expectedRemoteOid' }) : ''}`;
}

/** First column of `ls-remote <url> refs/heads/<branch>` through NET_GIT, or null when absent. */
/** Transport failures git reports for a push that never reached the ref-update: retryable, never a lease verdict. */
export const TRANSIENT_PUSH_RE = /Could not resolve host|Connection timed out|Connection refused|Network is unreachable|unable to access|ssh: connect to host|kex_exchange_identification|Connection reset|early EOF|RPC failed|The remote end hung up unexpectedly|Temporary failure in name resolution/i;

export async function remoteHead(ctx, url, branch) {
  const r = await ctx.git.net(['ls-remote', url, `refs/heads/${branch}`]);
  if (r.status !== 0) throw new PushError('ls-remote-failed', r.stderr.trim().slice(0, 300) || `exit ${r.status}`, { exitCode: 1 });
  const first = r.stdout.split('\n').find((l) => l.trim());
  if (!first) return null;
  return validateOid(first.split(/\s+/)[0], { field: 'remote-oid' });
}

/** The raw push (§6.8 / §9.1c). Never retried. Returns { ok, argv, result }. */
export async function pushAttested({ ctx, issue, attestedHead, expectedRemoteOid = null }) {
  const branch = branchFor(issue);
  const oid = validateOid(attestedHead, { field: 'attestedHead' });
  const url = active('push.useOriginName') ? 'origin' : ctx.remote.remotePushUrl;
  const source = active('push.sourceIsBranchName') ? `refs/heads/${branch}` : oid;
  const lease = leaseFor(branch, expectedRemoteOid);
  const argv = ['push', ...(lease ? [lease] : []), url, `${source}:refs/heads/${branch}`];
  const result = await ctx.git.net(argv, { retry: false });
  return { ok: result.status === 0, argv, result };
}

/** The remote.origin.url observed at preflight must still be observed now (AC 110). */
export async function remoteUrlUnchanged(ctx) {
  if (active('push.skipRemoteUrlCheck')) return true;
  // Phase A records the raw observed URL under remote.observed.fetch (git-runner's field); the flat alias is kept for callers that set it.
  const expected = ctx.remote?.observed?.fetch ?? ctx.remote?.observedFetchUrl;
  if (expected == null || typeof ctx.git.observe !== 'function') return true;
  const observed = await ctx.git.observe('remote.origin.url');
  return observed === expected;
}

const iso = (ctx) => new Date(ctx.now()).toISOString();

/**
 * §6.8 verify-push-verify. The actual-diff check is the CALLER's (it needs the
 * ticket scope); everything else is asserted here. On success the record's
 * `lastPushedOid` + `lastPushedAt` land in ONE write with the state change.
 */
export async function verifyPushVerify({ ctx, issue, record, attestedHead }) {
  const n = validateIssueNumber(issue);
  const oid = validateOid(attestedHead, { field: 'attestedHead' });
  const wt = ctx.paths.issueWorktree(n);
  const branch = branchFor(n);
  const quarantine = (code, detail, extra = {}) => {
    ctx.records.update(n, { state: code === 'remote-url-changed' ? 'orphan' : 'oid-mismatch', lastError: `${code}: ${detail}` });
    return { ok: false, code, state: code === 'remote-url-changed' ? 'orphan' : 'oid-mismatch', detail, comment: `${code}: ${detail}`, ...extra };
  };
  if (!(await remoteUrlUnchanged(ctx))) return quarantine('remote-url-changed', 'remote.origin.url differs from the value observed at preflight');
  if (!active('push.skipHeadCheck')) {
    const head = await headOf(ctx, wt);
    if (head !== oid) return quarantine('oid-mismatch', `HEAD ${head} != attestedHead ${oid}`, { expected: oid, observed: head });
    if (!(await isClean(ctx, wt))) return quarantine('oid-mismatch', 'issue worktree not clean before the push');
  }
  const expectedRemoteOid = record?.lastPushedOid ?? null;
  // State BEFORE the world-effect: the intent names the OID and the lease.
  ctx.records.update(n, { state: 'attested', attestedHead: oid, pushIntent: { oid, expectedRemoteOid, at: iso(ctx) } });
  const push = await pushAttested({ ctx, issue: n, attestedHead: oid, expectedRemoteOid });
  if (!push.ok) {
    // A known-transient transport failure (name resolution, connection, ssh handshake) is a failed
    // round that recovery retries from the recorded push intent; anything else — a lease rejection
    // or an unknown refusal — is the quarantine (codex r8 B3). Seam `push.quarantineAnyFailure`.
    const err = String(push.result.stderr ?? '');
    if (!active('push.quarantineAnyFailure') && TRANSIENT_PUSH_RE.test(err)) {
      ctx.records.update(n, { lastError: `push-failed: ${err.trim().slice(0, 200)}` });
      return { ok: false, code: 'push-failed', state: 'attested', transient: true, detail: `push failed (transient): ${err.trim().slice(0, 300)}`, argv: push.argv };
    }
    return quarantine('oid-mismatch', `push refused (lease ${expectedRemoteOid ?? 'absent'}): ${push.result.stderr.trim().slice(0, 300)}`, { leaseFailed: true, expected: expectedRemoteOid, argv: push.argv });
  }
  if (!active('push.skipPostPushVerify')) {
    const observed = await remoteHead(ctx, ctx.remote.remotePushUrl, branch);
    if (observed !== oid) return quarantine('oid-mismatch', `post-push ls-remote ${observed ?? 'absent'} != ${oid}`, { expected: oid, observed, argv: push.argv });
  }
  ctx.records.update(n, { state: 'pushed', lastPushedOid: oid, lastPushedAt: iso(ctx), attestedHead: oid, localHead: oid, pushIntent: null });
  return { ok: true, pushedOid: oid, argv: push.argv, branch };
}

const PR_NUMBER_RE = /\/pull\/(\d+)\b/;

/** Head-bound PR upsert keyed by head branch (never a body sentinel). */
export async function upsertPr({ ctx, issue, record, attestedHead, title, body }) {
  const n = validateIssueNumber(issue);
  const oid = validateOid(attestedHead, { field: 'attestedHead' });
  const branch = branchFor(n);
  const quarantine = (detail, extra = {}) => {
    ctx.records.update(n, { state: 'oid-mismatch', lastError: `oid-mismatch: ${detail}`, ...(extra.prNumber ? { prNumber: extra.prNumber } : {}) });
    return { ok: false, code: 'oid-mismatch', state: 'oid-mismatch', detail, comment: `oid-mismatch: ${detail}`, ...extra };
  };
  if (!active('push.upsertWithoutHeadBinding')) {
    const observed = await remoteHead(ctx, ctx.remote.remotePushUrl, branch);
    if (observed !== oid) return quarantine(`remote ref ${observed ?? 'absent'} != attestedHead ${oid} immediately before the PR upsert`, { expected: oid, observed });
  }
  const open = await ctx.gh.json(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number']);
  const existing = active('push.alwaysCreate') ? null : (Array.isArray(open) && open.length ? open.map((p) => p.number).sort((a, b) => a - b)[0] : null);
  const red = ctx.redactor.redact(String(body ?? ''), { withheld: WITHHELD_BODY });
  const stdinBytes = red.text;
  let prNumber;
  if (existing != null) {
    const r = await ctx.gh.run(['pr', 'edit', String(existing), '--body-file', '-'], { stdinBytes });
    if (r.status !== 0) throw new PushError('pr-upsert-failed', `gh pr edit exited ${r.status}: ${r.stderr.trim().slice(0, 300)}`, { exitCode: 1 });
    prNumber = existing;
  } else {
    // The title is outward too (it comes from the shaped ticket): redacted, withheld on failure.
    const safeTitle = ctx.redactor.redact(String(title), { withheld: `autopilot: issue #${n}` }).text;
    const r = await ctx.gh.run(['pr', 'create', '--base', 'main', '--head', branch, '--title', safeTitle, '--body-file', '-'], { stdinBytes, retries: false });
    if (r.status !== 0) throw new PushError('pr-upsert-failed', `gh pr create exited ${r.status}: ${r.stderr.trim().slice(0, 300)}`, { exitCode: 1 });
    const m = PR_NUMBER_RE.exec(r.stdout) ?? PR_NUMBER_RE.exec(r.stderr);
    if (m) prNumber = Number(m[1]);
    else {
      const again = await ctx.gh.json(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number']);
      prNumber = Array.isArray(again) && again.length ? again[0].number : null;
    }
    if (!Number.isInteger(prNumber)) throw new PushError('pr-upsert-failed', 'created PR number unknown', { exitCode: 1 });
  }
  if (!active('push.upsertWithoutHeadBinding')) {
    const view = await ctx.gh.json(['pr', 'view', String(prNumber), '--json', 'headRefOid']);
    if (view?.headRefOid !== oid) return quarantine(`PR #${prNumber} head ${view?.headRefOid ?? 'unknown'} != attestedHead ${oid} after the upsert`, { prNumber, expected: oid, observed: view?.headRefOid ?? null });
  }
  ctx.records.update(n, { state: 'pr-open', prNumber, prState: 'OPEN', ciReEvaluations: 0 });
  return { ok: true, prNumber, created: existing == null, bodyWithheld: !red.ok };
}

/** The §6.8 sequence as one step: push, then upsert only after the post-push verification. */
export async function pushAndUpsert({ ctx, issue, record, attestedHead, title, body }) {
  const push = await verifyPushVerify({ ctx, issue, record, attestedHead });
  if (!push.ok) return { ...push, upserted: false };
  const upsert = await upsertPr({ ctx, issue, record: ctx.records.load(validateIssueNumber(issue)), attestedHead, title, body });
  return { ...upsert, push };
}

// ---- PR title/body ----
const TYPE_FOR_CATEGORY = Object.freeze({ feature: 'feat', bug: 'fix', bugfix: 'fix', refactor: 'refactor', docs: 'docs', chore: 'chore', test: 'test', spec: 'docs', contract: 'feat', architecture: 'refactor' });

export function prTitle({ issue, ticket }) {
  const n = validateIssueNumber(issue);
  const type = TYPE_FOR_CATEGORY[ticket?.category] ?? 'feat';
  const scope0 = Array.isArray(ticket?.scope) ? ticket.scope[0] ?? '' : '';
  const segs = String(scope0).split('/').filter((s) => s && !s.includes('*'));
  const area = (segs[0] === 'packages' || segs[0] === 'plugins') && segs[1] ? segs[1] : segs[0] || 'repo';
  const title = String(ticket?.title ?? `issue ${n}`).replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${type}(${area}): ${title} (#${n})`;
}

/** `adlc gate-manifest attest --ticket <id>` output for the evidence block (a reader; no key). */
export async function evidenceBlock({ ctx, cwd, ticketId }) {
  const argv = [ctx.pinned.adlc, 'gate-manifest', 'attest', '--ticket', ticketId, '--dir', join(cwd, '.adlc')];
  const r = await ctx.spawn({ argv, cwd, env: childEnv(ctx.env.base), deadlineMs: DEADLINES.adlcRecorder, label: 'adlc gate-manifest attest' });
  return r.status === 0 ? r.stdout.trim() : `[evidence unavailable: gate-manifest attest exited ${r.status}]`;
}

export function prBody({ issue, ticketId, attest, review, quota, baseOid, evidence, rounds }) {
  const n = validateIssueNumber(issue);
  const q = quota?.windows ?? quota ?? {};
  return [
    `Closes #${n}`,
    '',
    `Ticket: \`${ticketId}\``,
    `base-oid: ${validateOid(baseOid, { field: 'baseOid' })}`,
    '',
    '## Review',
    `- verdict: ${review?.verdict ?? 'approve'} (codex cross-model), rounds: ${rounds ?? review?.rounds ?? 1}`,
    `- attested head: ${attest?.attestedHead ?? 'n/a'}${attest?.revision ? `, revision: ${attest.revision}` : ''}`,
    '',
    '## Evidence',
    '```',
    String(evidence ?? '[no evidence block]').trim(),
    '```',
    '',
    '## Quota at start',
    `- five-hour: ${q.fiveHour ?? 'n/a'}%, seven-day: ${q.sevenDay ?? 'n/a'}%, scoped: ${q.scoped ?? 'none'}`,
    '',
    '_Opened by adlc-autopilot._',
  ].join('\n');
}
