// risk.mjs — risk-tier derivation per ticket (issue #48, item 1).
//
// A ticket's risk tier is 'high' when EITHER it declares `risk: 'high'` OR any
// derived signal fires from fields already on the ticket. This is deliberately
// OR, not a priority override: a declared `risk: 'normal'` can never suppress a
// derived-high signal. Letting a normal declaration downgrade a real signal
// would be a silent, undetectable way to defeat the entire gate — exactly the
// failure mode this ticket exists to close (see build-gate-fitness.md).
//
// Pure, dependency-light (only @adlc/core's globMatch), and reusable by any
// harness (Path A) as well as the Claude Code hook (Path B).

import { globMatch } from '@adlc/core/tickets';

/**
 * Paths that constitute the ADLC "trust root": the ticket store itself, the
 * active-ticket pointer used across every harness integration (see
 * plugins/adlc-codex/hooks/adlc-rails-guard.mjs, plugins/adlc-antigravity/
 * rails-checker.mjs, et al.), and the gate-evidence ledger. A ticket whose
 * declared scope/rails touch any of these is high risk by definition — it can
 * rewrite the record of what gates have verified.
 */
export const TRUST_ROOT_PATHS = ['.adlc/tickets.json', '.adlc/current-ticket.json'];

/** The manifest ledger is checked separately so its signal name is specific. */
export const MANIFEST_PATH = '.adlc/manifest.jsonl';

/**
 * Ticket categories that model-router already treats as requiring frontier
 * models (see packages/model-router/lib/assign.mjs FRONTIER_CATEGORIES). Of
 * those, 'contract' and 'architecture' are inherently high blast-radius —
 * 'spec' is deliberately excluded here (a spec ticket does not itself mutate
 * the trust root or an external system).
 */
export const HIGH_RISK_CATEGORIES = new Set(['contract', 'architecture']);

/** True if any glob in `globs` matches (or literally equals) any of `paths`. */
function touchesAny(globs, paths) {
  return (globs ?? []).some((g) => paths.some((p) => g === p || globMatch(g, p)));
}

/**
 * Derive the list of high-risk signal names that fire for a ticket. Returns
 * [] for a ticket with no risk markers at all (empty ticket, or a plain
 * feature ticket with no scope overlap).
 *
 * @param {object} ticket
 * @returns {string[]} signal names, e.g. ['declared-risk-high', 'mutates-manifest']
 */
export function deriveRiskSignals(ticket) {
  const t = ticket ?? {};
  const signals = [];

  if (t.risk === 'high') signals.push('declared-risk-high');

  // Writes back to / creates / deletes in an external system (e.g. an issue
  // tracker create+id-reassignment, per the T9/ticket-sync motivating example
  // in issue #48). Declared explicitly — there is no way to derive this from
  // scope globs alone.
  if (t.external === true) signals.push('external-system-effect');

  // Mutates identity (e.g. reassigning a ticket's own id/edges store-wide).
  if (t.mutatesIdentity === true) signals.push('mutates-identity');

  // A malformed (present but non-array) scope/rails field is ambiguous ticket
  // data, not proof of safety — per the fail-closed design at the top of this
  // file, ambiguity must fire a signal rather than be silently ignored or
  // allowed to crash the caller. Array.isArray guards the spread below; the
  // signal push ensures the malformed field still drives the tier to 'high'.
  if (t.scope !== undefined && !Array.isArray(t.scope)) signals.push('malformed-scope');
  if (t.rails !== undefined && !Array.isArray(t.rails)) signals.push('malformed-rails');

  const combinedGlobs = [
    ...(Array.isArray(t.scope) ? t.scope : []),
    ...(Array.isArray(t.rails) ? t.rails : []),
  ];

  if (touchesAny(combinedGlobs, [MANIFEST_PATH])) signals.push('mutates-manifest');
  if (touchesAny(combinedGlobs, TRUST_ROOT_PATHS)) signals.push('touches-trust-root');

  if (HIGH_RISK_CATEGORIES.has(t.category)) signals.push(`high-risk-category:${t.category}`);

  return signals;
}

/**
 * Compute the risk tier for a ticket.
 *
 * @param {object} ticket
 * @returns {{ tier: 'high'|'normal', signals: string[] }}
 */
export function computeRiskTier(ticket) {
  const signals = deriveRiskSignals(ticket);
  return { tier: signals.length > 0 ? 'high' : 'normal', signals };
}
