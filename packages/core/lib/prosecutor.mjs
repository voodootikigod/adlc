// prosecutor.mjs — P5 prosecution registry + pure orchestration helpers.
//
// Also home to recordFinding: the P5→P7 bridge. The in-harness prosecutor
// subagents report findings in prose but historically left NO trail in the
// findings ledger, so P7 lesson-foundry had nothing to cluster — the loop that
// is supposed to compound quietly no-opped. recordFinding is the deterministic
// writer the prosecutor surfaces call (once per confirmed finding) so recurring
// finding CLASSES accrue automatically.
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

import { appendEntry } from './ledger.mjs';

/**
 * Record a CONFIRMED prosecution finding to the findings ledger
 * (`.adlc/findings.jsonl`) in the shape lesson-foundry (P7) clusters on. This is
 * the bridge that keeps P7 fed: a finding surfaced by the prosecutor must leave a
 * durable trail, or the compounding step has nothing to mine.
 *
 * FAIL CLOSED on malformed input. A finding with no `file` or no `desc` is an
 * operator error — throw rather than append a junk entry or silently drop it (a
 * silent drop reproduces the exact gap this bridge exists to close). `desc` is the
 * clustering key, so it must be present and non-empty.
 *
 * @param {object} finding
 * @param {string} finding.file      repo-relative file the finding is in (required)
 * @param {string} finding.desc      plain-prose description; the clustering key (required).
 *                                    Prefer prose without quoted/backticked literals so it
 *                                    routes to a spec-gap template rather than a lint rule.
 * @param {string} [finding.category='prosecution']
 * @param {string} [finding.severity='medium']
 * @param {number} [finding.line=1]
 * @param {string} [finding.verdict='open']  'open'/'confirmed' cluster; only 'killed'
 *                                            (a refuted finding) is filtered by the foundry.
 * @param {string} [dir]  ledger dir; defaults to the ADLC_DIR appendEntry uses.
 * @returns {object} the appended entry
 */

export function recordFinding(finding, dir) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    throw new Error('recordFinding: finding must be an object');
  }
  const file = typeof finding.file === 'string' ? finding.file.trim() : '';
  const desc = typeof finding.desc === 'string' ? finding.desc.trim() : '';
  if (!file) throw new Error('recordFinding: finding.file is required');
  if (!desc) throw new Error('recordFinding: finding.desc is required (it is the clustering key)');
  // The publishability boundary lives in the ledger writer (assertPublishableFinding),
  // so EVERY producer is covered — not just this one. Nothing to duplicate here.

  const str = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const entry = {
    ts: new Date().toISOString(),
    tool: 'prosecutor',
    file,
    line: Number.isInteger(finding.line) && finding.line > 0 ? finding.line : 1,
    category: str(finding.category, 'prosecution'),
    severity: str(finding.severity, 'medium'),
    desc,
    verdict: str(finding.verdict, 'open'),
  };
  return appendEntry('findings', entry, dir);
}

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
