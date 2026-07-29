// The closed name sets fixed by docs/specs/operating-stack.md §4a and §5.
//
// These are deliberately CODE, not config. A registry cannot invent routes the
// routing contract never sanctioned (§4a): adding a channel is a spec revision,
// not an operator edit. Every set here is exhaustive — validation and routing
// both read these, so the two can never drift apart.

/**
 * The one `model` value that means "let the harness resolve its own default"
 * rather than naming a model (§4b, §4c).
 *
 * It is the only value NOT forced onto the command line, so it is also the only
 * value an adapter that cannot force a model may be bound to. `packages/fleet`'s
 * `HARNESS_DEFAULT_ALIAS` must equal this string — pinned by a test, since a
 * silent divergence would mean one side forcing a literal `default` while the
 * other believed nothing was forced.
 */
export const HARNESS_DEFAULT_MODEL = 'default';

/** §4a: the four build/maintenance channels. Exhaustive. */
export const CHANNEL_NAMES = Object.freeze(['frontier', 'frontier-metered', 'mid', 'cheap']);

/** §6: the reviewer groups. Exhaustive. */
export const REVIEWER_GROUP_NAMES = Object.freeze(['cross-model-routine', 'cross-model-trust-root']);

/**
 * §4b rule 4: the transport taxonomy is CLOSED, and the prefix is load-bearing.
 *
 * §6's quorum rule discounts every member sharing a `gateway:*` transport down
 * to a single family. A transport whose prefix is unrecognized must therefore be
 * REJECTED, never silently treated as non-gateway — an unknown prefix passing
 * validation would let a mediated seat claim the diversity of a direct one,
 * which is a trust-boundary hole rather than a cosmetic gap.
 */
export const TRANSPORT_PREFIXES = Object.freeze(['subscription:', 'api:', 'gateway:']);

/** The transports whose auth handshake is with the provider itself (§6). */
export const DIRECT_TRANSPORT_PREFIXES = Object.freeze(['subscription:', 'api:']);

/**
 * §5: the closed job enum. `build.*` labels are DERIVED and merely checked
 * against the caller's claim; every other row is structural (the call site is
 * the lifecycle stage).
 */
export const BUILD_JOBS = Object.freeze(['build.spec-class', 'build.critical-path', 'build.ladder-start']);

/** §5: non-build jobs and the channel/group each routes to. */
export const NON_BUILD_JOB_ROUTES = Object.freeze({
  'prosecute.lens': { channel: 'mid' },
  'prosecute.verdict': { channel: 'frontier' },
  'review.cross-model.routine': { reviewerGroup: 'cross-model-routine' },
  'review.cross-model.trust-root': { reviewerGroup: 'cross-model-trust-root' },
  'maintain.ratchet': { channel: 'mid' },
  'maintain.mining': { channel: 'mid' },
  'maintain.calibration': { channel: 'frontier-metered' },
});

/**
 * §5: `gate.deterministic.*` is the one wildcard row — deterministic gates are
 * open-ended by name but identical in routing (they take no model at all). The
 * suffix must be non-empty so a bare `gate.deterministic.` cannot slip through.
 */
export const DETERMINISTIC_JOB_PATTERN = /^gate\.deterministic\.[a-z0-9][a-z0-9-]*$/;

/** §5: ticket categories that make a build spec-class regardless of float. */
export const SPEC_CLASS_CATEGORIES = Object.freeze(['contract', 'spec', 'architecture']);

/** The assignment tiers that map to a ladder-start channel. */
export const LADDER_TIER_CHANNELS = Object.freeze({ cheap: 'cheap', mid: 'mid', frontier: 'frontier' });

/** True if `job` is one of the §5 `gate.deterministic.*` rows. */
export function isDeterministicJob(job) {
  return typeof job === 'string' && DETERMINISTIC_JOB_PATTERN.test(job);
}

/** True if `transport` carries one of the closed §4b rule 4 prefixes. */
export function hasKnownTransportPrefix(transport) {
  if (typeof transport !== 'string') return false;
  return TRANSPORT_PREFIXES.some((prefix) => transport.startsWith(prefix) && transport.length > prefix.length);
}

/** True if `transport` is a direct-auth transport (§6 — not behind a gateway). */
export function isDirectTransport(transport) {
  if (typeof transport !== 'string') return false;
  return DIRECT_TRANSPORT_PREFIXES.some((prefix) => transport.startsWith(prefix) && transport.length > prefix.length);
}
