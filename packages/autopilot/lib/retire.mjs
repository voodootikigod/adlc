// Retiring a run — ownership-checked LOCAL deletion (spec §2.1a Step L,
// L1–L5) and the §2.1 canonical deletion rule.
//
// Deletion of a branch or worktree requires ALL of (a) a record with a token,
// (b) the LOCAL git-config marker equal to that token, (c) no open PR whose
// head is the branch, (d) the branch still descends from `baseOid`, (e) the
// tip equals the record's `localHead` and the worktree is clean — re-validated
// immediately before each destructive command. The ONLY ref delete is the
// conditional `git update-ref -d <ref> <expectedOid>`; `git branch -D` never
// appears; `git worktree remove` is never `--force`; automatic retirement
// issues ZERO `git push` — a remote ref is never deleted on the strength of
// the local token and ancestry alone. Any check failing → `orphan`, nothing
// further deleted.

import { existsSync } from 'node:fs';
import { branchFor, validateToken } from './input.mjs';
import { registerSeams, active } from './mutations.mjs';
import { DEADLINES } from './spawn.mjs';
import { LABELS } from './labels.mjs';

registerSeams([
  'retire.forceRemove',                 // the dirty-tree check is skipped and the worktree removal is forced
  'retire.skipTipCheck',                // the ref delete is unconditional (no expected OID) and (e) is not re-checked
  'retire.skipMarkerCheck',             // (b) is skipped: the record token is trusted without the marker
  'retire.noDetach',                    // L2 does not detach the quarantined worktree before L3
  'recover.deleteRecordDespiteRemoteRef', // the canonical rule deletes the record while the remote ref exists
]);

export class RunError extends Error {
  constructor(code, detail, exitCode = 1) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RunError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export const MARKER_KEY = (branch) => `branch.${branch}.adlcAutopilotToken`;
export const LABEL_NEEDS_HUMAN = LABELS.needsHuman;
export const REMOTE_DELETED_TTL_MS = 24 * 60 * 60 * 1000;

/** One local git command through `ctx.git.local`; never child_process. */
export async function runGit(ctx, cwd, args, opts = {}) {
  const r = await ctx.git.local(cwd, args, { deadlineMs: DEADLINES.git, ...opts });
  return { ok: r.status === 0 && !r.timedOut && !r.error, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim(), status: r.status };
}

/** The ownership marker of a branch, read from the repo's LOCAL config (never the env overlay). */
export async function readMarker(ctx, branch) {
  const v = await ctx.git.observe(MARKER_KEY(branch));
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** OID of a local branch, or null when it does not exist. */
export async function localBranchTip(ctx, branch) {
  const r = await runGit(ctx, ctx.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.ok && /^[0-9a-f]{40,64}$/.test(r.out) ? r.out : null;
}

/** Open PRs whose head is `branch` — `gh pr list --head <b> --state open --json number`. */
export async function openPrsForHead(ctx, branch) {
  const rows = await ctx.gh.json(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number']);
  return Array.isArray(rows) ? rows.filter((p) => Number.isInteger(p?.number)) : [];
}

/** `git --git-dir=<NET_GIT> ls-remote <pinned fetch URL> refs/heads/<b>` → OID or null (empty). */
export async function remoteRefOid(ctx, branch) {
  const r = await ctx.git.net(['ls-remote', ctx.remote.remoteFetchUrl, `refs/heads/${branch}`]);
  if (r.status !== 0 || r.timedOut || r.error) throw new RunError('ls-remote-failed', String(r.stderr ?? '').trim().slice(0, 200));
  const line = String(r.stdout ?? '').split('\n').find((l) => l.trim());
  if (!line) return null;
  const oid = line.split(/\s+/)[0];
  return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
}

/** The exact operator command that deletes the remote ref with a lease (printed, never run automatically). */
export function deletionCommand(ctx, branch, oid) {
  return `git push --force-with-lease=refs/heads/${branch}:${oid} ${ctx.remote.remotePushUrl} :refs/heads/${branch}`;
}

/** True iff `path` exists on disk or is still listed by `git worktree list`. */
export async function worktreePresent(ctx, path) {
  if (existsSync(path)) return true;
  const r = await runGit(ctx, ctx.repoRoot, ['worktree', 'list', '--porcelain']);
  return r.ok && r.out.split('\n').some((l) => l === `worktree ${path}`);
}

/** Append an entry to a list in the status file (no-op without a status store). */
export function statusAppend(ctx, key, entry) {
  if (!ctx.status?.read || !ctx.status?.write) return;
  const cur = ctx.status.read() ?? {};
  const list = Array.isArray(cur[key]) ? cur[key] : [];
  ctx.status.write({ [key]: [...list, entry] });
}

/** Mark a run `orphan` (record when one exists, status always) — never deletes anything. */
export async function markOrphan(ctx, record, reason, extra = {}) {
  const issue = record.issue;
  const branch = branchFor(issue);
  const oid = await localBranchTip(ctx, branch);
  if (ctx.records.load(issue)) ctx.records.update(issue, { state: 'orphan', orphanReason: reason, ...extra });
  statusAppend(ctx, 'orphans', { issue, branch, oid, reason, ...extra });
  ctx.log?.(`issue ${issue}: orphan (${reason})`);
  return { outcome: 'orphan', reason, issue };
}

/**
 * Step L of §2.1a. Returns { outcome: 'retired' | 'nothing-local' | 'orphan',
 * reason?, quarantined?[] }. `expectedHead` (reset) overrides the record's
 * `localHead`; `requireAncestry:false` is the recordless reset form.
 */
export async function stepL({ ctx, record, expectedHead = null, requireAncestry = true }) {
  const issue = record.issue;
  const branch = branchFor(issue);
  const paths = ctx.paths;
  const orphan = (reason, extra) => markOrphan(ctx, record, reason, extra);
  let token;
  try { token = validateToken(record.token); } catch { return orphan('no-token'); }               // (a)
  const marker = await readMarker(ctx, branch);
  if (!active('retire.skipMarkerCheck') && marker !== token) return orphan('marker-mismatch');   // (b)
  const prs = await openPrsForHead(ctx, branch);
  if (prs.length) return orphan('open-pr', { pr: prs[0].number });                                 // (c)
  const tip = await localBranchTip(ctx, branch);
  const wt = paths.issueWorktree(issue);
  const wtExists = existsSync(wt);
  if (tip == null && !wtExists) return { outcome: 'nothing-local', issue };
  if (tip == null) return orphan('worktree-without-branch');
  if (requireAncestry) {                                                                          // (d)
    if (!record.baseOid) return orphan('no-base-oid');
    const mb = await runGit(ctx, ctx.repoRoot, ['merge-base', `refs/heads/${branch}`, record.baseOid]);
    if (!mb.ok || mb.out !== record.baseOid) return orphan('ancestry');
  }
  const head = expectedHead ?? record.localHead;
  if (!head) return orphan('no-local-head');
  if (!active('retire.skipTipCheck') && tip !== head) return orphan('tip-moved', { expected: head, observed: tip }); // (e)
  const retiring = paths.retiringWorktree(issue, token);
  let moved = false;
  const moveBack = async () => { if (moved) { await runGit(ctx, ctx.repoRoot, ['worktree', 'move', retiring, wt]); moved = false; } };
  if (wtExists) {
    const st = await runGit(ctx, wt, ['status', '--porcelain']);
    if (!st.ok) return orphan('status-failed');
    if (st.out && !active('retire.forceRemove')) return orphan('dirty');                          // (e) clean tree
    // L1
    const wtHead = await runGit(ctx, wt, ['rev-parse', 'HEAD']);
    const sym = await runGit(ctx, wt, ['symbolic-ref', 'HEAD']);
    if (!wtHead.ok || wtHead.out !== head || !sym.ok || sym.out !== `refs/heads/${branch}`) return orphan('worktree-head', { expected: head, observed: wtHead.out });
    // L2
    const mv = await runGit(ctx, ctx.repoRoot, ['worktree', 'move', wt, retiring]);
    if (!mv.ok) return orphan('move-failed', { detail: mv.err.slice(0, 200) });
    moved = true;
    if (!active('retire.noDetach')) {
      const det = await runGit(ctx, retiring, ['checkout', '--detach', head]);
      if (!det.ok) { await moveBack(); return orphan('detach-failed', { detail: det.err.slice(0, 200) }); }
    }
  }
  // L3 — the conditional ref delete: fails if the ref moved since (e).
  const delArgs = ['update-ref', '-d', `refs/heads/${branch}`];
  if (!active('retire.skipTipCheck')) delArgs.push(head);
  const del = await runGit(ctx, ctx.repoRoot, delArgs);
  if (!del.ok) { await moveBack(); return orphan('ref-moved', { detail: del.err.slice(0, 200) }); }
  const quarantined = [];
  if (moved) {
    // L4 — re-verify the quarantined worktree is detached at exactly `head`.
    const h = await runGit(ctx, retiring, ['rev-parse', 'HEAD']);
    const s = await runGit(ctx, retiring, ['symbolic-ref', '-q', 'HEAD']);
    if (!h.ok || h.out !== head || s.ok) return orphan('quarantined-worktree-moved', { quarantined: retiring, expected: head, observed: h.out });
    const rmArgs = ['worktree', 'remove', retiring];
    if (active('retire.forceRemove')) rmArgs.push('--force');
    const rm = await runGit(ctx, ctx.repoRoot, rmArgs);
    if (!rm.ok) { quarantined.push(retiring); statusAppend(ctx, 'quarantined', { issue, path: retiring, detail: rm.err.slice(0, 200) }); }
  }
  await runGit(ctx, ctx.repoRoot, ['config', '--unset', MARKER_KEY(branch)]);
  return { outcome: 'retired', issue, quarantined };
}

/**
 * The §2.1 canonical deletion rule — the ONLY path that deletes a record:
 * delete iff the remote ref is absent AND no local branch AND no worktree;
 * remote present → `remote-pending` (+ `remoteRefsLeft` with the exact
 * deletion command); local artifacts present → the caller retires first.
 */
export async function canonicalDeletion({ ctx, record }) {
  const issue = record.issue;
  const branch = branchFor(issue);
  const remote = await remoteRefOid(ctx, branch);
  if (remote != null && !active('recover.deleteRecordDespiteRemoteRef')) {
    const lastPushedOid = record.lastPushedOid ?? remote;
    const command = deletionCommand(ctx, branch, lastPushedOid);
    if (ctx.records.load(issue)) ctx.records.update(issue, { state: 'remote-pending', remoteOid: remote, lastPushedOid });
    statusAppend(ctx, 'remoteRefsLeft', { issue, ref: `refs/heads/${branch}`, oid: remote, lastPushedOid, command });
    return { outcome: 'remote-pending', issue, remoteOid: remote, command };
  }
  if (await localBranchTip(ctx, branch) != null) return { outcome: 'local-present', issue, what: 'branch' };
  if (await worktreePresent(ctx, ctx.paths.issueWorktree(issue))) return { outcome: 'local-present', issue, what: 'worktree' };
  if (record.token && /^[0-9a-f]{64}$/.test(record.token) && existsSync(ctx.paths.retiringWorktree(issue, record.token))) return { outcome: 'local-present', issue, what: 'quarantined' };
  ctx.records.remove(issue, { lastPushedOid: record.lastPushedOid ?? null });
  return { outcome: 'deleted', issue };
}

/**
 * Automatic retirement (§2.1a): Step L then the canonical rule (L5). Never a
 * `git push`. `skipCanonical` is the `reset --delete-remote` form, where the
 * record stays `remote-deleted` for its 24 h watch.
 */
export async function retireRun({ ctx, record, expectedHead = null, requireAncestry = true, skipCanonical = false }) {
  let l;
  try { l = await stepL({ ctx, record, expectedHead, requireAncestry }); }
  catch (e) { return markOrphan(ctx, record, `error:${e.code ?? e.message}`); }
  if (l.outcome === 'orphan') return l;
  if (skipCanonical || !ctx.records.load(record.issue)) return { ...l, canonical: null };
  const c = await canonicalDeletion({ ctx, record: ctx.records.load(record.issue) ?? record });
  return { ...l, outcome: c.outcome === 'deleted' ? 'deleted' : c.outcome, canonical: c };
}
