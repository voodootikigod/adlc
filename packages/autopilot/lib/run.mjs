// The run (spec §6, §7, §6.10): one issue → one ticket → one branch → one PR.
//
//   0  pinned baseline (already resolved by the loop)      §6.0
//   0a revalidation                                          §6.0a
//   1  staged creation of ISSUE_WT + branch, npm ci          §6.1
//   2  ticket write (signed), ticketSnapshotSha256           §6.2
//   3  P0/P1 evidence (coldstart answer, spec-lint record)   §6.3
//   4  fleet dispatch (bounded, mirror, allowlist egress)    §6.4
//   5  ff + outer-gate integrity + actual-diff check         §6.5, §6.5b, §6.5a
//   6  outer gates in sandboxed per-gate clones              §6.6
//   6a ticket completion                                     §6.6a
//   7  size gate → final review → attest                     §6.7
//   8  verify → push → verify → PR upsert                    §6.8
//   9  CI follow-up                                          §6.9
//
// Every step's world-effect is preceded by the record write that names it, and
// every failure routes through ONE outcome mapping (`outcomeFor`, §6.10). All
// collaborators arrive through `deps`; this module holds the ORDER and the
// budgets, nothing else.

import { validateIssueNumber, validateOid, branchFor } from './input.mjs';
import { REASON_CODES_FLEET, FLEET_BLOCKING_REASONS } from './fleet-args.mjs';
import { buildFleetArgv } from './fleet-args.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['run.skipRevalidation', 'run.skipDiffCheckBeforePush', 'run.retryOnMirrorFetchFailed', 'run.acceptUnknownReason', 'run.budgetNotGlobal']);

export const BLOCKING_REASONS = FLEET_BLOCKING_REASONS;

/** Remaining build budget (§7): strikes and wall clock are ONE counter each per run. */
export function remainingBudget(record, config) {
  const strikes = Math.max(0, config.maxRounds - (record.roundsUsed ?? 0));
  const wallClockMs = Math.max(0, config.wallClockMinutes * 60_000 - (record.wallClockUsedMs ?? 0));
  return { strikes, wallClockMinutes: Math.floor(wallClockMs / 60_000), wallClockMs };
}

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

/**
 * Drive one issue through §6. `deps` is the composed module set (see
 * lib/context.mjs): create, evidence, dispatch, diffcheck, gates, review, push,
 * ci, effects, quota, mirror, deps(npm), retire.
 */
export async function runIssue({ ctx, deps, issue, ticket, revision, authorization }) {
  const n = validateIssueNumber(issue);
  const cfg = ctx.config.autopilot;
  const log = ctx.log;

  // §6.0a — revalidation immediately before step 1.
  if (!active('run.skipRevalidation')) {
    const rv = await deps.revalidate({ ctx, issue: n, revision, authorization });
    if (!rv.ok) return { state: 'dropped', reason: 'revalidation-changed', detail: rv.detail };
  }

  // §6.1 — staged creation (journaled) + npm ci.
  const created = await deps.create.createIssueWorktree({ ctx, issue: n, baseOid: ctx.baseOid });
  if (!created.ok) return { state: created.state ?? 'orphan', reason: created.code };
  const record = () => ctx.records.load(n);
  const issueWt = ctx.paths.issueWorktree(n);
  const branch = branchFor(n);

  // §6.2 — the signed ticket write + §6.3 evidence.
  const written = await deps.create.writeTicket({ ctx, issue: n, ticket });
  const ticketId = written.ticketId;
  ctx.records.update(n, { ticketId, ticketSnapshotSha256: written.ticketSnapshotSha256, specBlob: written.specBlob ?? null });
  const evidence = await deps.create.recordEvidence({ ctx, issue: n, ticketId });
  if (evidence.verdict === 'CLARIFY') {
    await deps.triage.clarifyEffects({ ctx, issue: n, sentinel: evidence.sentinel, body: evidence.body });
    await deps.retire.retireRun({ ctx, record: record() });
    return { state: 'clarify', reason: 'coldstart-gaps' };
  }

  // The worker mirror + worker-deps are built once per run, before dispatch.
  const mirror = await deps.mirror.createWorkerMirror({ ctx, issue: n });
  const workerDeps = await deps.deps.buildWorkerDeps({ ctx, issue: n, baseOid: ctx.baseOid });
  if (!workerDeps.ok) return await fail(n, 'init-failed', workerDeps.detail);

  // §6.4–§6.8 rounds under ONE global budget (§7).
  let deadEndFile = null;
  for (;;) {
    const rec = record();
    const budget = remainingBudget(rec, cfg);
    if (budget.strikes === 0 || budget.wallClockMinutes === 0) return await block(n, 'strikes-exhausted', 'build budget exhausted', deadEndFile);

    // §6.0a again immediately before dispatch (+ token margin).
    if (!active('run.skipRevalidation')) {
      const rv = await deps.revalidate({ ctx, issue: n, revision, authorization, beforeDispatch: true });
      if (!rv.ok) { await deps.retire.retireRun({ ctx, record: rec }); return { state: 'dropped', reason: rv.code ?? 'revalidation-changed' }; }
    }
    if (rec.completedOnce) await deps.review.reopenTicket({ ctx, cwd: issueWt, ticketId, round: (rec.roundsUsed ?? 0) + 1 });

    // §6.4 — dispatch fleet from inside ISSUE_WT.
    const argv = buildFleetArgv({ ctx, issue: n, ticketId, budget, deadEndFile, mirror: mirror.path, workerDeps: workerDeps.nodeModules });
    ctx.records.update(n, { state: 'dispatched', integrationStart: ctx.git.localOut(issueWt, ['rev-parse', branch]), fleetArgv: argv });
    const started = ctx.now();
    const fleet = await deps.dispatch({ ctx, issue: n, argv, cwd: issueWt, deadlineMs: budget.wallClockMs + 5 * 60_000 });
    ctx.records.update(n, { wallClockUsedMs: (rec.wallClockUsedMs ?? 0) + (ctx.now() - started), roundsUsed: (rec.roundsUsed ?? 0) + (fleet.parsed?.strikesConsumed ?? 1), fleetRunId: fleet.parsed?.fleetRunId ?? rec.fleetRunId ?? null, lastFleetResult: fleet.parsed ?? null });
    if (rec.fleetRunId && fleet.parsed?.fleetRunId && fleet.parsed.fleetRunId !== rec.fleetRunId) return await block(n, 'resume-refused', `fleetRunId ${fleet.parsed.fleetRunId} != ${rec.fleetRunId}`);
    if (fleet.resumeRefused) return await block(n, 'resume-refused', fleet.detail);
    if (fleet.parsed && (fleet.parsed.readPolicy !== 'bounded' || fleet.parsed.gitSource !== 'mirror' || fleet.parsed.egress !== 'allowlist')) return await block(n, 'sandbox-policy-mismatch', JSON.stringify({ readPolicy: fleet.parsed.readPolicy, gitSource: fleet.parsed.gitSource, egress: fleet.parsed.egress }));
    const outcome = outcomeFor(fleet);
    if (outcome.state === 'quota-paused') { ctx.records.update(n, { state: 'quota-paused' }); return { state: 'quota-paused', reason: 'quota-paused' }; }
    if (outcome.skipped) return { state: 'skipped', reason: 'lock-held' };
    if (outcome.state === 'unchanged') { ctx.records.update(n, { lastError: outcome.error }); return { state: 'unchanged', reason: outcome.error }; }
    if (outcome.state === 'blocked') return await block(n, outcome.reason, fleet.parsed?.tickets ? JSON.stringify(fleet.parsed.tickets) : '', null, fleet.findingsText);

    // §6.5 — ff the issue branch to the integration tip.
    ctx.records.update(n, { state: 'built' });
    const ff = await deps.gates.fastForward({ ctx, issue: n, branch, integrationBranch: fleet.parsed.integrationBranch });
    if (!ff.ok) return await fail(n, 'ff-not-fast-forward', ff.detail);
    ctx.records.update(n, { localHead: ff.head });

    // §6.5b — outer-gate environment integrity + dependency checks.
    const integrity = await deps.deps.outerGateIntegrity({ ctx, issue: n, baseOid: ctx.baseOid, head: ff.head, allowed: cfg.allowedWorkspaceDeps });
    if (!integrity.ok) { deadEndFile = await deps.deadEnd({ ctx, issue: n, text: `${integrity.code}: ${integrity.detail}` }); await bumpRound(n); continue; }

    // §6.5a — actual-diff check (before any outer gate).
    const dc = await deps.diffcheck.actualDiffCheck({ ctx, issue: n, record: record(), baseOid: ctx.baseOid, head: ff.head, scope: ticket.scope, ticketId });
    if (!dc.ok) {
      if (dc.code === 'secret-in-diff') return await block(n, 'secret-in-diff', dc.summary, null, dc.summary);
      deadEndFile = await deps.deadEnd({ ctx, issue: n, text: `${dc.code}: ${(dc.paths ?? []).join('\n')}` }); await bumpRound(n); continue;
    }

    // §6.6a — completion (the last content commit), then the gate mirror.
    await deps.review.completeTicket({ ctx, cwd: issueWt, ticketId });
    ctx.records.update(n, { completedOnce: true, localHead: ctx.git.localOut(issueWt, ['rev-parse', 'HEAD']) });

    // §6.7a — size gate → final review → §6.7b attest → §6.7c commit.
    const size = await deps.review.sizeGate({ ctx, cwd: issueWt, baseOid: ctx.baseOid });
    if (!size.ok) {
      const consecutive = (record().diffTooLarge ?? 0) + 1;
      ctx.records.update(n, { diffTooLarge: consecutive });
      if (consecutive >= 2) return await block(n, 'diff-too-large', size.detail);
      deadEndFile = await deps.deadEnd({ ctx, issue: n, text: `diff-too-large: ${size.detail}` }); await bumpRound(n); continue;
    }
    ctx.records.update(n, { diffTooLarge: 0 });
    const review = await deps.review.finalReview({ ctx, issue: n, cwd: issueWt, baseOid: ctx.baseOid });
    if (review.verdict === 'unavailable') { deadEndFile = await deps.deadEnd({ ctx, issue: n, text: 'review-unavailable' }); await bumpRound(n); continue; }
    if (review.verdict !== 'approve') { deadEndFile = await deps.deadEnd({ ctx, issue: n, text: review.findingsText ?? '' }); await bumpRound(n); continue; }
    ctx.records.update(n, { reviewedHead: review.reviewedHead });
    let attested;
    try { attested = await deps.review.attest({ ctx, cwd: issueWt, ticketId, baseOid: ctx.baseOid, reviewedHead: review.reviewedHead }); }
    catch (e) { return await mismatch(n, e.message); }
    ctx.records.update(n, { state: 'attested', attestedHead: attested.attestedHead, localHead: attested.attestedHead });

    // §6.6 — the outer gates run on the ATTESTED tree in per-gate clones.
    const gateMirror = await deps.mirror.createGateMirror({ ctx, issue: n, attestedHead: attested.attestedHead, baseOid: ctx.baseOid });
    if (!gateMirror.ok) return await fail(n, gateMirror.code, gateMirror.detail);
    const gateDeps = await deps.deps.installGateDeps({ ctx, issue: n, attestedHead: attested.attestedHead });
    if (!gateDeps.ok) return await fail(n, gateDeps.code, gateDeps.detail);
    const gates = await deps.gates.runOuterGates({ ctx, issue: n, attestedHead: attested.attestedHead, baseOid: ctx.baseOid, gateDepsNodeModules: gateDeps.nodeModules });
    if (!gates.ok) {
      if (gates.code === 'gate-repo-moved' || gates.code === 'preflight-order-drift') return await fail(n, gates.code, gates.detail);
      deadEndFile = await deps.deadEnd({ ctx, issue: n, text: gates.log ?? gates.detail ?? 'gate failed' }); await bumpRound(n); continue;
    }

    // §6.8 — verify → push → verify → PR upsert.
    if (!active('run.skipDiffCheckBeforePush')) {
      const again = await deps.diffcheck.actualDiffCheck({ ctx, issue: n, record: record(), baseOid: ctx.baseOid, head: attested.attestedHead, scope: ticket.scope, ticketId });
      if (!again.ok) return await mismatch(n, `actual-diff check failed before push: ${again.code}`);
    }
    const pushed = await deps.push.verifyPushVerify({ ctx, issue: n, record: record(), attestedHead: attested.attestedHead });
    if (!pushed.ok) return await mismatch(n, pushed.detail);
    const pr = await deps.push.upsertPr({ ctx, issue: n, record: record(), attestedHead: attested.attestedHead, title: deps.push.prTitle({ issue: n, ticket }), body: deps.push.prBody({ issue: n, ticketId, attest: attested, review, quota: ctx.status.read()?.quota ?? null, baseOid: ctx.baseOid }) });
    if (!pr.ok) return await mismatch(n, pr.detail, pr.prNumber);
    ctx.records.update(n, { state: 'ci-watch', prNumber: pr.prNumber });
    await deps.cleanupWorktree({ ctx, issue: n });
    // §6.9 — CI follow-up.
    const ci = await deps.ci.watchCi({ ctx, record: record(), attestedHead: attested.attestedHead, budgetMs: cfg.ciWatchMinutes * 60_000 });
    return { state: ci.state, reason: ci.reason ?? null, prNumber: pr.prNumber };
  }

  async function bumpRound(issueNumber) {
    const r = ctx.records.load(issueNumber);
    if (!active('run.budgetNotGlobal')) ctx.records.update(issueNumber, { roundsUsed: (r.roundsUsed ?? 0) + 1 });
  }
  async function block(issueNumber, reason, detail, deadEnd = null, findings = null) {
    ctx.records.update(issueNumber, { state: 'blocked', reasonText: `${reason}: ${detail ?? ''}` });
    const body = findings ?? detail ?? reason;
    await deps.effects.applyTerminalEffects({ ctx, record: ctx.records.load(issueNumber), outcome: 'blocked', target: { kind: 'issue', number: issueNumber }, sentinel: `<!-- adlc-autopilot:blocked ${reason} -->`, body: `Autopilot blocked (${reason}).\n\n${body}`, label: 'adlc:autopilot-blocked' });
    log(`issue ${issueNumber} blocked: ${reason}`);
    return { state: 'blocked', reason, deadEnd };
  }
  async function fail(issueNumber, code, detail) {
    ctx.records.update(issueNumber, { lastError: `${code}: ${detail ?? ''}` });
    log(`issue ${issueNumber} run failed: ${code}`);
    return { state: 'failed', reason: code, exitCode: 1 };
  }
  async function mismatch(issueNumber, detail, prNumber = null) {
    const rec = ctx.records.load(issueNumber);
    ctx.records.update(issueNumber, { state: 'oid-mismatch', reasonText: `oid-mismatch: ${detail ?? ''}` });
    const target = prNumber != null || rec.prNumber != null ? { kind: 'pr', number: prNumber ?? rec.prNumber } : { kind: 'issue', number: issueNumber };
    await deps.effects.applyTerminalEffects({ ctx, record: ctx.records.load(issueNumber), outcome: 'oid-mismatch', target, sentinel: '<!-- adlc-autopilot:oid-mismatch -->', body: `Autopilot quarantined this run: oid-mismatch. ${detail ?? ''}`, label: 'adlc:autopilot-blocked' });
    return { state: 'oid-mismatch', reason: 'oid-mismatch' };
  }
}

export { validateOid };
