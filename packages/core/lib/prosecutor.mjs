// prosecutor.mjs — P5 prosecution registry + pure orchestration helpers.
//
// Extracted to @adlc/core (T17, issue-#97 pattern) from the byte-duplicated
// plugins/adlc-claude-code/lib/prosecutor.mjs and
// plugins/adlc-opencode/lib/prosecutor.mjs, which are now thin re-export shims
// over this module. The lenses and verifier are harness-specific subagents
// (Claude Code: agents/prosecutor-*.md; OpenCode: agent/prosecutor-*.md) or
// inline command sections (Cursor: command/adlc-prosecute.md). This module is
// the machine-checkable contract for the prosecution loop: which lenses exist,
// how findings are deduped across lenses, and how the verifier's votes decide
// whether a finding survives. The model calls live in the harness surfaces;
// the decision logic here is pure and unit-tested — this is what makes the
// convergence loop *correct*, not just structurally present in a prompt.

/** The five independent prosecution lenses. */
export const LENSES = [
  { key: 'correctness', agent: 'prosecutor-correctness', focus: 'logic errors, broken invariants, wrong results' },
  { key: 'security', agent: 'prosecutor-security', focus: 'auth/trust boundaries, injection, secrets, unsafe data flow' },
  { key: 'contract', agent: 'prosecutor-contract', focus: 'API/schema/type conformance against the declared contract' },
  { key: 'diff', agent: 'prosecutor-diff', focus: 'spec-vs-implementation divergence; unstated behavior changes' },
  { key: 'tests', agent: 'prosecutor-tests', focus: 'hollow/mock-only tests; are the new tests load-bearing?' },
];

/** The verifier/reproducer agent that adversarially checks each finding. */
export const VERIFIER = { key: 'verifier', agent: 'prosecutor-verifier', focus: 'reproduce/refute a finding' };

/** Every shipped prosecution agent id (5 lenses + verifier). */
export const ALL_AGENTS = [...LENSES.map((l) => l.agent), VERIFIER.agent];

/** Stable key for a finding (file + line range + normalized title). */
export function findingKey(f) {
  const title = (f.title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${f.file ?? ''}:${f.line_start ?? 0}-${f.line_end ?? 0}:${title}`;
}

/** Dedupe findings across lenses, keeping the highest-severity instance. */
export function dedupeFindings(findings) {
  const SEV = { critical: 4, high: 3, medium: 2, low: 1 };
  const byKey = new Map();
  for (const f of findings ?? []) {
    const k = findingKey(f);
    const prev = byKey.get(k);
    if (!prev || (SEV[f.severity] ?? 0) > (SEV[prev.severity] ?? 0)) byKey.set(k, f);
  }
  return [...byKey.values()];
}

/**
 * Decide whether a finding survives verification. Votes are the verifier's
 * independent verdicts ({ real: boolean }). With votes present, a finding survives
 * if a strict majority confirm it real (default), so a single noisy lens can't
 * sink a ship and a single weak confirmation can't pass a false one.
 *
 * FAIL CLOSED on absent verification: a pre-merge gate must not let a verifier
 * crash, timeout, or parse failure silently DROP a finding. With zero valid votes
 * the finding SURVIVES as an unverified blocker — surface it, don't bury it.
 *
 * A vote is VALID only when `real` is a boolean. A truthy-but-malformed vote
 * (`{}`, `{ real: null }` for cannot-decide, a partially-parsed object) is NOT a
 * refutation — counting it in the denominator would let one malformed verifier
 * verdict silently drop a real blocker, defeating the fail-closed contract. Such
 * votes are discarded; if none remain valid, the finding survives.
 */
export function survivesVerification(votes, { threshold = 0.5 } = {}) {
  const list = (votes ?? []).filter((v) => v && typeof v.real === 'boolean');
  if (!list.length) return true; // unverified → keep as a blocker (fail closed)
  const real = list.filter((v) => v.real === true).length;
  return real / list.length > threshold;
}

/**
 * Loop-until-dry controller: stop prosecuting once `maxDry` consecutive rounds
 * surface no new confirmed findings. Pure: caller tracks state, this decides.
 */
export function shouldContinue({ freshThisRound, dryStreak, maxDry = 2 }) {
  const nextDry = freshThisRound > 0 ? 0 : dryStreak + 1;
  return { continue: nextDry < maxDry, dryStreak: nextDry };
}
