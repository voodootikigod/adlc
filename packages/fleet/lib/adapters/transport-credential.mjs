// Which credential a seat's TRANSPORT entitles its worker to (issue #396).
//
// §4b's transport prefix was load-bearing for validation and recorded in the
// ledger, but dispatch dropped it: every worker got one run-wide
// `config.modelAuthKey` and inherited ambient auth. A seat labelled
// `subscription:anthropic-max` therefore ran in an environment that might carry
// an ambient `ANTHROPIC_API_KEY`, and the harness was free to bill metered rates
// against capacity the operator already pays a subscription for.
//
// THE GUARANTEE IS ASYMMETRIC, and the asymmetry is the point:
//
//   WITHHOLDING a credential is provable. A subscription seat that never
//   receives a provider key CANNOT have been metered — absence is a fact about
//   the process environment, not a claim about harness behaviour.
//
//   SUPPLYING one is not. A harness handed an API key may still prefer a stored
//   session, so an `api:` seat's label describes what was OFFERED, never what
//   served the call.
//
// So the negative direction carries the weight, and a recorded transport is
// `selected` — never `attested`. Proving what actually served a call is the
// transport twin of §4c's attest half (spec §9.3), deliberately deferred.

import { transportClass } from '@adlc/quartermaster';

/**
 * The one environment variable this seat's worker may keep, or null for "keep
 * none" — which `modelPlaneEnv` reads as "strip every provider secret".
 *
 * null is the RIGHT answer for `subscription:` (the session lives in HOME, no
 * variable needed) and for a `gateway:` whose harness owns its own provider
 * config. Both then reach the harness with no provider key at all, which is
 * exactly the guarantee above.
 *
 * @param {{transports?: Record<string, {env?: string}>}} adapter  the adapter module
 * @param {string|undefined} transport  the seat's declared transport
 * @returns {string|null}
 */
export function transportCredential(adapter, transport) {
  const klass = transportClass(transport);
  if (!klass) return null;
  const declared = adapter?.transports?.[klass];
  // An undeclared class reaching dispatch means the registry loader let through
  // a seat it should have rejected. Keep nothing rather than falling back to
  // ambient auth — falling back is the exact defect this module closes.
  if (!declared) return null;
  const env = declared.env;
  return typeof env === 'string' && env.length > 0 ? env : null;
}

/**
 * The `data` fields a dispatch carrier records about its transport.
 *
 * `transportStatus` is ALWAYS `selected` today: the credential context was
 * chosen for this call, and nothing here observed what the harness did with it.
 * This mirrors T152's `usageStatus: reported | claimed | unreported`, which
 * exists because shape validation cannot prove a provider reported anything —
 * the same reasoning applies to a transport label, one layer up.
 *
 * Returns an empty object for a seat with no transport, so a legacy dispatch
 * records exactly what it always did.
 */
export function transportEvidence(transport) {
  if (!transportClass(transport)) return {};
  return { transport, transportStatus: 'selected' };
}
