// §5: the lifecycle-job routing contract — validated, not caller-trusted.
//
// Channel selection is a TOTAL function over a closed job enum. The one thing it
// deliberately does not do is believe the caller: for `build.*` jobs the class is
// DERIVED from the ticket's category and the assignment's CPM float, and a
// caller-supplied label that disagrees with the derivation throws. A mislabeled
// dispatch is a bug, not a route — silently honouring the label is how
// critical-path work ends up on the cheap channel.
//
// `assign.mjs` is a RAIL here: its {tier, mode, budget, float} output is consumed
// exactly as emitted. Float comes from the ASSIGNMENT, never from the ticket —
// stored tickets have no float field; CPM float is computed by @adlc/core's
// computeFloat and placed on the assignment by the router.

import {
  BUILD_JOBS,
  LADDER_TIER_CHANNELS,
  NON_BUILD_JOB_ROUTES,
  SPEC_CLASS_CATEGORIES,
  isDeterministicJob,
} from './channels.mjs';

/**
 * Derive the build class for a ticket + assignment pair.
 *
 * Order is load-bearing: category wins over float (a spec-class ticket is
 * frontier work even with slack), and float === 0 wins over the assignment tier
 * (critical-path work goes frontier for CHANNEL purposes; the assignment tier
 * still governs the budget).
 */
export function deriveBuildJob({ assignment, ticket }) {
  if (ticket === null || typeof ticket !== 'object') {
    throw new Error('routeJob: build.* routing requires a ticket (§5 derives the build class from ticket.category).');
  }
  if (assignment === null || typeof assignment !== 'object') {
    throw new Error('routeJob: build.* routing requires an assignment (§5 reads assignment.float, not ticket.float).');
  }
  // Checked for EVERY build.* job, not only the ones that consume it: an absent
  // or non-numeric float means the caller did not run the real assignment
  // pipeline, and the failure mode of guessing is a silent downgrade.
  if (typeof assignment.float !== 'number' || !Number.isFinite(assignment.float)) {
    throw new Error(
      `routeJob: assignment.float must be a finite number (got ${JSON.stringify(assignment.float)}). ` +
        'It must never default to ladder-start — that would silently downgrade critical-path work.'
    );
  }
  if (SPEC_CLASS_CATEGORIES.includes(ticket.category)) return 'build.spec-class';
  if (assignment.float === 0) return 'build.critical-path';
  return 'build.ladder-start';
}

function ladderChannel(assignment) {
  const channel = LADDER_TIER_CHANNELS[assignment.tier];
  if (!channel) {
    throw new Error(
      `routeJob: assignment.tier "${assignment.tier}" has no channel (known tiers: ${Object.keys(LADDER_TIER_CHANNELS).join(', ')}).`
    );
  }
  return channel;
}

/**
 * Route one lifecycle job to a channel, a reviewer group, or the deterministic
 * (model-free) path.
 *
 * @param job the caller's label — a closed enum; unknown throws
 * @param assignment `assignTicket`'s output, consumed as emitted
 * @param ticket the stored ticket (for `category`)
 * @param channel the caller's CLAIMED channel, if any — validated, never trusted
 * @returns {{channel: string}|{reviewerGroup: string}|{deterministic: true}}
 */
export function routeJob({ job, assignment, ticket, channel } = {}) {
  if (typeof job !== 'string' || job.length === 0) {
    throw new Error(`routeJob: job must be a non-empty string (got ${JSON.stringify(job)}).`);
  }

  if (isDeterministicJob(job)) {
    if (channel !== undefined) {
      throw new Error(
        `routeJob: ${job} is a deterministic gate and takes no model — asserting channel "${channel}" is an error (§5).`
      );
    }
    return { deterministic: true };
  }

  if (BUILD_JOBS.includes(job)) {
    const derived = deriveBuildJob({ assignment, ticket });
    if (derived !== job) {
      throw new Error(
        `routeJob: caller labeled this dispatch "${job}" but the ticket and assignment derive "${derived}" ` +
          `(category=${JSON.stringify(ticket.category)}, float=${assignment.float}). A mislabeled dispatch is a bug, not a route.`
      );
    }
    const routed = derived === 'build.ladder-start' ? ladderChannel(assignment) : 'frontier';
    assertClaimedChannel(job, routed, channel);
    return { channel: routed };
  }

  const route = NON_BUILD_JOB_ROUTES[job];
  if (!route) {
    throw new Error(
      `routeJob: unknown job "${job}". Known jobs: ${[...BUILD_JOBS, ...Object.keys(NON_BUILD_JOB_ROUTES)].join(', ')}, gate.deterministic.*`
    );
  }
  if (route.channel) {
    assertClaimedChannel(job, route.channel, channel);
    return { channel: route.channel };
  }
  if (channel !== undefined) {
    throw new Error(`routeJob: ${job} routes to reviewer group "${route.reviewerGroup}", not channel "${channel}" (§5).`);
  }
  return { reviewerGroup: route.reviewerGroup };
}

function assertClaimedChannel(job, routed, claimed) {
  if (claimed !== undefined && claimed !== routed) {
    throw new Error(`routeJob: caller claimed channel "${claimed}" for ${job}, but §5 routes it to "${routed}".`);
  }
}
