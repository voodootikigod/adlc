// The run (spec §6, §7, §6.10): one issue → one ticket → one branch → one PR.
//
//   0a revalidation                                          §6.0a
//   1  staged creation of ISSUE_WT + branch, npm ci          §6.1
//   2  ticket write (signed), ticketSnapshotSha256           §6.2
//   3  P0/P1 evidence (coldstart answer, spec-lint record)   §6.3
//   4–7 rounds under ONE global budget (lib/round.mjs)       §6.4–§6.7, §7
//   8  verify → push → verify → PR upsert                    §6.8
//   9  CI follow-up, each fix round = one more round          §6.9
//
// Every step's world-effect is preceded by the record write that names it, and
// every failure routes through ONE outcome mapping (§6.10). This module holds
// the ORDER and the budgets; the steps live in lib/round.mjs.

import { existsSync } from 'node:fs';
import { validateIssueNumber, validateOid } from './input.mjs';
import { FLEET_BLOCKING_REASONS } from './fleet-args.mjs';
import { createRunSteps, outcomeFor, gapsToFindings } from './round.mjs';
import { active } from './mutations.mjs';

export { outcomeFor };
export const BLOCKING_REASONS = FLEET_BLOCKING_REASONS;

/** Remaining build budget (§7): strikes and wall clock are ONE counter each per run. */
export function remainingBudget(record, config) {
  // Mutation seam `run.budgetNotGlobal`: rounds consumed by earlier phases are forgotten.
  const used = active('run.budgetNotGlobal') ? 0 : (record.roundsUsed ?? 0);
  const strikes = Math.max(0, config.maxRounds - used);
  const wallClockMs = Math.max(0, config.wallClockMinutes * 60_000 - (record.wallClockUsedMs ?? 0));
  return { strikes, wallClockMinutes: Math.floor(wallClockMs / 60_000), wallClockMs };
}

/** The CI outcome (§6.9) → the run's terminal result, with its effects applied. */
async function settleCi({ ctx, deps, steps, issue: n, ci, prNumber }) {
  switch (ci.outcome) {
    case 'done': return { state: 'done', reason: null, prNumber };
    case 'oid-mismatch': return { ...(await steps.mismatch(ci.comment, prNumber)), prNumber };
    case 'ci-red': case 'ci-incomplete': {
      ctx.records.update(n, { state: 'ci-red', reasonText: ci.comment ?? ci.outcome });
      await deps.effects.applyTerminalEffects({ ctx, record: ctx.records.load(n), outcome: 'ci-red', target: { kind: 'pr', number: prNumber }, sentinel: `<!-- adlc-autopilot:ci-red ${ci.outcome} -->`, body: ci.comment ?? ci.outcome, label: ci.label ?? 'adlc:autopilot-ci-red' });
      return { state: 'ci-red', reason: ci.outcome, prNumber, red: ci.red ?? [] };
    }
    case 'fix-round-failed': {
      const rec = ctx.records.load(n);
      return { state: rec?.state ?? 'ci-red', reason: ci.code ?? 'fix-round-failed', prNumber, round: ci.round ?? null };
    }
    default: return { state: 'ci-watch', reason: ci.outcome ?? 'ci-watch', prNumber };
  }
}

/** Recovery's run-owned actions (§2.1) → where the run continues. */
export const RESUME_ENTRY = Object.freeze({ 'resume-shaped': 'evidence', 'resume-dispatch': 'rounds', 'resume-attest': 'rounds', 'upsert-pr': 'push', 'evaluate-ci': 'ci' });
export const RESUME_ACTIONS = Object.freeze(Object.keys(RESUME_ENTRY));

/**
 * Drive one issue through §6 from the start: revalidation, staged creation,
 * then everything `continueRun` owns. `deps` is the composed module set.
 */
export async function runIssue({ ctx, deps, issue, ticket, revision = null, authorization = null }) {
  const n = validateIssueNumber(issue);
  const record = () => ctx.records.load(n);

  // §6.0a — revalidation immediately before step 1.
  if (!active('run.skipRevalidation')) {
    const rv = await deps.revalidate({ ctx, issue: n, revision, authorization });
    if (!rv.ok) return { state: 'dropped', reason: rv.code ?? 'revalidation-changed', detail: rv.detail ?? rv.reason ?? null };
  }

  // §6.1 — staged creation (journaled) + npm ci.
  try { await deps.create.createIssueWorktree({ ctx, issue: n, baseOid: ctx.baseOid, issueRevision: revision }); }
  catch (e) {
    const code = e.code ?? 'create-failed';
    if (record()) ctx.records.update(n, { lastError: `${code}: ${e.message}` });
    return { state: code.startsWith('orphan') ? 'orphan' : 'failed', reason: code, exitCode: 1, detail: e.message };
  }
  // The shaped ticket rides the record from here on: every resume path needs its scope.
  ctx.records.update(n, { ticketCache: ticket, issueRevision: revision ?? record()?.issueRevision ?? null });
  return continueRun({ ctx, deps, issue: n, ticket, revision, authorization, from: 'evidence' });
}

/**
 * Resume a run recovery classified (§2.1): `resume-shaped` (a cached ticket,
 * possibly without a worktree yet), `resume-dispatch`/`resume-attest` (a
 * created run whose rounds continue), `upsert-pr` (pushed, PR not bound yet)
 * and `evaluate-ci` (an open PR whose CI is still being watched).
 */
export async function resumeRun({ ctx, deps, action, issue }) {
  const n = validateIssueNumber(issue);
  const rec = ctx.records.load(n);
  const from = RESUME_ENTRY[action];
  if (!rec || !from) return { state: 'unchanged', reason: `not-resumable:${action}` };
  const ticket = rec.ticketCache;
  if (!ticket) { ctx.records.update(n, { lastError: 'resume: no cached ticket on the record' }); return { state: 'unchanged', reason: 'resume-no-ticket' }; }
  const revision = rec.issueRevision ?? null;
  const authorization = { ok: true, resumed: true };
  if (from === 'evidence' && !existsSync(ctx.paths.issueWorktree(n))) return runIssue({ ctx, deps, issue: n, ticket, revision, authorization });
  return continueRun({ ctx, deps, issue: n, ticket, revision, authorization, from });
}

/**
 * The run from one of its entry points: 'evidence' (ticket write + P0/P1
 * evidence), 'rounds' (§6.4–§6.7 under the global budget), 'push' (§6.8 over
 * the recorded attested head), 'ci' (§6.9 over the recorded PR).
 */
export async function continueRun({ ctx, deps, issue, ticket, revision = null, authorization = null, from = 'evidence' }) {
  const n = validateIssueNumber(issue);
  const cfg = ctx.config.autopilot;
  const record = () => ctx.records.load(n);
  let ticketId = record()?.ticketId ?? null;

  if (from === 'evidence') {
    // §6.2 — the signed ticket write (once); §6.3 — P0/P1 evidence.
    try {
      if (!ticketId) { const written = await deps.create.writeTicket({ ctx, issue: n, ticket }); ticketId = written.ticketId; }
      const evidence = await deps.create.recordEvidence({ ctx, issue: n, ticketId, ticket });
      if (evidence.verdict === 'CLARIFY') {
        const doc = deps.triage.clarifyDocument({ findings: gapsToFindings(evidence.gaps), issueUrl: deps.triage.issueUrlFor(ctx, n) });
        await deps.triage.clarifyEffects({ ctx, issue: n, sentinel: doc.sentinel, body: doc.body, revision });
        await deps.retire.retireRun({ ctx, record: record() });
        return { state: 'clarify', reason: 'coldstart-gaps', ticketId };
      }
    } catch (e) {
      if (e.code === 'quota-gated') {
        // §3.2 / AC 39: the ticket is cached; the run resumes at the coldstart on a later iteration.
        ctx.records.update(n, { state: 'shaped', ticketCache: ticket, ticketId: ticketId ?? null });
        return { state: 'shaped', reason: 'quota-paused', ticketId: ticketId ?? null };
      }
      // A coldstart call ended by its deadline is an operational failure that leaves the run record untouched (AC 39).
      const killed = e.code === 'claude-failed' || String(e.code ?? '').startsWith('timeout:');
      if (!killed) ctx.records.update(n, { lastError: `${e.code ?? 'evidence-failed'}: ${e.message}` });
      return { state: 'failed', reason: e.code ?? 'evidence-failed', exitCode: 1, detail: e.message, ticketId: ticketId ?? null };
    }
  }
  if (!ticketId) return { state: 'unchanged', reason: 'resume-no-ticket-id' };

  // The worker mirror + worker-deps are (re)built before dispatch, and the step set needs them for CI fix rounds too.
  let mirror; let workerDeps;
  try {
    mirror = await deps.mirror.createWorkerMirror({ ctx, issue: n });
    workerDeps = await deps.deps.buildWorkerDeps({ ctx, issue: n, baseOid: ctx.baseOid });
  } catch (e) {
    ctx.records.update(n, { lastError: `${e.code ?? 'init-failed'}: ${e.message}` });
    return { state: 'failed', reason: e.code ?? 'init-failed', exitCode: 1, detail: e.message, ticketId };
  }
  const steps = createRunSteps({ ctx, deps, issue: n, ticket, ticketId, mirror, workerDeps, revision, authorization });

  let produced = null;
  if (from === 'evidence' || from === 'rounds') {
    // §6.4–§6.7 — rounds under ONE global budget (§7).
    let deadEndFile = null;
    for (;;) {
      const budget = remainingBudget(record(), cfg);
      if (budget.strikes === 0 || budget.wallClockMinutes === 0) return { ...(await steps.block('strikes-exhausted', 'build budget exhausted', deadEndFile)), ticketId };
      const r = await steps.round({ budget, deadEndFile, chargeGlobal: true });
      if (r.status === 'terminal') return { ...r.result, ticketId };
      if (r.status === 'retry') { deadEndFile = r.deadEndFile; continue; }
      produced = r;
      break;
    }
  } else {
    const rec = record();
    if (!rec.attestedHead) return { state: 'unchanged', reason: 'resume-no-attested-head', ticketId };
    produced = { attested: { attestedHead: rec.attestedHead, revision: rec.attestRevision ?? null }, review: { verdict: 'approve', findings: [], reviewedHead: rec.reviewedHead ?? rec.attestedHead } };
  }

  let prNumber = record()?.prNumber ?? null;
  if (from !== 'ci') {
    // §6.8 — verify → push → verify → PR upsert.
    const opened = await steps.pushAndOpen({ attested: produced.attested, review: produced.review });
    if (opened.status === 'terminal') return { ...opened.result, ticketId };
    prNumber = opened.prNumber;
  }
  if (prNumber == null) return { state: 'unchanged', reason: 'resume-no-pr', ticketId };

  // §6.9 — CI follow-up. Each fix round runs ONE more round on the CI budget
  // (never the build budget) and pushes a fresh attestation.
  const runFixRound = async ({ budget, deadEnd }) => {
    const file = await deps.deadEnd({ ctx, issue: n, text: deadEnd });
    const r = await steps.round({ budget: { strikes: budget.maxStrikes, wallClockMinutes: budget.wallClockMinutes, wallClockMs: budget.wallClockMinutes * 60_000 }, deadEndFile: file, chargeGlobal: false });
    if (r.status !== 'attested') return { ok: false, code: r.status === 'terminal' ? (r.result.reason ?? r.result.state) : 'fix-round-needs-another-round', result: r.result ?? null };
    const p = await steps.pushAndOpen({ attested: r.attested, review: r.review });
    if (p.status === 'terminal') return { ok: false, code: p.result.reason ?? p.result.state, result: p.result };
    return { ok: true, attestedHead: r.attested.attestedHead };
  };
  const ci = await deps.ci.watchCi({ ctx, record: record(), attestedHead: produced.attested.attestedHead, budgetMs: cfg.ciWatchMinutes * 60_000, runFixRound, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  return { ...(await settleCi({ ctx, deps, steps, issue: n, ci, prNumber })), ticketId };
}

export { validateOid };
