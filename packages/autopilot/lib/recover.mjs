// The §2.1 recovery state machine — runs before selection, every iteration
// (AC 21, 43, 58, 63, 67, 93, 107; ticket AC2). Row by row over every run
// record plus the `adlc/autopilot/issue-*` branches without a record.
//
// Recovery performs its OWN world-effects here (creation repair, retire,
// re-arm, unlabel re-apply, post-delete restore, the canonical deletion rule)
// and RETURNS resume actions for the rows the orchestrator owns (dispatch,
// attest, push/PR upsert, CI evaluation) — recovery never resumes a run
// itself. Every transition is written to the record BEFORE its effect.

import { validateIssueNumber, branchFor } from './input.mjs';
import { LABEL_FOR_STATE } from './records.mjs';
import { issueTimeline, permissionOf, isMaintainer, ensureLabel } from './github.mjs';
import { registerSeams, active } from './mutations.mjs';
import { repairCreation } from './create.mjs';
import { restoreRef, anyPrsForHead, newPrsForHead } from './reset.mjs';
import {
  readMarker, localBranchTip, openPrsForHead, remoteRefOid, runGit, statusAppend, markOrphan, retireRun, canonicalDeletion, REMOTE_DELETED_TTL_MS,
} from './retire.mjs';

registerSeams([
  'recover.trustAnyUnlabel',        // the unlabel actor's permission is not checked
  'recover.retireInsteadOfRearm',   // an authorized unlabel on a run WITH an open PR retires instead of re-arming
  'recover.rearmWithoutPr',         // an authorized unlabel on a run WITHOUT a PR re-arms instead of retiring
  'recover.forgetPushedWithoutPr',  // a `pushed` record with no PR is fed to the canonical rule instead of being kept for the upsert
]);

/** Quarantined states and the label a human removes to release them (§2.1). */
export const QUARANTINE_LABEL = Object.freeze({ ...LABEL_FOR_STATE, 'oid-mismatch': 'adlc:autopilot-blocked' });
export const QUARANTINED_STATES = Object.freeze(Object.keys(QUARANTINE_LABEL));
const RESUME_ACTION = Object.freeze({
  shaped: 'resume-shaped', dispatched: 'resume-dispatch', 'quota-paused': 'resume-dispatch', built: 'resume-attest',
  attested: 'upsert-pr', 'ci-watch': 'evaluate-ci', 'pr-open': 'maintain',
});

/** Re-arm (§2.1): counters to 0, watch clock to 0, state `pr-open`; branch and PR untouched. */
export function rearmRun({ ctx, record, unlabeledEventId = record.unlabeledEventId ?? null }) {
  const updated = ctx.records.update(record.issue, { state: 'pr-open', roundsUsed: 0, wallClockUsedMs: 0, ciRoundsUsed: 0, ciWatchStartedAt: null, unlabeledEventId, rearmedAt: new Date(ctx.now()).toISOString() });
  return { action: 're-arm', issue: record.issue, state: updated.state };
}

const byNewest = (a, b) => (Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? '')) || ((b.id ?? 0) - (a.id ?? 0));

/**
 * Authorization of a label removal (§2.1a): the most recent `unlabeled` event
 * for the label must be by an admin/maintain actor and not already acted on.
 * Returns { authorized, event, actor, reason }.
 */
export async function unlabelAuthorization({ ctx, record, target, label }) {
  const tl = await issueTimeline(ctx.gh, target);
  if (!tl.ok) return { authorized: false, event: null, actor: null, reason: tl.reason };
  const event = tl.events.filter((e) => e?.event === 'unlabeled' && e?.label?.name === label).sort(byNewest)[0] ?? null;
  if (!event) return { authorized: false, event: null, actor: null, reason: 'no-unlabel-event' };
  if (record.unlabeledEventId != null && String(event.id) === String(record.unlabeledEventId)) return { authorized: false, event, actor: event.actor?.login ?? null, reason: 'already-acted' };
  const actor = event.actor?.login ?? null;
  const perm = active('recover.trustAnyUnlabel') ? 'admin' : actor ? await permissionOf(ctx.gh, actor) : null;
  if (!isMaintainer(perm)) return { authorized: false, event, actor, reason: 'unauthorized-unlabel', permission: perm };
  return { authorized: true, event, actor, reason: null };
}

/** The blocked/clarify/stale/ci-red/oid-mismatch rows: act only on an AUTHORIZED human unlabel. */
async function recoverQuarantined(ctx, record) {
  const issue = record.issue;
  const label = QUARANTINE_LABEL[record.state];
  const target = record.effects?.[record.state]?.target?.number ?? issue;
  const view = await ctx.gh.json(['issue', 'view', String(validateIssueNumber(target)), '--json', 'labels']);
  if ((view?.labels ?? []).some((l) => l?.name === label)) return { action: 'quarantined', issue, state: record.state };
  const auth = await unlabelAuthorization({ ctx, record, target, label });
  if (auth.reason === 'already-acted') return { action: 'already-acted', issue, state: record.state };
  if (!auth.authorized) {
    await ensureLabel(ctx.gh, target, label, { present: true });                          // idempotent re-apply: the quarantine stays visible
    statusAppend(ctx, 'unauthorizedUnlabels', { issue, label, actor: auth.actor, eventId: auth.event?.id ?? null, reason: auth.reason });
    ctx.log?.(`issue ${issue}: unauthorized-unlabel by ${auth.actor ?? '?'} (${auth.reason})`);
    return { action: 'unauthorized-unlabel', issue, actor: auth.actor, reason: auth.reason };
  }
  ctx.records.update(issue, { unlabeledEventId: auth.event.id });                         // the same event is never acted on twice
  const current = ctx.records.load(issue);
  const branch = branchFor(issue);
  const prs = record.state === 'clarify' ? [] : await openPrsForHead(ctx, branch);
  const hasPr = prs.length > 0;
  const rearm = hasPr ? !active('recover.retireInsteadOfRearm') : active('recover.rearmWithoutPr');
  if (rearm) return rearmRun({ ctx, record: current, unlabeledEventId: auth.event.id });
  if (record.state === 'clarify') {
    const c = await canonicalDeletion({ ctx, record: current });
    return { action: 'retire', issue, outcome: c.outcome };
  }
  const r = await retireRun({ ctx, record: current });
  return { action: 'retire', issue, outcome: r.outcome, reason: r.reason ?? null };
}

/** The `remote-deleted` row: re-query PRs; restore on sight; canonical rule after 24 h. */
async function recoverRemoteDeleted(ctx, record) {
  const issue = record.issue;
  const branch = branchFor(issue);
  const pr = newPrsForHead(await anyPrsForHead(ctx, branch), record.knownPrNumbers)[0] ?? null;
  if (pr && !record.prAfterDelete) {
    const r = await restoreRef({ ctx, record, prNumber: pr.number });
    return { action: r.code, issue, prNumber: pr.number, restored: r.restored };
  }
  const at = Date.parse(record.remoteDeletedAt ?? '');
  if (!Number.isNaN(at) && ctx.now() - at > REMOTE_DELETED_TTL_MS) {
    const c = await canonicalDeletion({ ctx, record });
    return { action: 'canonical', issue, outcome: c.outcome };
  }
  return { action: 'remote-deleted-watch', issue };
}

/** `attested`/`pushed` (no PR, or pushed but no PR): the remote ref is inspected and the record KEPT for the upsert (ticket AC2). */
async function recoverPushed(ctx, record) {
  const issue = record.issue;
  const branch = branchFor(issue);
  const prs = await openPrsForHead(ctx, branch);
  const remote = record.lastPushedOid ? await remoteRefOid(ctx, branch) : null;
  if (!prs.length && active('recover.forgetPushedWithoutPr')) {
    const c = await canonicalDeletion({ ctx, record });
    return { action: 'canonical', issue, outcome: c.outcome };
  }
  return { action: 'upsert-pr', issue, prNumber: prs[0]?.number ?? null, remoteOid: remote, lastPushedOid: record.lastPushedOid ?? null };
}

async function recoverOne(ctx, record) {
  const issue = record.issue;
  const branch = branchFor(issue);
  if (record.state === 'creating') {
    const r = await repairCreation({ ctx, record });
    return { action: 'repair-creation', issue, outcome: r.outcome, state: ctx.records.load(issue)?.state ?? null };
  }
  if (record.state === 'orphan') {
    statusAppend(ctx, 'orphans', { issue, branch, oid: await localBranchTip(ctx, branch), reason: record.orphanReason ?? 'orphan' });
    return { action: 'quarantined-orphan', issue };
  }
  if (record.state === 'remote-pending') {
    const c = await canonicalDeletion({ ctx, record });
    return { action: 'canonical', issue, outcome: c.outcome };
  }
  if (record.state === 'remote-deleted') return recoverRemoteDeleted(ctx, record);
  // Provenance: a local branch whose marker is not the record's token is not this record's.
  const tip = record.state === 'clarify' ? null : await localBranchTip(ctx, branch);
  if (tip != null) {
    const marker = await readMarker(ctx, branch);
    if (marker !== record.token) { const o = await markOrphan(ctx, record, 'marker-mismatch'); return { action: 'orphan', issue, reason: o.reason }; }
  }
  if (QUARANTINED_STATES.includes(record.state)) return recoverQuarantined(ctx, record);
  if (record.state === 'pushed' || record.state === 'attested') return recoverPushed(ctx, record);
  if (record.state === 'done' || (tip == null && ['pr-open', 'ci-watch'].includes(record.state))) {
    const prs = await openPrsForHead(ctx, branch);
    if (prs.length) return { action: RESUME_ACTION[record.state] ?? 'maintain', issue, prNumber: prs[0].number };
    if (tip != null) { const r = await retireRun({ ctx, record }); return { action: 'retire', issue, outcome: r.outcome, reason: r.reason ?? null }; }
    const c = await canonicalDeletion({ ctx, record });
    return { action: 'canonical', issue, outcome: c.outcome };
  }
  return { action: RESUME_ACTION[record.state] ?? 'none', issue, state: record.state };
}

/** Branches `adlc/autopilot/issue-*` without a record → `orphan` in status (never deleted). */
async function orphanBranches(ctx, records) {
  const known = new Set(records.map((r) => r.issue));
  const r = await runGit(ctx, ctx.repoRoot, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads/adlc/autopilot/issue-*']);
  const out = [];
  if (!r.ok) return out;
  for (const line of r.out.split('\n')) {
    const m = /^refs\/heads\/adlc\/autopilot\/issue-(\d+)\t([0-9a-f]+)$/.exec(line.trim());
    if (!m) continue;
    const issue = Number(m[1]);
    if (known.has(issue)) continue;
    statusAppend(ctx, 'orphans', { issue, branch: branchFor(issue), oid: m[2], reason: 'no-record' });
    out.push({ action: 'orphan', issue, reason: 'no-record', oid: m[2] });
  }
  return out;
}

/** Run the whole table. Returns { actions }. Status lists are rebuilt each pass. */
export async function recover({ ctx }) {
  ctx.status?.write?.({ orphans: [], remoteRefsLeft: [], unauthorizedUnlabels: [], quarantined: [] });
  const records = ctx.records.all();
  const actions = [];
  for (const record of records) {
    try { actions.push(await recoverOne(ctx, record)); }
    catch (e) {
      ctx.log?.(`issue ${record.issue}: recovery error ${e.code ?? e.message}`);
      actions.push({ action: 'error', issue: record.issue, code: e.code ?? 'recovery-error', message: String(e.message).slice(0, 200) });
    }
  }
  actions.push(...await orphanBranches(ctx, records));
  return { actions };
}
