// `adlc-autopilot reset --issue N ( --confirm-delete <OID> [--delete-remote] | --attempts )`
// (spec §13.0, §2.1 orphan row, §2.1a Step R; AC 42, 45, 63, 110; ticket AC4).
//
// The ONLY place a remote ref is ever deleted: record-bearing + `--delete-remote`
// → Step R (lease-guarded, fail-closed on freshness, remote-first). A RECORDLESS
// branch is local-only even with `--delete-remote` (refused, exit 2, the exact
// `git push` printed): the local marker alone never authorizes a remote delete.
// Exit 2 refusals are RETURNED ({ exitCode: 2, code }) — nothing is thrown for a
// gate outcome; grammar errors throw InputError (exit 1).

import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { validateIssueNumber, validateOid, branchFor } from './input.mjs';
import { ensureLabel } from './github.mjs';
import { registerSeams, active } from './mutations.mjs';
import {
  readMarker, localBranchTip, openPrsForHead, remoteRefOid, deletionCommand, markOrphan, retireRun, canonicalDeletion, LABEL_NEEDS_HUMAN, RunError,
} from './retire.mjs';

registerSeams([
  'reset.allowRecordlessRemoteDelete', // a recordless branch's --delete-remote is honoured
  'reset.skipFreshnessCheck',          // the 10-minute / lastPushedAt-absent refusal is skipped
  'reset.skipUrlRecheck',              // remote.origin.url is not re-observed before the push
  'reset.leaselessDelete',             // the remote delete uses --force instead of the lease form
  'reset.markerOptional',              // a recordless branch without the marker is deleted anyway
]);

export const REF_FRESH_MS = 10 * 60 * 1000;
export const GRACE_DELAYS_MS = Object.freeze([0, 30_000, 120_000]);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refuse = (code, extra = {}) => ({ exitCode: 2, code, ...extra });

/** Any PR (open or closed) whose head is the branch — the post-delete watch query. */
export async function anyPrsForHead(ctx, branch) {
  const rows = await ctx.gh.json(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,headRefName']);
  return Array.isArray(rows) ? rows.filter((p) => Number.isInteger(p?.number)) : [];
}

/** The PRs that were NOT known before the delete — only those count as "a PR appeared". */
export function newPrsForHead(rows, knownPrNumbers = []) {
  const known = new Set(knownPrNumbers ?? []);
  return rows.filter((p) => !known.has(p.number));
}

/**
 * A PR observed after a delete: re-create the ref from the recorded OID with a
 * lease expecting ABSENCE (a ref someone re-created meanwhile is never
 * overwritten), label the issue needs-human, keep the record, stop.
 */
export async function restoreRef({ ctx, record, prNumber }) {
  const issue = record.issue;
  const branch = branchFor(issue);
  const oid = validateOid(record.lastPushedOid);
  let r;
  try { r = await ctx.git.net(['push', `--force-with-lease=refs/heads/${branch}:`, ctx.remote.remotePushUrl, `${oid}:refs/heads/${branch}`], { retry: false }); }
  catch (e) { r = { status: null, error: e }; }
  const restored = r.status === 0 && !r.timedOut && !r.error;
  const code = restored ? 'pr-after-delete-restored' : 'pr-after-delete-unrestored';
  if (ctx.records.load(issue)) ctx.records.update(issue, { prAfterDelete: { number: prNumber, restored, at: new Date(ctx.now()).toISOString() }, needsHuman: true });
  try { await ensureLabel(ctx.gh, issue, LABEL_NEEDS_HUMAN, { present: true }); } catch (e) { ctx.log?.(`issue ${issue}: needs-human label failed: ${e.code ?? e.message}`); }
  ctx.log?.(`issue ${issue}: ${code}: ${prNumber}`);
  return { exitCode: 2, code, report: `${code}: ${prNumber}`, prNumber, restored };
}

/** Step R (§2.1a): lease-guarded remote delete, then the 0/30/120 s watch. */
async function stepR({ ctx, record, sleep }) {
  const issue = record.issue;
  const branch = branchFor(issue);
  if (!record.lastPushedOid) return refuse('reset-never-pushed');
  const lastPushedOid = validateOid(record.lastPushedOid);
  if (!active('reset.skipFreshnessCheck')) {
    const at = Date.parse(record.lastPushedAt ?? '');
    if (Number.isNaN(at) || ctx.now() - at < REF_FRESH_MS) return refuse('ref-too-fresh', { lastPushedAt: record.lastPushedAt ?? null });
  }
  if (!active('reset.skipUrlRecheck')) {
    // The URL observed at phase A (git-runner records it as ctx.remote.observed.fetch) must still be what .git/config says.
    const observed = await ctx.git.observe('remote.origin.url');
    const pinned = ctx.remote.observed?.fetch ?? ctx.remote.remoteFetchUrl;
    if (observed !== pinned) { await markOrphan(ctx, record, 'remote-url-changed'); return refuse('remote-url-changed'); }
  }
  const prs = await openPrsForHead(ctx, branch);                                       // (c) re-evaluated immediately before the push
  if (prs.length) { await markOrphan(ctx, record, 'open-pr', { pr: prs[0].number }); return refuse('orphan', { reason: 'open-pr' }); }
  let remote;
  try { remote = await remoteRefOid(ctx, branch); }
  catch (e) { await markOrphan(ctx, record, e.code ?? 'ls-remote-failed'); return refuse(e.code ?? 'ls-remote-failed'); } // net() re-validation failure → nothing touched
  if (remote !== lastPushedOid) { await markOrphan(ctx, record, 'remote-tip-differs', { expected: lastPushedOid, observed: remote }); return refuse('orphan', { reason: 'remote-tip-differs' }); }
  // PRs that already existed (closed/merged) before the delete are not "a PR that appeared"; the watch reacts only to new numbers.
  const knownPrNumbers = (await anyPrsForHead(ctx, branch)).map((p) => p.number);
  ctx.records.update(issue, { state: 'remote-deleted', remoteDeletedAt: new Date(ctx.now()).toISOString(), knownPrNumbers }); // state BEFORE the effect
  const lease = active('reset.leaselessDelete') ? '--force' : `--force-with-lease=refs/heads/${branch}:${lastPushedOid}`;
  let push;
  try { push = await ctx.git.net(['push', lease, ctx.remote.remotePushUrl, `:refs/heads/${branch}`], { retry: false }); }
  catch (e) { await markOrphan(ctx, record, e.code ?? 'push-failed'); return refuse(e.code ?? 'push-failed'); }
  if (push.status !== 0 || push.timedOut || push.error) { await markOrphan(ctx, record, 'lease-failed'); return refuse('lease-failed'); }
  for (const delay of GRACE_DELAYS_MS) {
    if (delay) await sleep(delay);
    const seen = newPrsForHead(await anyPrsForHead(ctx, branch), knownPrNumbers);
    if (seen.length) return restoreRef({ ctx, record: ctx.records.load(issue) ?? record, prNumber: seen[0].number });
  }
  return { exitCode: 0, code: 'remote-deleted', lastPushedOid };
}

/** Recordless (or token-mismatched) branch: LOCAL artifacts only; `--delete-remote` refused. */
async function resetRecordless({ ctx, issue, oid, deleteRemote, record }) {
  const branch = branchFor(issue);
  const marker = await readMarker(ctx, branch);
  if (!marker && !active('reset.markerOptional')) return refuse('reset-not-owned', { detail: 'no ownership marker' });
  const tip = await localBranchTip(ctx, branch);
  if (tip == null) return refuse('reset-nothing-to-delete');
  if (oid !== tip) return refuse('reset-oid-mismatch', { expected: tip });
  const command = deletionCommand(ctx, branch, tip);
  const prs = await openPrsForHead(ctx, branch);
  if (prs.length) return refuse('reset-open-pr', { pr: prs[0].number });
  const synthetic = { issue, token: marker ?? randomBytes(32).toString('hex'), branch, localHead: tip, baseOid: record?.baseOid ?? null };
  const l = await retireRun({ ctx, record: synthetic, expectedHead: tip, requireAncestry: false, skipCanonical: true });
  if (l.outcome === 'orphan') return refuse('orphan', { reason: l.reason });
  // The marker alone is never proof for a REMOTE ref: --delete-remote is refused (exit 2) and the
  // exact command is printed for the operator to run by hand.
  const remoteRefused = deleteRemote && !active('reset.allowRecordlessRemoteDelete');
  if (deleteRemote && !remoteRefused) {
    await ctx.git.net(['push', `--force-with-lease=refs/heads/${branch}:${tip}`, ctx.remote.remotePushUrl, `:refs/heads/${branch}`], { retry: false });
  }
  let canonical = null;
  if (record) canonical = await canonicalDeletion({ ctx, record: ctx.records.load(issue) ?? record });
  const remote = await remoteRefOid(ctx, branch);
  const printed = remote ? [command] : [];
  if (remoteRefused) return { exitCode: 2, code: 'reset-recordless-remote', printed: [command], command, canonical, localDeleted: true };
  return { exitCode: 0, code: 'local-deleted', printed, command: remote ? command : null, canonical };
}

/**
 * The reset command. Returns { exitCode, code, … } — 0 success, 2 refusal;
 * `printed` carries the lines the bin shows the operator (the manual
 * remote-deletion command). `resetAttemptsFn` is lib/attempts.mjs's
 * `resetAttempts`, injectable so the bin wires it once.
 */
export async function resetCommand({ ctx, issue, confirmDelete = null, deleteRemote = false, attempts = false, sleep = defaultSleep, resetAttemptsFn = null }) {
  issue = validateIssueNumber(issue);
  if (attempts) {
    // lib/attempts.mjs: createAttemptStore({ paths, now, lockToken }).resetAttempts(n) — journaled, idempotent, lock-checked.
    const fn = resetAttemptsFn ?? (await import('./attempts.mjs')).createAttemptStore({ paths: ctx.paths, now: ctx.now, lockToken: ctx.lock?.token ?? null }).resetAttempts;
    const result = await fn(issue, { lockToken: ctx.lock?.token ?? null });
    return { exitCode: 0, code: 'attempts-reset', result };
  }
  if (!confirmDelete) return refuse('reset-needs-oid');
  const oid = validateOid(confirmDelete);
  const branch = branchFor(issue);
  const record = ctx.records.load(issue);
  const marker = await readMarker(ctx, branch);
  const tip = await localBranchTip(ctx, branch);
  // A local branch is the record's only when the LOCAL marker carries its token; with no local
  // branch (retired, remote-pending) the record itself — token + preserved lastPushedOid — is Step R's authorization.
  const owned = !!record && (tip == null ? true : marker === record.token);
  if (!owned) return resetRecordless({ ctx, issue, oid, deleteRemote, record });
  const expected = tip ?? record.lastPushedOid ?? null;
  if (!expected) return refuse('reset-nothing-to-delete');
  if (oid !== expected) return refuse('reset-oid-mismatch', { expected });
  const prs = await openPrsForHead(ctx, branch);
  if (prs.length) return refuse('reset-open-pr', { pr: prs[0].number });
  let remote = null;
  if (deleteRemote) {
    remote = await stepR({ ctx, record, sleep });
    if (remote.exitCode !== 0) return remote;                                   // remote-first: a remote failure leaves every local artifact in place
  }
  const wt = ctx.paths.issueWorktree(issue);
  if (tip != null || existsSync(wt)) {
    const l = await retireRun({ ctx, record: ctx.records.load(issue) ?? record, expectedHead: tip, skipCanonical: true });
    if (l.outcome === 'orphan') return { exitCode: 2, code: 'orphan', reason: l.reason, remote };
  }
  if (deleteRemote) return { exitCode: 0, code: 'remote-deleted', remote, printed: [] };
  const canonical = await canonicalDeletion({ ctx, record: ctx.records.load(issue) ?? record });
  const printed = canonical.outcome === 'remote-pending' ? [canonical.command] : [];
  return { exitCode: 0, code: canonical.outcome === 'deleted' ? 'deleted' : canonical.outcome, canonical, printed };
}

export { RunError };
