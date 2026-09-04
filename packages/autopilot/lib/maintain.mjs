// Open-PR maintenance (spec §8; AC 7, 48, 61, 62).
//
// Maintenance iterates over RUN RECORDS, never over branches or PRs found on
// GitHub: only `pr-open`/`ci-watch` records are candidates, and records in
// `stale`/`ci-red`/`oid-mismatch` with a PR are observed for the MERGED/CLOSED
// lifecycle only. Every candidate is read FIRST (`gh pr view`), provenance is
// checked (token vs marker, head name), and only an OPEN PR that meets ALL the
// mutation preconditions is ever rebased/dispatched/pushed. A clean rebase is
// pushed only when the patch-id is unchanged (carry-forward, no model call);
// any change → a full retry round; a conflict → one conflict-fix round.

import { existsSync } from 'node:fs';
import { MAINTENANCE_STATES, CAP_STATES } from './records.mjs';
import { branchFor, validateOid } from './input.mjs';
import { headOf, isClean, carryForward, COMMIT_IDENTITY } from './review.mjs';
import { verifyPushVerify, remoteHead } from './push.mjs';
import { ensureLabel, ensureComment } from './github.mjs';
import { WITHHELD_BODY } from './redact.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'maintain.skipProvenance',            // token/marker + head-name provenance is not checked
  'maintain.skipPreconditions',         // base/head/ls-remote mutation preconditions are not checked
  'maintain.carryForwardWithoutPatchId', // a clean rebase carries forward even when the patch-id changed
  'maintain.maintainAnyState',          // every record is a rebase candidate
  'maintain.countStaleTowardCap',       // stale/ci-red PRs count toward the open-PR cap
  'maintain.deleteRecordWithRemoteRef', // the canonical rule deletes the record while the remote ref still exists
]);

export const LIFECYCLE_OBSERVED_STATES = Object.freeze(['stale', 'ci-red', 'oid-mismatch']);
export const SKIP_LABEL = 'adlc:autopilot-skip';
export const STALE_LABEL = 'adlc:autopilot-stale';
export const REBASE_STATES = Object.freeze(['BEHIND', 'DIRTY']);

export function remoteDeleteCommand(ctx, record) {
  const b = branchFor(record.issue);
  return `git --git-dir=${ctx.paths.netGit} push --force-with-lease=refs/heads/${b}:${record.lastPushedOid ?? ''} ${ctx.remote.remotePushUrl} :refs/heads/${b}`;
}

/** Records counting toward the cap of 5: CAP_STATES with an OPEN PR (stale/ci-red excluded). */
export function activePrCount(records, { isOpen = (r) => r.prState === 'OPEN' } = {}) {
  const extra = active('maintain.countStaleTowardCap') ? ['stale', 'ci-red'] : [];
  return records.filter((r) => (CAP_STATES.includes(r.state) || extra.includes(r.state)) && r.prNumber != null && isOpen(r)).length;
}
export const capAllows = (records, maxOpenPrs, opts) => activePrCount(records, opts) < maxOpenPrs;

async function viewPr(ctx, prNumber, fields) {
  try { return await ctx.gh.json(['pr', 'view', String(prNumber), '--json', fields]); } catch { return null; }
}

async function patchIdOf(ctx, cwd, range) {
  const diff = await ctx.git.local(cwd, ['diff', range]);
  if (diff.status !== 0) throw new Error(`git diff ${range} exited ${diff.status}`);
  const pid = await ctx.git.local(cwd, ['patch-id', '--stable'], { stdinBytes: diff.stdout });
  if (pid.status !== 0) throw new Error(`git patch-id exited ${pid.status}`);
  return pid.stdout.trim().split(/\s+/)[0] ?? '';
}

async function optional(path, name) {
  try { const m = await import(path); return m[name] ?? null; } catch { return null; }
}

/** Run maintenance over every record. `deps` injects the orchestrator/sibling steps. */
export async function maintainOpenPrs({ ctx, baseOid, retryRound = null, deps = {} }) {
  const base = validateOid(baseOid, { field: 'baseOid' });
  // A dependency named in `deps` (even as null) wins; an absent one is imported from its sibling module when present.
  const pick = async (name, path) => (name in deps ? deps[name] ?? null : optional(path, name));
  const resolved = {
    retireRun: await pick('retireRun', './retire.mjs'),
    actualDiffCheck: await pick('actualDiffCheck', './diffcheck.mjs'),
    applyTerminalEffects: await pick('applyTerminalEffects', './effects.mjs'),
    conflictFixRound: deps.conflictFixRound ?? null,
    retryRound: retryRound ?? deps.retryRound ?? null,
  };
  const actions = [];
  for (const record of ctx.records.all()) {
    const candidate = MAINTENANCE_STATES.includes(record.state) || active('maintain.maintainAnyState');
    const observeOnly = !candidate && LIFECYCLE_OBSERVED_STATES.includes(record.state) && record.prNumber != null;
    if (!candidate && !observeOnly) { actions.push({ issue: record.issue, action: 'skip', state: record.state }); continue; }
    try { actions.push(await maintainOne({ ctx, record, base, deps: resolved, observeOnly })); }
    catch (e) { ctx.records.update(record.issue, { lastError: `maintenance: ${e.message}` }); actions.push({ issue: record.issue, action: 'error', error: e.message, code: e.code ?? null }); }
  }
  return { actions };
}

async function maintainOne({ ctx, record, base, deps, observeOnly }) {
  const n = record.issue; const b = branchFor(n);
  const orphan = (reason) => { ctx.records.update(n, { state: 'orphan', lastError: `orphan: ${reason}` }); return { issue: n, action: 'orphan', reason }; };
  const oidMismatch = (detail) => { ctx.records.update(n, { state: 'oid-mismatch', lastError: `oid-mismatch: ${detail}` }); return { issue: n, action: 'oid-mismatch', detail, comment: `oid-mismatch: ${detail}`, target: { kind: 'pr', number: record.prNumber } }; };
  if (record.prNumber == null) return orphan('no PR number on record');
  const pr = await viewPr(ctx, record.prNumber, 'headRefName,headRefOid,state,baseRefName');
  if (!pr) return orphan(`PR #${record.prNumber} not found`);
  if (!active('maintain.skipProvenance')) {
    const marker = await ctx.git.observe(`branch.${b}.adlcAutopilotToken`);
    if (marker !== record.token) return orphan('ownership marker does not match the record token');
    if (pr.headRefName !== b) return orphan(`PR head ${pr.headRefName} is not ${b}`);
  }
  ctx.records.update(n, { prState: pr.state });
  if (pr.state === 'MERGED') return lifecycleMerged({ ctx, record, deps });
  if (pr.state === 'CLOSED') return lifecycleClosed({ ctx, record, deps });
  if (observeOnly) return { issue: n, action: 'observed', state: record.state, prState: pr.state };
  if (pr.state !== 'OPEN') return orphan(`PR state ${pr.state}`);
  if (!active('maintain.skipPreconditions')) {
    if (pr.baseRefName !== 'main') return orphan(`PR base ${pr.baseRefName} is not main`);
    if (pr.headRefOid !== record.attestedHead) return oidMismatch(`PR #${record.prNumber} head ${pr.headRefOid} != attestedHead ${record.attestedHead}`);
    const remote = await remoteHead(ctx, ctx.remote.remoteFetchUrl, b);
    if (remote !== record.lastPushedOid) return orphan(`remote ref ${remote ?? 'absent'} != lastPushedOid ${record.lastPushedOid}`);
  }
  const merge = await viewPr(ctx, record.prNumber, 'mergeStateStatus,headRefOid');
  if (!merge) return orphan(`PR #${record.prNumber} unreadable`);
  if (!active('maintain.skipPreconditions') && merge.headRefOid !== record.attestedHead) return oidMismatch(`PR head moved to ${merge.headRefOid}`);
  if (!REBASE_STATES.includes(merge.mergeStateStatus)) return { issue: n, action: 'current', mergeStateStatus: merge.mergeStateStatus };
  return rebase({ ctx, record: ctx.records.load(n), base, deps, orphan });
}

async function rebase({ ctx, record, base, deps, orphan }) {
  const n = record.issue; const b = branchFor(n); const wt = ctx.paths.issueWorktree(n);
  if (!existsSync(wt)) {
    const add = await ctx.git.local(ctx.repoRoot, ['worktree', 'add', wt, b]);
    if (add.status !== 0) return orphan(`worktree add failed: ${add.stderr.trim().slice(0, 200)}`);
  }
  if ((await headOf(ctx, wt)) !== record.attestedHead || !(await isClean(ctx, wt))) return orphan('issue worktree is not at attestedHead or not clean');
  const oldBase = record.baseOid; const oldHead = record.attestedHead;
  if (oldBase === base) return { issue: n, action: 'current', reason: 'base unchanged' };
  const r = await ctx.git.local(wt, [...COMMIT_IDENTITY, 'rebase', base]);
  if (r.status !== 0) {
    const markers = `${r.stdout}\n${r.stderr}`;
    await ctx.git.local(wt, ['rebase', '--abort']);
    return conflictRound({ ctx, record, base, deps, markers });
  }
  const newHead = await headOf(ctx, wt);
  const before = await patchIdOf(ctx, wt, `${oldBase}...${oldHead}`);
  const after = await patchIdOf(ctx, wt, `${base}...${newHead}`);
  const retry = async (reason) => {
    ctx.records.update(n, { baseOid: base, localHead: newHead, reviewedHead: null, lastError: `rebase: ${reason}` });
    const result = deps.retryRound ? await deps.retryRound({ ctx, record: ctx.records.load(n), reason }) : null;
    return { issue: n, action: 'retry-round', reason, result };
  };
  if (!active('maintain.carryForwardWithoutPatchId') && before !== after) return retry('patch-id-changed');
  if (deps.actualDiffCheck) {
    const check = await deps.actualDiffCheck({ ctx, issue: n, record, baseOid: base, head: newHead, scope: record.ticketCache?.scope ?? [], ticketId: record.ticketId });
    if (!check?.ok) { ctx.records.update(n, { state: 'blocked', baseOid: base, localHead: newHead, lastError: `actual-diff: ${check?.code ?? 'failed'}` }); return { issue: n, action: 'blocked', code: check?.code ?? 'actual-diff-failed' }; }
  }
  let cf;
  try { cf = await carryForward({ ctx, cwd: wt, ticketId: record.ticketId, priorRevision: record.attestRevision, baseOid: base }); }
  catch (e) { if (e.code === 'carry-forward-refused') return retry(`carry-forward-refused: ${e.message}`); throw e; }
  // carryForward already appended its manifest-line hashes to record.manifestLinesWritten (S5 convention).
  ctx.records.update(n, { baseOid: base, attestedHead: cf.attestedHead, reviewedHead: newHead, attestRevision: cf.revision, localHead: cf.attestedHead });
  const push = await verifyPushVerify({ ctx, issue: n, record: ctx.records.load(n), attestedHead: cf.attestedHead });
  if (!push.ok) return { issue: n, action: 'push-failed', ...push };
  ctx.records.update(n, { state: 'ci-watch', ciReEvaluations: 0 });
  return { issue: n, action: 'rebased', attestedHead: cf.attestedHead, digest: 'rebased' };
}

async function conflictRound({ ctx, record, base, deps, markers }) {
  const n = record.issue;
  const stale = (reason) => {
    ctx.records.update(n, { state: 'stale', lastError: `stale: ${reason}` });
    return { issue: n, action: 'stale', reason, label: STALE_LABEL, comment: `rebase onto ${base} could not be completed: ${reason}`, target: { kind: 'issue', number: n } };
  };
  const max = ctx.config?.autopilot?.maxRounds ?? 15;
  if ((record.roundsUsed ?? 0) >= max) return stale('conflict and the round budget is exhausted');
  const ordinal = ((ctx.status?.read?.()?.startsThisIteration) ?? 0) + 1;
  const quota = await ctx.quota.sample({ ordinal, fresh: true });
  if (!quota.ok) return { issue: n, action: 'skipped', reason: `quota:${quota.reason}` };
  ctx.records.update(n, { roundsUsed: (record.roundsUsed ?? 0) + 1 }); // charged BEFORE the round
  const red = ctx.redactor.redact(markers, { withheld: WITHHELD_BODY });
  if (!deps.conflictFixRound) return stale('no conflict-fix round available');
  const res = await deps.conflictFixRound({ ctx, record: ctx.records.load(n), baseOid: base, deadEnd: red.text });
  if (!res?.ok) return stale(res?.code ?? 'conflict-fix round failed');
  ctx.records.update(n, { state: 'ci-watch', baseOid: base, ciReEvaluations: 0, ...(res.attestedHead ? { attestedHead: res.attestedHead } : {}) });
  return { issue: n, action: 'conflict-fixed', round: (record.roundsUsed ?? 0) + 1 };
}

async function retireAndReconcile({ ctx, record, deps }) {
  const n = record.issue; const b = branchFor(n);
  // lib/retire.mjs (S4): retireRun({ ctx, record, skipCanonical }) → { outcome: 'orphan' | 'deleted' | 'remote-pending' | … }.
  // The canonical rule (L5) is applied HERE, once, so it is skipped inside retireRun.
  const retired = deps.retireRun ? await deps.retireRun({ ctx, record: ctx.records.load(n) ?? record, skipCanonical: true }) : { ok: false, outcome: 'recover-unavailable' };
  if (retired?.outcome === 'orphan' || retired?.state === 'orphan' || retired?.ok === false) return { retired, state: 'orphan', recordDeleted: false };
  if (!ctx.records.load(n)) return { retired, state: 'deleted', recordDeleted: true };
  const remote = await remoteHead(ctx, ctx.remote.remoteFetchUrl, b);
  if (remote == null || active('maintain.deleteRecordWithRemoteRef')) { ctx.records.remove(n, { lastPushedOid: record.lastPushedOid }); return { retired, state: 'deleted', recordDeleted: true }; }
  ctx.records.update(n, { state: 'remote-pending', remoteRefLeft: remote });
  return { retired, state: 'remote-pending', recordDeleted: false, remoteDeleteCommand: remoteDeleteCommand(ctx, record) };
}

async function lifecycleMerged({ ctx, record, deps }) {
  const n = record.issue;
  ctx.records.update(n, { state: 'done' });
  const out = await retireAndReconcile({ ctx, record, deps });
  return { issue: n, action: 'merged', ...out };
}

async function lifecycleClosed({ ctx, record, deps }) {
  const n = record.issue;
  const out = await retireAndReconcile({ ctx, record, deps });
  const command = remoteDeleteCommand(ctx, record);
  const sentinel = `<!-- adlc-autopilot:pr-closed ${record.prNumber} -->`;
  const body = `PR #${record.prNumber} was closed without merging; the autopilot retired its local artifacts and will not retry this issue.\n\nThe remote branch was left in place. To delete it:\n\n    ${command}\n`;
  const effects = {};
  if (deps.applyTerminalEffects && ctx.records.load(n)) {
    effects.result = await deps.applyTerminalEffects({ ctx, record: ctx.records.load(n), outcome: 'pr-closed', target: { kind: 'issue', number: n }, sentinel, body, label: SKIP_LABEL });
  } else {
    const red = ctx.redactor.redact(body, { withheld: WITHHELD_BODY });
    effects.comment = await ensureComment(ctx.gh, n, sentinel, red.text);
    effects.label = await ensureLabel(ctx.gh, n, SKIP_LABEL, { present: true });
  }
  return { issue: n, action: 'closed', label: SKIP_LABEL, remoteDeleteCommand: command, effects, ...out };
}
