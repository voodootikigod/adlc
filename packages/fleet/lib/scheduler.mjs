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
 * Drive ONE ticket through the full pipeline with the two-strike policy.
 * Returns { state, strikes, reason, deadEnds }.
 *
 * States: 'merged' | 'failed' | 'blocked'. Effects:
 *   dispatch({ticket, strike, deadEnds}) → { exitCode, timedOut, blocked, output }
 *   gate({ticket})                       → { ok, output }
 *   prosecute({ticket})                  → { verdict:'pass'|'block'|'unavailable', reason }
 *   merge({ticket})                      → { ok, reverted, output }
 *   flail({ticket})                      → { flail, signals?, failedOpen?, reason? }
 *
 * Policy (spec §12):
 *   - up to `maxStrikes` attempts;
 *   - a `TICKET-BLOCKED` worker → 'blocked' WITHOUT consuming the 2nd strike;
 *   - a build/gate failure retries with the fenced failure appended UNLESS
 *     flail-detector diagnoses a genuine flail, which skips the 2nd strike;
 *   - a BLOCKING prosecution routes to a fix strike (re-run the whole chain),
 *     never to merge (AC3 i); an UNAVAILABLE prosecution fails closed (F3);
 *   - a failed post-merge gate consumes a strike (the merge effect reverts).
 */
export async function advanceTicket(ticket, effects, { maxStrikes = 2, log = () => {} } = {}) {
  const deadEnds = [];
  let strikes = 0;
  let gatePassed = false;      // did any strike clear the deterministic gate?
  let prosecution = null;      // last prosecution verdict, for evidence/status
  const canRetry = () => strikes < maxStrikes;

  const fail = (reason) => ({ state: 'failed', strikes, reason, deadEnds, gatePassed, prosecution });

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
    effects.recordDispatchUsage?.(build);
    if (build.blocked) {
      // The ticket is wrong, not the agent — do not burn the second strike.
      return { state: 'blocked', strikes, reason: 'worker emitted TICKET-BLOCKED', deadEnds };
    }
    if (build.exitCode !== 0 || build.timedOut) {
      deadEnds.push(fence('BUILD', build.output, DEAD_END_MAX_CHARS));
      if (canRetry() && await consultFlail()) {
        return fail('flail-detector diagnosed a genuine flail — skipping the second strike');
      }
      continue;
    }

    log(`${ticket.id} strike ${strikes}: gating`);
    const gate = await effects.gate({ ticket });
    if (!gate.ok) {
      deadEnds.push(fence('GATE', gate.output, DEAD_END_MAX_CHARS));
      if (canRetry() && await consultFlail()) {
        return fail('flail-detector diagnosed a genuine flail — skipping the second strike');
      }
      continue;
    }

    gatePassed = true;
    // Verdict evidence ONLY — the spend rode its own entry at dispatch time.
    // Carrying it here too would double-count the call.
    effects.record?.('p4', true);

    log(`${ticket.id} strike ${strikes}: prosecuting`);
    const pros = await effects.prosecute({ ticket });
    prosecution = pros.verdict;
    if (pros.verdict === 'unavailable') {
      // Cannot prove safety → must not merge, retrying build won't help.
      effects.record?.('p5', false);
      return fail(`prosecution unavailable (fail closed): ${pros.reason}`);
    }
    if (pros.verdict === 'block') {
      deadEnds.push(fence('PROSECUTION', pros.reason, DEAD_END_MAX_CHARS));
      if (canRetry()) continue; // fix strike
      effects.record?.('p5', false);
      return fail('prosecution blocking after strikes exhausted');
    }
    effects.record?.('p5', true);

    log(`${ticket.id} strike ${strikes}: merging`);
    const merge = await effects.merge({ ticket });
    if (!merge.ok) {
      deadEnds.push(fence('POST_MERGE', merge.output ?? 'post-merge gate failed', DEAD_END_MAX_CHARS));
      if (canRetry()) continue;
      return fail('post-merge gate failed after strikes exhausted');
    }
    return { state: 'merged', strikes, deadEnds, gatePassed, prosecution };
  }
  // Verdict evidence only; every strike already booked its own spend at
  // dispatch time, so a run that never cleared the gate still has a complete
  // per-call record rather than just its last attempt.
  if (!gatePassed) effects.record?.('p4', false);
  return fail('two-strike cap reached');
}

/**
 * Resume reconciliation (spec §6.4; adversarial-review N2). "merged" is decided
 * by ancestry to the recorded INTEGRATION BRANCH, not base. A ticket left
 * in-flight by a dead run whose branch merged → 'merged' (never re-dispatched);
 * otherwise → 'pending' (strikes preserved). PURE given the ancestry probe.
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
      // In-flight with no live process and not merged → back to pending, keep strikes.
      tickets[id] = { ...rec, state: 'pending' };
    }
  }
  return { ...status, tickets };
}
