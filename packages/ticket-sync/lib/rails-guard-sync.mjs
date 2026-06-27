// rails-guard-sync.mjs — local defense-in-depth for a pull (design "Sync vs the
// rails trust root"). Pure. The AUTHORITATIVE protection is the CI + human gate;
// this catches the common accident early and refuses unless --allow-rail-narrowing.
//
// Decidable, conservative, string-set rules (no glob-containment reasoning):
//   rails:  incoming MUST be a superset of local  (removal/replacement → flag)
//   scope:  incoming MUST be a subset of local     (any widening → flag)

const setOf = (a) => new Set(Array.isArray(a) ? a : []);

/**
 * @param {{ localRails?, incomingRails?, localScope?, incomingScope? }} args
 * @returns {{ ok: boolean, violations: Array<{kind, value}> }}
 */
export function railScopeGuard({ localRails, incomingRails, localScope, incomingScope } = {}) {
  const violations = [];
  const incRails = setOf(incomingRails);
  for (const r of setOf(localRails)) {
    if (!incRails.has(r)) violations.push({ kind: 'rail-removed', value: r });
  }
  const locScope = setOf(localScope);
  for (const s of setOf(incomingScope)) {
    if (!locScope.has(s)) violations.push({ kind: 'scope-widened', value: s });
  }
  return { ok: violations.length === 0, violations };
}

/** Human-readable summary for the CLI / forensic record. */
export function describeViolations(violations) {
  return violations
    .map((v) => (v.kind === 'rail-removed' ? `rail removed/replaced: ${v.value}` : `scope widened: ${v.value}`))
    .join('; ');
}
