// The event-driven scheduler state machine (spec §6, §8, §9, §12).
//
// Control flow is code, judgment is models (ADLC D0): nothing here asks an LLM
// to decide ordering, retries, or merges. Every effect that touches the world
// (dispatch, gate, prosecute, merge, flail, git) is injected, so the real state
// machine below is exercised directly in tests with deterministic stubs.

import { fence } from '@adlc/core';
import { computeReady, selectDispatchable, unsatisfiableInSubset } from './plan.mjs';

// issue #280: same cap as charters.mjs's re-fencing of these same deadEnds —
// capping here (where the raw log first enters a deadEnd) is what actually
// bounds worst-case size; charters.mjs's later re-fence of an
// already-capped string is then a no-op truncation in the common case.
const DEAD_END_MAX_CHARS = 12_000;

/**
 * The machine-readable outcome codes a caller keys on (issue-autopilot-local
 * §14, fleet-ext item 9). `reason` on a ticket outcome stays the human sentence;
 * `reasonCode` is the closed-enum value. Stated once so run.mjs, the CLI result
 * document and the tests share one vocabulary.
 */
export const REASON_CODES = Object.freeze({
  QUOTA_PAUSED: 'quota-paused',
  LOCK_HELD: 'lock-held',
  WALL_CLOCK: 'wall-clock',
  STRIKES_EXHAUSTED: 'strikes-exhausted',
  TICKET_BLOCKED: 'ticket-blocked',
  FLAIL: 'flail',
  REVIEW_UNAVAILABLE: 'review-unavailable',
  MIRROR_FETCH_FAILED: 'mirror-fetch-failed',
});

/**
 * Plan one dispatch round: given the full ticket set and current run status,
 * return the tickets to admit now (respecting edges, scope-overlap
 * serialization, and the concurrency cap) plus any subset-blocked ids.
 *
 * PURE — this is the readiness/serialization core (AC3 a–d).
 */
export function planRound(all, { statusById = {}, inFlightIds = [], cap = 2, onlyIds } = {}) {
  const byId = new Map(all.map((t) => [t.id, t]));
  const inFlight = inFlightIds.map((id) => byId.get(id)).filter(Boolean);
  const freeSlots = Math.max(0, cap - inFlight.length);
  const ready = computeReady(all, { statusById, inFlightIds, onlyIds });
  const admit = selectDispatchable(ready, inFlight, freeSlots);
  const blocked = unsatisfiableInSubset(all, { onlyIds, statusById });
  return { admit, blocked, freeSlots };
}

/**
 * Drive ONE ticket through the full pipeline with the strike policy.
 * Returns { state, strikes, reason, reasonCode, deadEnds, review }.
 *
 * States: 'merged' | 'failed' | 'blocked' | 'paused'. Effects:
 *   preStrike?({ticket, strike})           → { ok, reason? }  (fleet-ext item 7)
 *   dispatch({ticket, strike, deadEnds})   → { exitCode, timedOut, blocked, output, mirrorFetchFailed? }
 *   gate({ticket})                         → { ok, output }
 *   prosecute({ticket})                    → { verdict:'pass'|'block'|'unavailable', reason, review? }
 *   merge({ticket})                        → { ok, reverted, output }
 *   flail({ticket})                        → { flail, signals?, failedOpen?, reason? }
 *
 * Policy (spec §12):
 *   - up to `maxStrikes` attempts (fleet-ext item 4 — no longer hard-coded);
 *   - `startStrikes` resumes a reconciled ticket from the strike count its
 *     persisted status carries, never from zero (fleet-ext item 7 / AC4);
 *   - `initialDeadEnds` seeds strike 1 with the caller's failure material
 *     (fleet-ext item 3), already fenced by the caller;
 *   - a refused pre-strike command PAUSES the ticket before the strike starts:
 *     state 'paused', reasonCode 'quota-paused', resumable by re-invocation;
 *   - an expired external `deadline` (epoch ms) PAUSES it too, before a strike
 *     or when the strike it cut short timed out: reasonCode 'wall-clock';
 *   - a `TICKET-BLOCKED` worker → 'blocked' WITHOUT consuming the next strike;
 *   - a dispatch that reports `mirrorFetchFailed` fails immediately with
 *     'mirror-fetch-failed' (the worker branch is left untouched for forensics);
 *   - a build/gate failure retries with the fenced failure appended UNLESS
 *     flail-detector diagnoses a genuine flail, which skips the next strike;
 *   - a BLOCKING prosecution routes to a fix strike (re-run the whole chain),
 *     never to merge (AC3 i); an UNAVAILABLE prosecution fails closed (F3);
 *   - a failed post-merge gate consumes a strike (the merge effect reverts).
 */
export async function advanceTicket(ticket, effects, {
  maxStrikes = 2, log = () => {}, startStrikes = 0, initialDeadEnds = [], deadline = null, now = Date.now,
} = {}) {
  const deadEnds = [...initialDeadEnds];
  let strikes = startStrikes;
  let gatePassed = false;      // did any strike clear the deterministic gate?
  let prosecution = null;      // last prosecution verdict, for evidence/status
  let review = null;           // last review meta { provider, verdict, revision, rounds }
  let reviewRounds = 0;
  const canRetry = () => strikes < maxStrikes;
  const expired = () => deadline != null && now() >= deadline;
  // The remaining budget handed to every awaited phase (gate, prosecution, merge),
  // so none of them can run past the deadline; null when there is no deadline.
  const remainingMs = () => (deadline == null ? null : Math.max(1, deadline - now()));

  const fail = (reason, reasonCode) => ({ state: 'failed', strikes, reason, reasonCode, deadEnds, gatePassed, prosecution, review });
  const paused = (reason, reasonCode) => ({ state: 'paused', strikes, reason, reasonCode, deadEnds, gatePassed, prosecution, review });
  // A pause after the worker returned but before the strike's verdict landed (gate/prosecution/merge
  // cut short or never reached) hands the strike BACK: a resume on the last strike can still run it
  // (codex r20 #3). The worker's output stays in its worktree.
  const pausedUnconsumed = (reason) => ({ ...paused(reason, REASON_CODES.WALL_CLOCK), strikes: Math.max(0, strikes - 1) });

  /**
   * Consult flail-detector, and SAY SO when the consultation could not produce
   * a verdict. The §12 policy is unchanged — a fail-open still returns false and
   * the build keeps its normal retry — but an unobservable fail-open is how the
   * gate goes blind without anyone noticing (#309): a missing detector, an
   * unwritable transcript, or schema drift would otherwise read exactly like
   * "this session is clean".
   */
  const consultFlail = async () => {
    const r = await effects.flail({ ticket });
    if (r?.failedOpen) {
      log(`${ticket.id} WARNING: flail consultation failed open (${r.reason ?? 'unknown'}) — ` +
          'the supervision signal is unavailable, not clean; the build keeps its normal retry');
    }
    return r?.flail === true;
  };

  while (strikes < maxStrikes) {
    // The external wall clock is checked BEFORE a strike is counted: an expired
    // run must not spend a strike it will then have to abandon.
    if (expired()) return paused('external wall clock expired before the next strike', REASON_CODES.WALL_CLOCK);
    // The pre-strike command (a quota gate, in the autopilot's case) runs before
    // EVERY strike — including a resumed one — and a refusal pauses the ticket
    // without consuming the strike.
    if (effects.preStrike) {
      const ps = await effects.preStrike({ ticket, strike: strikes + 1 });
      // The helper may have consumed the budget: an expired run is wall-clock, not quota (codex r4).
      if (expired()) return paused('external wall clock expired during the pre-strike command', REASON_CODES.WALL_CLOCK);
      if (!ps || ps.ok !== true) {
        return paused(ps?.reason ?? 'pre-strike command refused the strike', REASON_CODES.QUOTA_PAUSED);
      }
    }
    strikes += 1;
    log(`${ticket.id} strike ${strikes}: building`);

    const build = await effects.dispatch({ ticket, strike: strikes, deadEnds });
    // §8a: usage belongs to the DISPATCH that incurred it, not to a downstream
    // verdict. Emitted here — immediately after every completed dispatch and
    // before any branch can return — so a blocked worker, a flail exit, or a
    // strike that never clears the gate still books the tokens it really
    // spent. Tying this to the gate verdict instead hid whole calls: a 100k
    // first strike that failed its gate followed by a 20k repair reported only
    // 20k (adversarial-review MEDIUM). This mirrors the P5 rule exactly —
    // exactly one carrier entry per model call.
    // The STRIKE number rides along because F8 escalation makes the seat a
    // property of the ATTEMPT (#401): the recorder has to name the channel this
    // particular call ran on, and only the strike identifies which rung that was.
    effects.recordDispatchUsage?.(build, strikes);
    if (build.policyMismatch) {
      // The sandbox could not be BUILT (unsupported adapter, missing executable, an
      // invalid read set): deterministic, the operator's to fix, never a strike or
      // a flail (codex r7). The strike it would have been is handed back, and the
      // ticket is PAUSED, not failed: resume reconciliation skips failed tickets, so a
      // terminal state would make the operator's fix unreachable (codex r24 #1).
      strikes -= 1;
      // `reasonCode` stays null: §14's closed set has no code for it; `policyMismatch` is the marker.
      return { ...paused(`sandbox policy mismatch: ${build.output ?? ''}`.trim(), null), policyMismatch: true };
    }
    if (build.blocked) {
      // The ticket is wrong, not the agent — do not burn the next strike.
      return { state: 'blocked', strikes, reason: 'worker emitted TICKET-BLOCKED', reasonCode: REASON_CODES.TICKET_BLOCKED, deadEnds, gatePassed, prosecution, review };
    }
    if (build.mirrorFetchFailed) {
      // The worker's branch could not be brought back into the caller repository.
      // Nothing downstream can be trusted and a retry would re-cut from the same
      // stale tip, so this is terminal for the run (fleet-ext item 12).
      return fail(`worker branch could not be fetched back from the mirror: ${build.output ?? ''}`.trim(), REASON_CODES.MIRROR_FETCH_FAILED);
    }
    if (build.timedOut && expired()) {
      // The strike was cut short by the external wall clock, not by the
      // per-dispatch timeout — resumable, not a failure of the ticket. When the
      // dispatch ran on a budget the deadline had TRUNCATED below the configured
      // per-dispatch timeout it never had its full attempt: that strike is handed
      // back, so a resume on the last strike can still run it (codex r23 #3). A
      // worker that had its full budget and still timed out keeps its verdict.
      if (build.deadlineTruncated) return pausedUnconsumed('external wall clock expired during the strike; its deadline-truncated budget was not a full attempt');
      return paused('external wall clock expired during the strike', REASON_CODES.WALL_CLOCK);
    }
    if (build.exitCode !== 0 || build.timedOut) {
      // The wall clock outranks the verdict of the strike: a run whose deadline passed while a strike
      // failed is PAUSED (resumable), never charged toward the strike cap (codex r18 #4).
      if (expired()) return paused('external wall clock expired during a failed strike', REASON_CODES.WALL_CLOCK);
      deadEnds.push(fence('BUILD', build.output, DEAD_END_MAX_CHARS));
      if (canRetry()) {
        const flailed = await consultFlail();
        // The consultation itself may have spent the budget: wall-clock outranks flail (codex r10).
        if (expired()) return paused('external wall clock expired during the flail consultation', REASON_CODES.WALL_CLOCK);
        if (flailed) return fail('flail-detector diagnosed a genuine flail — skipping the next strike', REASON_CODES.FLAIL);
      }
      continue;
    }
    // The wall clock bounds the WHOLE run, not just dispatch: nothing gates,
    // prosecutes or merges past it. An expired run pauses (resumable) even when
    // the strike itself returned in time.
    if (expired()) return pausedUnconsumed('external wall clock expired after the strike; nothing is gated or merged past it');

    log(`${ticket.id} strike ${strikes}: gating`);
    const gate = await effects.gate({ ticket, remainingMs: remainingMs() });
    if (!gate.ok) {
      // A gate cut short by the wall clock is not the worker's failure: pause, never a strike/flail (codex r5).
      if (gate.timedOut && expired()) return pausedUnconsumed('external wall clock expired during the gate');
      if (expired()) return paused('external wall clock expired during a failed gate', REASON_CODES.WALL_CLOCK);
      deadEnds.push(fence('GATE', gate.output, DEAD_END_MAX_CHARS));
      if (canRetry()) {
        const flailed = await consultFlail();
        if (expired()) return paused('external wall clock expired during the flail consultation', REASON_CODES.WALL_CLOCK);
        if (flailed) return fail('flail-detector diagnosed a genuine flail — skipping the next strike', REASON_CODES.FLAIL);
      }
      continue;
    }

    gatePassed = true;
    // Verdict evidence ONLY — the spend rode its own entry at dispatch time.
    // Carrying it here too would double-count the call.
    effects.record?.('p4', true);
    if (expired()) return pausedUnconsumed('external wall clock expired after the gate; nothing is prosecuted or merged past it');

    log(`${ticket.id} strike ${strikes}: prosecuting`);
    const pros = await effects.prosecute({ ticket, remainingMs: remainingMs() });
    prosecution = pros.verdict;
    reviewRounds += 1;
    review = { ...(pros.review ?? {}), verdict: pros.review?.verdict ?? pros.verdict, rounds: reviewRounds };
    if (pros.verdict === 'unavailable') {
      if (pros.timedOut && expired()) return pausedUnconsumed('external wall clock expired during prosecution');
      // Cannot prove safety → must not merge, retrying build won't help.
      effects.record?.('p5', false);
      return fail(`prosecution unavailable (fail closed): ${pros.reason}`, REASON_CODES.REVIEW_UNAVAILABLE);
    }
    if (pros.verdict === 'block') {
      deadEnds.push(fence('PROSECUTION', pros.reason, DEAD_END_MAX_CHARS));
      if (canRetry()) continue; // fix strike
      effects.record?.('p5', false);
      return fail('prosecution blocking after strikes exhausted', REASON_CODES.STRIKES_EXHAUSTED);
    }
    effects.record?.('p5', true);
    if (expired()) return pausedUnconsumed('external wall clock expired after prosecution; nothing is merged past it');

    log(`${ticket.id} strike ${strikes}: merging`);
    const merge = await effects.merge({ ticket, remainingMs: remainingMs() });
    // The merge re-checks the deadline INSIDE its mutex (a queued merge may have waited past it).
    if (merge.expired) return pausedUnconsumed('external wall clock expired before the merge');
    if (!merge.ok) {
      deadEnds.push(fence('POST_MERGE', merge.output ?? 'post-merge gate failed', DEAD_END_MAX_CHARS));
      if (canRetry()) continue;
      return fail('post-merge gate failed after strikes exhausted', REASON_CODES.STRIKES_EXHAUSTED);
    }
    // The merge landed within budget but the wall clock expired during or after the
    // completion step: the ticket IS merged, and the run reports wall-clock so nothing
    // (no PR) is published past the deadline by this invocation (codex r23 #4).
    if (merge.expiredAfterMerge) return { state: 'merged', strikes, deadEnds, gatePassed, prosecution, review, reason: merge.output ?? 'external wall clock expired after the merge', reasonCode: REASON_CODES.WALL_CLOCK };
    return { state: 'merged', strikes, deadEnds, gatePassed, prosecution, review };
  }
  // Verdict evidence only; every strike already booked its own spend at
  // dispatch time, so a run that never cleared the gate still has a complete
  // per-call record rather than just its last attempt.
  if (!gatePassed) effects.record?.('p4', false);
  return fail(`${maxStrikes}-strike cap reached`, REASON_CODES.STRIKES_EXHAUSTED);
}

/**
 * Resume reconciliation (spec §6.4; adversarial-review N2). "merged" is decided
 * by ancestry to the recorded INTEGRATION BRANCH, not base. A ticket left
 * in-flight (or paused) by a dead run whose branch merged → 'merged' (never
 * re-dispatched); otherwise → 'pending' (strikes preserved, so the resumed
 * ticket continues from the strike count it reached). PURE given the ancestry
 * probe.
 *
 * @param isAncestor (branch, ref) => boolean
 */
export function reconcileResume(_all, status, { isAncestor, integrationBranch }) {
  const target = integrationBranch ?? status.integrationBranch;
  const tickets = { ...status.tickets };
  for (const [id, rec] of Object.entries(tickets)) {
    if (rec.state === 'merged' || rec.state === 'failed' || rec.state === 'blocked') continue;
    const branch = rec.branch ?? `fleet/${id.toLowerCase()}`;
    if (isAncestor(branch, target)) {
      tickets[id] = { ...rec, state: 'merged' };
    } else {
      // In-flight/paused with no live process and not merged → back to pending, keep strikes.
      tickets[id] = { ...rec, state: 'pending' };
    }
  }
  return { ...status, tickets };
}
