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

/**
 * Drive one issue through §6. `deps` is the composed module set (lib/context.mjs).
 */
export async function runIssue({ ctx, deps, issue, ticket, revision = null, authorization = null }) {
  const n = validateIssueNumber(issue);
  const cfg = ctx.config.autopilot;
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

  // §6.2 — the signed ticket write; §6.3 — P0/P1 evidence.
  let ticketId;
  try {
    const written = await deps.create.writeTicket({ ctx, issue: n, ticket });
    ticketId = written.ticketId;
    const evidence = await deps.create.recordEvidence({ ctx, issue: n, ticketId, ticket });
    if (evidence.verdict === 'CLARIFY') {
      const doc = deps.triage.clarifyDocument({ findings: gapsToFindings(evidence.gaps), issueUrl: deps.triage.issueUrlFor(ctx, n) });
      await deps.triage.clarifyEffects({ ctx, issue: n, sentinel: doc.sentinel, body: doc.body, revision });
      await deps.retire.retireRun({ ctx, record: record() });
      return { state: 'clarify', reason: 'coldstart-gaps', ticketId };
    }
  } catch (e) {
    ctx.records.update(n, { lastError: `${e.code ?? 'evidence-failed'}: ${e.message}` });
    return { state: 'failed', reason: e.code ?? 'evidence-failed', exitCode: 1, detail: e.message, ticketId: ticketId ?? null };
  }

  // The worker mirror + worker-deps are built once per run, before dispatch.
  let mirror; let workerDeps;
  try {
    mirror = await deps.mirror.createWorkerMirror({ ctx, issue: n });
    workerDeps = await deps.deps.buildWorkerDeps({ ctx, issue: n, baseOid: ctx.baseOid });
  } catch (e) {
    ctx.records.update(n, { lastError: `${e.code ?? 'init-failed'}: ${e.message}` });
    return { state: 'failed', reason: e.code ?? 'init-failed', exitCode: 1, detail: e.message, ticketId };
  }

  const steps = createRunSteps({ ctx, deps, issue: n, ticket, ticketId, mirror, workerDeps, revision, authorization });

  // §6.4–§6.7 — rounds under ONE global budget (§7).
  let deadEndFile = null;
  let produced = null;
  for (;;) {
    const budget = remainingBudget(record(), cfg);
    if (budget.strikes === 0 || budget.wallClockMinutes === 0) return { ...(await steps.block('strikes-exhausted', 'build budget exhausted', deadEndFile)), ticketId };
    const r = await steps.round({ budget, deadEndFile, chargeGlobal: true });
    if (r.status === 'terminal') return { ...r.result, ticketId };
    if (r.status === 'retry') { deadEndFile = r.deadEndFile; continue; }
    produced = r;
    break;
  }

  // §6.8 — verify → push → verify → PR upsert.
  const opened = await steps.pushAndOpen({ attested: produced.attested, review: produced.review });
  if (opened.status === 'terminal') return { ...opened.result, ticketId };
  const prNumber = opened.prNumber;

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
