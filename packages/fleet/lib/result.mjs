// The machine-readable run result (issue-autopilot-local §14, fleet-ext item 9).
//
// A caller that composes fleet (the issue autopilot) must never parse the exit
// code alone: 2 means "a ticket did not merge" whether the cause was a quota
// pause it can resume from, a wall clock it can extend, or a blocked ticket it
// must escalate. So every non-zero exit carries a top-level `reason` from a
// CLOSED vocabulary, and the reason — not the number — is what callers key on.
//
// Pure: the document is derived from the run summary and the preflight verdict,
// so the CLI, the tests and the autopilot's own fixtures see one mapping.

import { REASON_CODES } from './scheduler.mjs';

/** The closed set a caller may branch on for ticket outcomes. */
export const TICKET_REASONS = Object.freeze(Object.values(REASON_CODES));

/**
 * Run-level outcomes that are NOT ticket outcomes. They are reported under the
 * same `reason` key so a non-zero exit is never reasonless, but they are
 * deliberately outside TICKET_REASONS: a caller that keys on the closed ticket
 * set treats them as an operational error needing a human, which is right — a
 * quarantined integration branch is not something to label an issue with.
 */
export const RUN_REASONS = Object.freeze({
  QUARANTINED: 'quarantined',
  PR_OPEN_FAILED: 'pr-open-failed',
  PREFLIGHT: 'preflight',
  RESUME_REFUSED: 'resume-refused',
  DISPATCH_REFUSED: 'dispatch-refused',
  PIPELINE_ERROR: 'pipeline-error',
});

/** Ticket ids in a deterministic (status) order whose state is not merged. */
function unmergedTickets(summary) {
  return Object.entries(summary?.status?.tickets ?? {}).filter(([, r]) => r.state !== 'merged');
}

/**
 * The `reason` for a finished run, or null when the run is clean.
 *
 * Precedence mirrors runExitCode: quarantine and a failed PR are run-level
 * failures no per-ticket state can outrank; then the run-wide wall clock; then
 * the first unmerged ticket's own code. A ticket that reached a terminal state
 * without a code (a status written by an older fleet) reports
 * 'strikes-exhausted' — the conservative reading of "it stopped".
 */
export function summaryReason(summary) {
  if (!summary) return null;
  if (summary.contaminated) return RUN_REASONS.QUARANTINED;
  if (summary.prOpenFailed) return RUN_REASONS.PR_OPEN_FAILED;
  if (summary.dispatchRefused) return RUN_REASONS.DISPATCH_REFUSED;
  if (summary.pipelineError) return RUN_REASONS.PIPELINE_ERROR;
  if (summary.wallClockExpired) return REASON_CODES.WALL_CLOCK;
  for (const [, rec] of unmergedTickets(summary)) {
    if (rec.state === 'paused' || rec.state === 'failed' || rec.state === 'blocked') {
      return rec.reasonCode ?? REASON_CODES.STRIKES_EXHAUSTED;
    }
  }
  return null;
}

/**
 * Build the `--json` document for a live run.
 *
 * @param opts.runId       the fleet run id (also reported as `fleetRunId`)
 * @param opts.exitCode    the process exit code the CLI is about to use
 * @param opts.summary     runFleet's summary (may be absent when preflight failed)
 * @param opts.reason      an explicit reason for a non-summary exit (preflight, resume)
 * @param opts.sandbox     the effective model-plane policy echo (readPolicy, privateTmp, …)
 */
export function resultDocument({ runId = null, exitCode, summary = null, reason = null, sandbox = {}, warnings = [] } = {}) {
  const derived = reason ?? summaryReason(summary);
  const tickets = summary?.status?.tickets ?? {};
  const ids = Object.keys(tickets);
  // The single-ticket case (the autopilot's) gets its review at the top level;
  // every ticket's review is always under `tickets`.
  const review = ids.length === 1 ? (tickets[ids[0]].review ?? null) : null;
  const strikes = Object.fromEntries(ids.map((id) => [id, tickets[id].strikes ?? 0]));
  return {
    fleetRunId: runId,
    exitCode,
    // Every non-zero exit carries a reason; a clean exit carries null.
    reason: exitCode === 0 ? null : (derived ?? RUN_REASONS.DISPATCH_REFUSED),
    integrationBranch: summary?.integrationBranch ?? null,
    merged: summary?.merged ?? 0,
    results: summary?.results ?? {},
    strikes,
    strikesConsumed: summary?.strikesConsumed ?? 0,
    review,
    tickets: Object.fromEntries(ids.map((id) => [id, {
      state: tickets[id].state,
      strikes: tickets[id].strikes ?? 0,
      reason: tickets[id].reason ?? null,
      reasonCode: tickets[id].reasonCode ?? null,
      review: tickets[id].review ?? null,
    }])),
    readPolicy: sandbox.readPolicy ?? 'host',
    privateTmp: sandbox.privateTmp === true,
    gitSource: sandbox.gitSource ?? 'shared',
    mirror: sandbox.mirror ?? null,
    egress: sandbox.egress ?? 'open',
    egressAllowlist: sandbox.egressAllowlist ?? [],
    homeBinds: sandbox.homeBinds ?? [],
    writableRoots: sandbox.writableRoots ?? [],
    warnings,
  };
}
