// §6.0a revalidation (AC 82) and the shaped-ticket cache (AC 18/39).
//
// Immediately before step 1 and again immediately before dispatch the issue is
// re-read: a changed `updatedAt`, a STOP label, a closed state or a new open
// PR for the branch ends the run with `revalidation-changed` and zero effects.
// Before dispatch the credential margin is re-checked as well (§6.4 item 14).

import { validateIssueNumber, branchFor } from './input.mjs';
import { STOP_LABELS } from './labels.mjs';
import { newRecord } from './records.mjs';
import { tokenMarginFor } from './token-refresh.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['revalidate.ignoreUpdatedAt', 'revalidate.ignoreOpenPr']);

const changed = (code, detail = null) => ({ ok: false, code: 'revalidation-changed', reason: code, detail });

export async function revalidate({ ctx, issue, revision = null, beforeDispatch = false, wallClockMs = null }) {
  const n = validateIssueNumber(issue);
  let doc;
  try { doc = await ctx.gh.json(['issue', 'view', String(n), '--json', 'state,updatedAt,labels,title,body']); }
  catch (e) { return changed('issue-unreadable', e.message); }
  if (String(doc?.state ?? '').toUpperCase() !== 'OPEN') return changed('issue-closed', String(doc?.state ?? ''));
  const names = (Array.isArray(doc?.labels) ? doc.labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  const stop = names.find((l) => STOP_LABELS.includes(l));
  if (stop) return changed(`label:${stop}`);
  if (!active('revalidate.ignoreUpdatedAt') && revision?.updatedAt && doc.updatedAt !== revision.updatedAt) return changed('issue-updated', `${revision.updatedAt} → ${doc.updatedAt}`);
  if (!active('revalidate.ignoreOpenPr')) {
    let prs;
    try { prs = await ctx.gh.json(['pr', 'list', '--head', branchFor(n), '--state', 'open', '--json', 'number']); }
    catch (e) { return changed('pr-list-unreadable', e.message); }
    // The run's OWN pull request (opened by §6.8, being fixed by §6.9) is not "a new open PR".
    const own = ctx.records.load(n)?.prNumber ?? null;
    const foreign = (Array.isArray(prs) ? prs : []).filter((p) => p?.number !== own);
    if (foreign.length) return changed('open-pr', `#${foreign[0].number}`);
  }
  if (beforeDispatch) {
    const margin = tokenMarginFor({ ctx, wallClockMs: wallClockMs ?? (ctx.config?.autopilot?.wallClockMinutes ?? 90) * 60_000 });
    if (margin.tokenShort) return { ok: false, code: 'token-expiring', reason: 'token-expiring', detail: margin.reason };
  }
  return { ok: true };
}

/** After PROCEED, when the quota refuses before dispatch: keep the shaped ticket in the run record (state `shaped`). */
export function cacheShapedTicket({ ctx, issue, ticket, revision = null }) {
  const n = validateIssueNumber(issue);
  const cur = ctx.records.load(n);
  if (cur) return ctx.records.update(n, { state: 'shaped', ticketCache: ticket, issueRevision: revision ?? cur.issueRevision ?? null });
  const rec = newRecord({ issue: n, token: ctx.iterationToken, baseOid: ctx.baseOid, branch: branchFor(n), stagingBranch: null, stagingPath: null, finalPath: ctx.paths.issueWorktree(n), issueRevision: revision, ticketCache: ticket });
  return ctx.records.save({ ...rec, state: 'shaped', creationPhase: null });
}
