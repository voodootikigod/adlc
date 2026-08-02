// §5 + F8: which channel one ATTEMPT of a build runs on (issue #401).
//
// §5 routes `build.ladder-start` to the assignment tier's channel and says
// "Escalation per F8 is a fresh attempt". This module is that escalation,
// expressed as pure rules over the closed channel set — no registry, no
// dispatch, no I/O. `packages/fleet` resolves each rung to a concrete seat and
// renders the argv; the RULE for which rung an attempt takes lives here, beside
// the routing contract it belongs to.
//
// The ladder's premise is economic: slack work starts cheap precisely BECAUSE a
// failure escalates. Without escalation a cheap first attempt is only a cheaper
// way to fail, and `assign.mjs`'s ladder budget (starting tier + one frontier
// regeneration) is provisioned for an attempt that never happens.

/**
 * The ladder, lowest rung first.
 *
 * Written out explicitly because ORDER is the whole content of this constant and
 * `LADDER_TIER_CHANNELS` is a map, whose iteration order is an implementation
 * detail no safety property should rest on. The coupling is enforced by a test
 * instead: this list must hold exactly the channels `routeJob` can START a
 * ladder on, so escalation can never climb onto a channel routing never selects.
 *
 * `frontier-metered` is deliberately absent — it is reached by a §7 fallback
 * traversal (a transport change), never by climbing.
 */
export const LADDER_CHANNELS = Object.freeze(['cheap', 'mid', 'frontier']);

/**
 * Only a ladder-start job in ladder mode climbs.
 *
 * BOTH halves are load-bearing. `assign.mjs` routes a ticket below the
 * rail-density floor to `{tier: 'frontier', mode: 'direct'}` while `routeJob`
 * still DERIVES `build.ladder-start` from its non-zero float — so keying on the
 * job alone would escalate a ticket the router deliberately routed direct.
 */
function escalates(job, mode) {
  return job === 'build.ladder-start' && mode === 'ladder';
}

function assertAttempt(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(
      `escalate: attempt must be a positive integer (got ${JSON.stringify(attempt)}). ` +
        'It must never default to 1 — that would silently re-run a failed strike on the cheap seat.'
    );
  }
}

/**
 * The channels above `channel` that this seat may climb to, in climb order.
 * `[]` when the seat does not escalate at all.
 *
 * @param {object} opts
 * @param {string} opts.job   the DERIVED build class (`deriveBuildJob`'s output)
 * @param {string} opts.mode  the assignment mode (`assign.mjs`'s `mode`)
 * @param {string} opts.channel  the starting channel (`routeJob`'s output)
 * @returns {string[]}
 */
export function escalationRungs({ job, mode, channel } = {}) {
  if (!escalates(job, mode)) return [];
  const start = LADDER_CHANNELS.indexOf(channel);
  if (start < 0) {
    throw new Error(
      `escalate: channel "${channel}" is not on the ladder (${LADDER_CHANNELS.join(' → ')}), so there is no rung above it. ` +
        'Escalation never crosses onto a channel routing does not start on.'
    );
  }
  return LADDER_CHANNELS.slice(start + 1);
}

/**
 * Pick the rung one attempt takes — THE index rule, shared by every consumer.
 *
 * Generic over what a rung carries so the channel-level rule here and the
 * seat-level resolution in `packages/fleet` cannot drift: a recorded channel
 * and the seat that actually dispatched are computed by this one function.
 *
 * Attempt 1 takes `first`; each later attempt climbs one rung and STOPS at the
 * top rather than indexing past it (returning `undefined` there would read
 * downstream as "no seat" and fail a dispatch the ladder should have served).
 *
 * @template T
 * @param {T} first    the rung attempt 1 takes
 * @param {T[]} rest   the rungs above it, in climb order
 * @param {number} attempt  1-based
 * @returns {{value: T, escalated: boolean}}
 */
export function rungForAttempt(first, rest, attempt) {
  assertAttempt(attempt);
  const rungs = Array.isArray(rest) ? rest : [];
  if (attempt === 1 || rungs.length === 0) return { value: first, escalated: false };
  return { value: rungs[Math.min(attempt - 2, rungs.length - 1)], escalated: true };
}

/**
 * The channel one attempt of this seat runs on.
 *
 * @param {object} opts  `escalationRungs`'s inputs plus a 1-based `attempt`
 * @returns {string}
 */
export function channelForAttempt({ job, mode, channel, attempt } = {}) {
  assertAttempt(attempt);
  return rungForAttempt(channel, escalationRungs({ job, mode, channel }), attempt).value;
}
