// One build/fix ROUND (spec §6.4–§6.7) and the push/upsert step (§6.8) as
// reusable steps: the initial run, every CI fix round (§6.9) and the
// maintenance conflict-fix round (§8) all execute exactly this sequence.
//
//   dispatch → ff → dependency/ignored-file integrity → actual-diff check →
//   gate mirror + gate deps → outer gates → completion → size gate + final
//   review → attest                                          (round)
//   actual-diff check again → verify-push-verify → PR upsert (pushAndOpen)
//
// Each step's failure maps to ONE of three shapes: `retry` (dead-end material
// for the next round), `terminal` (a §6.10 outcome already recorded), or
// `attested` (the round produced an attested head).

import { validateIssueNumber, branchFor } from './input.mjs';
import { REASON_CODES_FLEET, buildFleetArgv } from './fleet-args.mjs';
import { describeSecretHits } from './diffcheck.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['run.skipRevalidation', 'run.skipDiffCheckBeforePush', 'run.retryOnMirrorFetchFailed', 'run.acceptUnknownReason', 'run.budgetNotGlobal', 'run.skipFastForward',
  'run.chargeAfterDispatch',
  'run.staleEvidenceOnRetry',
]);

/** Gate failures that are the ENVIRONMENT's, never the worker's: no retry can fix them. */
export const GATE_ENVIRONMENT_CODES = Object.freeze(['gate-repo-moved', 'preflight-order-drift', 'sandbox-unavailable', 'gate-deps-missing', 'gate-repo-stale', 'remote-url-changed', 'base-object-missing']);

/**
 * §6.10 — the fleet result's `reason` is authoritative over its exit code.
 * Returns { state, effect } for the run record.
 */
export function outcomeFor(fleetResult) {
  const { exitCode, reason, parsed } = fleetResult;
  if (!parsed) return { state: 'unchanged', effect: 'none', error: 'fleet-result-unparseable' };
  if (exitCode === 0) return { state: 'built', effect: 'none' };
  if (exitCode === 1) return { state: 'unchanged', effect: 'none', error: reason ?? 'fleet-exit-1' };
  if (exitCode === 2) {
    if (!REASON_CODES_FLEET.includes(reason)) {
      if (active('run.acceptUnknownReason')) return { state: 'blocked', effect: 'label' };
      return { state: 'unchanged', effect: 'none', error: `fleet-reason-unknown:${reason}` };
    }
    if (reason === 'quota-paused') return { state: 'quota-paused', effect: 'none' };
    if (reason === 'lock-held') return { state: 'unchanged', effect: 'none', skipped: 'lock-held' };
    return { state: 'blocked', effect: 'label', reason };
  }
  return { state: 'unchanged', effect: 'none', error: `fleet-exit-${exitCode}` };
}

/** Coldstart gaps → CLARIFY findings (one `coldstart` gate entry per gap). */
export function gapsToFindings(gaps) {
  const list = Array.isArray(gaps) ? gaps : [gaps];
  return list.map((g) => ({ gate: 'coldstart', detail: typeof g === 'string' ? g : JSON.stringify(g) }));
}

function gateFailureText(gates) {
  const rows = (gates.gates ?? []).map((g) => `=== ${g.name} (${g.status ?? 'n/a'}${g.timedOut ? ', timed out' : ''})\n${g.output ?? ''}`);
  return `${gates.code}${gates.gate ? ` at ${gates.gate}` : ''}${gates.reason ? `: ${gates.reason}` : ''}\n${rows.join('\n')}`.trim();
}

/**
 * The step set bound to one run. `ticket` is the shaped ticket (scope drives
 * the actual-diff check); `mirror`/`workerDeps` are the per-run artifacts.
 */
export function createRunSteps({ ctx, deps, issue, ticket, ticketId, mirror, workerDeps, revision = null, authorization = null }) {
  const n = validateIssueNumber(issue);
  const cfg = ctx.config.autopilot;
  const log = ctx.log;
  const branch = branchFor(n);
  const issueWt = ctx.paths.issueWorktree(n);
  const record = () => ctx.records.load(n);
  const headOf = () => ctx.git.localOut(issueWt, ['rev-parse', 'HEAD']);

  // ---- terminal outcomes (§6.10) ----
  async function block(reason, detail, deadEnd = null, findings = null) {
    ctx.records.update(n, { state: 'blocked', reasonText: `${reason}: ${detail ?? ''}` });
    const body = findings ?? detail ?? reason;
    await deps.effects.applyTerminalEffects({ ctx, record: record(), outcome: 'blocked', target: { kind: 'issue', number: n }, sentinel: `<!-- adlc-autopilot:blocked ${reason} -->`, body: `Autopilot blocked (${reason}).\n\n${body}`, label: 'adlc:autopilot-blocked' });
    log(`issue ${n} blocked: ${reason}`);
    return { state: 'blocked', reason, deadEnd };
  }
  function failed(code, detail, state = 'failed') {
    if (record()) ctx.records.update(n, { lastError: `${code}: ${detail ?? ''}`, ...(state === 'orphan' ? { state: 'orphan' } : {}) });
    log(`issue ${n} run ${state}: ${code}`);
    return { state, reason: code, exitCode: 1, detail: detail ?? null };
  }
  async function mismatch(detail, prNumber = null) {
    const rec = record();
    ctx.records.update(n, { state: 'oid-mismatch', reasonText: `oid-mismatch: ${detail ?? ''}` });
    const target = prNumber != null || rec?.prNumber != null ? { kind: 'pr', number: prNumber ?? rec.prNumber } : { kind: 'issue', number: n };
    await deps.effects.applyTerminalEffects({ ctx, record: record(), outcome: 'oid-mismatch', target, sentinel: '<!-- adlc-autopilot:oid-mismatch -->', body: `Autopilot quarantined this run: oid-mismatch. ${detail ?? ''}`, label: 'adlc:autopilot-blocked' });
    return { state: 'oid-mismatch', reason: 'oid-mismatch' };
  }
  const terminal = (result) => ({ status: 'terminal', result });
  async function retry(text) {
    const deadEndFile = await deps.deadEnd({ ctx, issue: n, text });
    return { status: 'retry', deadEndFile };
  }

  /** §6.5 — fast-forward the issue branch (checked out in ISSUE_WT) to fleet's integration tip. */
  async function fastForward(integrationBranch) {
    if (typeof integrationBranch !== 'string' || !integrationBranch.startsWith('fleet/')) return { ok: false, detail: `no integration branch in the fleet result (${integrationBranch})` };
    const tipRes = await ctx.git.local(issueWt, ['rev-parse', '--verify', `${integrationBranch}^{commit}`]);
    if (tipRes.status !== 0) return { ok: false, detail: `${integrationBranch} is not a commit in the caller repository` };
    const tip = tipRes.stdout.trim();
    const anc = await ctx.git.local(issueWt, ['merge-base', '--is-ancestor', branch, tip]);
    if (anc.status !== 0) return { ok: false, detail: `${branch} is not an ancestor of ${integrationBranch}` };
    const merge = await ctx.git.local(issueWt, ['merge', '--ff-only', tip]);
    if (merge.status !== 0) return { ok: false, detail: `ff-only merge failed: ${String(merge.stderr ?? '').trim().slice(0, 300)}` };
    return { ok: true, head: tip };
  }

  /**
   * One round. `budget` = { strikes, wallClockMinutes, wallClockMs };
   * `chargeGlobal` books the round against the run's §7 budget (false for CI
   * fix rounds and maintenance, which carry their own).
   */
  async function round({ budget, deadEndFile = null, chargeGlobal = true }) {
    const rec = record();
    // §6.0a again immediately before dispatch (+ the credential margin).
    if (!active('run.skipRevalidation')) {
      const rv = await deps.revalidate({ ctx, issue: n, revision, authorization, beforeDispatch: true, wallClockMs: budget.wallClockMs });
      if (!rv.ok) {
        if (rv.code === 'token-expiring') return terminal({ state: 'token-expiring', reason: 'token-expiring', detail: rv.detail });
        await deps.retire.retireRun({ ctx, record: record() });
        return terminal({ state: 'dropped', reason: rv.code ?? 'revalidation-changed', detail: rv.detail ?? rv.reason ?? null });
      }
    }
    if (rec.completedOnce) {
      let reopened;
      try { reopened = await deps.review.reopenTicket({ ctx, cwd: issueWt, ticketId, round: (rec.roundsUsed ?? 0) + 1, issue: n }); }
      catch (e) { return terminal(failed(e.code ?? 'reopen-failed', e.message)); }
      // The reopened ticket is a NEW ticket text (its hash changed): the P2 evidence is re-recorded
      // for it before dispatch (codex r3 B5). Mutation seam `run.staleEvidenceOnRetry`: the old evidence stands.
      if (reopened?.reopened && !active('run.staleEvidenceOnRetry')) {
        try {
          const evidence = await deps.create.recordEvidence({ ctx, issue: n, ticketId, ticket });
          if (evidence?.verdict === 'CLARIFY') return terminal(failed('coldstart-gaps', 'the reopened ticket has executability gaps'));
        } catch (e) {
          if (e.code === 'quota-gated') return terminal({ state: 'quota-paused', reason: 'quota-paused', detail: 'quota refused the retry coldstart' });
          return terminal(failed(e.code ?? 'evidence-failed', e.message));
        }
      }
    }

    // §6.4 — dispatch fleet from inside ISSUE_WT.
    const argv = buildFleetArgv({ ctx, issue: n, ticketId, budget, deadEndFile, mirror, workerDeps });
    const started = ctx.now();
    const charge = chargeGlobal && !active('run.budgetNotGlobal');
    // The round is booked against the §7 budget BEFORE the dispatch (one round, clock running from
    // `roundStartedAt`) so a crash mid-dispatch cannot hand the next process a fresh budget
    // (codex r3 B4); the settlement below replaces the provisional charge with the actual one.
    // Mutation seam `run.chargeAfterDispatch`: the budget is charged only when the dispatch returns.
    const provisional = charge && !active('run.chargeAfterDispatch') ? { roundsUsed: (rec.roundsUsed ?? 0) + 1, roundStartedAt: started } : {};
    ctx.records.update(n, { state: 'dispatched', integrationStart: await ctx.git.localOut(issueWt, ['rev-parse', branch]), fleetArgv: argv, ...provisional });
    const fleet = await deps.dispatch({ ctx, issue: n, argv, cwd: issueWt, deadlineMs: budget.wallClockMs + 5 * 60_000 });
    const elapsed = ctx.now() - started;
    const strikes = Math.max(1, Number(fleet.parsed?.strikesConsumed) || 1);
    ctx.records.update(n, {
      fleetRunId: fleet.parsed?.fleetRunId ?? rec.fleetRunId ?? null, lastFleetResult: fleet.parsed ?? null, roundStartedAt: null,
      ...(charge ? { wallClockUsedMs: (rec.wallClockUsedMs ?? 0) + elapsed, roundsUsed: (rec.roundsUsed ?? 0) + strikes } : {}),
    });
    // A PAUSED run (quota / wall clock) must resume as the same fleet run: a fresh
    // fleetRunId after a pause means fleet silently restarted instead of resuming.
    const paused = rec.lastFleetResult?.reason === 'quota-paused' || rec.lastFleetResult?.reason === 'wall-clock';
    if (paused && rec.fleetRunId && fleet.parsed?.fleetRunId && fleet.parsed.fleetRunId !== rec.fleetRunId) return terminal(await block('resume-refused', `fleetRunId ${fleet.parsed.fleetRunId} != ${rec.fleetRunId}`));
    if (fleet.resumeRefused) return terminal(await block('resume-refused', fleet.detail));
    if (fleet.parsed && fleet.exitCode === 0 && (fleet.parsed.readPolicy !== 'bounded' || fleet.parsed.gitSource !== 'mirror' || fleet.parsed.egress !== 'allowlist')) {
      return terminal(await block('sandbox-policy-mismatch', JSON.stringify({ readPolicy: fleet.parsed.readPolicy, gitSource: fleet.parsed.gitSource, egress: fleet.parsed.egress })));
    }
    const outcome = outcomeFor(fleet);
    if (outcome.state === 'quota-paused') { ctx.records.update(n, { state: 'quota-paused' }); return terminal({ state: 'quota-paused', reason: 'quota-paused' }); }
    if (outcome.skipped) return terminal({ state: 'skipped', reason: 'lock-held' });
    if (outcome.state === 'unchanged') { ctx.records.update(n, { lastError: outcome.error }); return terminal({ state: 'unchanged', reason: outcome.error }); }
    if (outcome.state === 'blocked') {
      if (outcome.reason === 'mirror-fetch-failed' && active('run.retryOnMirrorFetchFailed')) return retry('mirror-fetch-failed');
      return terminal(await block(outcome.reason, fleet.parsed?.tickets ? JSON.stringify(fleet.parsed.tickets) : '', null, fleet.findingsText));
    }

    // §6.5 — ff the issue branch to the integration tip.
    ctx.records.update(n, { state: 'built' });
    // Mutation seam `run.skipFastForward`: the issue branch is never advanced to the integration tip.
    const ff = active('run.skipFastForward') ? { ok: true, head: await headOf() } : await fastForward(fleet.parsed.integrationBranch);
    if (!ff.ok) return terminal(failed('ff-not-fast-forward', ff.detail));
    ctx.records.update(n, { localHead: ff.head });

    // §6.5b — outer-gate environment integrity (dependency + ignored-file drift).
    const dd = await deps.deps.dependencyDiffCheck({ ctx, issue: n, baseOid: ctx.baseOid, head: ff.head, allowed: cfg.allowedWorkspaceDeps ?? [] });
    if (!dd.ok) return retry(`${dd.code}: ${dd.detail ?? ''}`);
    const ig = await deps.deps.checkIgnoredFiles({ ctx, issue: n });
    if (!ig.ok) return retry(`${ig.code}:\n${(ig.paths ?? []).join('\n')}`);

    // §6.5a — actual-diff check (before any outer gate).
    const dc = await deps.diffcheck.actualDiffCheck({ ctx, issue: n, record: record(), baseOid: ctx.baseOid, head: ff.head, scope: ticket.scope, ticketId });
    if (!dc.ok) {
      if (dc.code === 'secret-in-diff') { const summary = describeSecretHits(dc.secretHits ?? []); return terminal(await block('secret-in-diff', summary, null, summary)); }
      return retry(`${dc.code}:\n${(dc.paths ?? []).join('\n')}`);
    }

    return attestTail({ head: ff.head, completed: false });
  }

  /**
   * The tail of a round from an integrated head: completion (unless the ticket
   * is already complete on this head), size gate + final review, attest, gate
   * mirror + gate deps, outer gates. Shared with the maintenance retry round.
   */
  async function attestTail({ head, completed = false, reason = null }) {
    // §6.6 — the outer gates run on the INTEGRATED head in per-gate clones of a
    // gate mirror holding exactly that head and BASE_OID (spec step 6).
    let gateDeps;
    try {
      await deps.mirror.createGateMirror({ ctx, issue: n, attestedHead: head, baseOid: ctx.baseOid });
      gateDeps = await deps.deps.installGateDeps({ ctx, issue: n, attestedHead: head });
    } catch (e) { return terminal(failed(e.code ?? 'gate-setup-failed', e.message)); }
    const gates = await deps.gates.runOuterGates({ ctx, issue: n, attestedHead: head, baseOid: ctx.baseOid, gateDepsNodeModules: gateDeps });
    if (!gates.ok) {
      if (GATE_ENVIRONMENT_CODES.includes(gates.code)) return terminal(failed(gates.code, gates.reason ?? gates.detail ?? null));
      return retry(gateFailureText(gates));
    }

    // §6.6a — completion: the last content commit of the round (a rebased head keeps its completion commit).
    if (!completed) {
      try { await deps.review.completeTicket({ ctx, cwd: issueWt, ticketId, issue: n }); }
      catch (e) { return terminal(failed(e.code ?? 'ticket-complete-failed', e.message)); }
    }
    ctx.records.update(n, { completedOnce: true, localHead: await headOf() });

    // §6.7a — size gate → final review; §6.7b attest — on the exact tree that is pushed.
    let rr;
    try { rr = await deps.review.reviewRound({ ctx, issue: n, cwd: issueWt, baseOid: ctx.baseOid, record: record() }); }
    catch (e) { return terminal(e.code === 'oid-mismatch' ? await mismatch(e.message) : failed(e.code ?? 'review-failed', e.message)); }
    if (!rr.ok) {
      if (rr.code === 'blocked') return terminal(await block('diff-too-large', rr.reason, null, rr.deadEnd ?? null));
      return retry(rr.deadEnd ?? rr.reason ?? rr.code);
    }
    ctx.records.update(n, { reviewedHead: rr.reviewedHead });
    let attested;
    try { attested = await deps.review.attest({ ctx, cwd: issueWt, ticketId, baseOid: ctx.baseOid, reviewedHead: rr.reviewedHead, issue: n }); }
    catch (e) { return terminal(e.code === 'oid-mismatch' ? await mismatch(e.message) : failed(e.code ?? 'attest-failed', e.message)); }
    ctx.records.update(n, { state: 'attested', attestedHead: attested.attestedHead, attestRevision: attested.revision ?? null, localHead: attested.attestedHead, ...(reason ? { lastError: `retry: ${reason}` } : {}) });
    return { status: 'attested', attested, review: rr };
  }

  /** §6.8 — verify → push → verify → PR upsert. */
  async function pushAndOpen({ attested, review }) {
    if (!active('run.skipDiffCheckBeforePush')) {
      const again = await deps.diffcheck.actualDiffCheck({ ctx, issue: n, record: record(), baseOid: ctx.baseOid, head: attested.attestedHead, scope: ticket.scope, ticketId });
      if (!again.ok) return terminal(await mismatch(`actual-diff check failed before push: ${again.code}`));
    }
    const pushed = await deps.push.verifyPushVerify({ ctx, issue: n, record: record(), attestedHead: attested.attestedHead });
    if (!pushed.ok) return terminal(pushed.state === 'orphan' ? failed(pushed.code, pushed.detail, 'orphan') : await mismatch(pushed.detail));
    let pr;
    try {
      pr = await deps.push.upsertPr({
        ctx, issue: n, record: record(), attestedHead: attested.attestedHead,
        title: deps.push.prTitle({ issue: n, ticket }),
        body: deps.push.prBody({ issue: n, ticketId, attest: attested, review, quota: ctx.status.read()?.quota ?? null, baseOid: ctx.baseOid, rounds: record().roundsUsed ?? 0 }),
      });
    } catch (e) { return terminal(failed(e.code ?? 'pr-upsert-failed', e.message)); }
    if (!pr.ok) return terminal(await mismatch(pr.detail, pr.prNumber ?? null));
    ctx.records.update(n, { state: 'ci-watch', prNumber: pr.prNumber, prState: 'OPEN' });
    return { status: 'ok', prNumber: pr.prNumber, pushedOid: pushed.pushedOid };
  }

  return { round, attestTail, pushAndOpen, block, failed, mismatch, fastForward, record };
}
