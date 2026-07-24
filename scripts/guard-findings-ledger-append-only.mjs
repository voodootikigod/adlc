#!/usr/bin/env node
// Enforce that the committed findings ledger (.adlc/findings.jsonl, ADR 0014) is only ever
// EXTENDED across a change — never truncated, rewritten, or deleted.
//
// Why this is a separate, git-boundary guard:
//   The ledger is durable P5->P7 memory. The P5 prosecutor appends findings; the P7
//   lesson-foundry reads them to turn a repeated finding into a permanent defense. That
//   compounding loop only works if the trail persists. `appendEntries` is the SOLE writer
//   and only ever appends, so the ledger is append-only by construction — but a deletion or
//   in-place rewrite happens OUTSIDE that API (an `rm`, a hand edit, a bad merge), where the
//   write-path guards cannot see it. The secret/dump scanner (scan-findings-ledger.mjs)
//   inspects a single tree, so a PR that DELETES the ledger passes it with nothing to scan.
//   This guard closes that gap: it fails the build when the base ledger is not a prefix of
//   the head ledger.
//
// Compared against the MERGE-BASE of <base-ref> and HEAD (not the base tip), so findings
// appended to main by OTHER PRs since this branch diverged are not miscounted as "removed".
//
// Usage: node scripts/guard-findings-ledger-append-only.mjs <base-ref>
// Exit 0 = append-only (or the ledger is new at the base); 2 = a base finding was
// removed/rewritten; 1 = misuse (no base ref).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export const LEDGER = '.adlc/findings.jsonl';

function defaultGit(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * Resolve the base ledger content, distinguishing "base is a real commit with no ledger yet"
 * (legitimately nothing to protect) from "base ref does not resolve at all" (an operational
 * failure that must NOT be silently treated as an empty base — that would let a deletion pass
 * on a misspelled/deleted/unfetched base).
 *
 * @returns { resolved: true, text } when the base resolves (text '' ONLY when the ledger is
 *          genuinely absent from the base tree), or { resolved: false } when the base ref
 *          cannot be resolved OR the base ledger cannot be read for any operational reason.
 */
export function baseLedger(baseRef, run = defaultGit) {
  let point = null;
  // Prefer the merge-base so findings other PRs added to the base are not counted removed.
  try { point = run('merge-base', baseRef, 'HEAD').trim(); }
  catch { /* no merge-base (unrelated/shallow history) — verify the ref directly below */ }
  if (!point) {
    try { point = run('rev-parse', '--verify', `${baseRef}^{commit}`).trim(); }
    catch { return { resolved: false }; } // the base ref itself does not resolve → fail closed
  }
  // Separate "ledger genuinely absent at base" from an operational read failure. `git ls-tree`
  // on a resolved commit exits 0 with EMPTY output when the path is not in the tree, and
  // prints a tree entry when it is — so ONLY empty output is the safe "nothing to protect"
  // case. A corrupt/missing object, an fs error, or the blob being present-but-unreadable must
  // NOT be collapsed into an empty base (that would let a deletion pass); they fail closed.
  let listed;
  try { listed = run('ls-tree', point, '--', LEDGER); }
  catch { return { resolved: false }; } // cannot even inspect the base tree → fail closed
  if (!listed.trim()) return { resolved: true, text: '' }; // ledger genuinely absent at base
  try { return { resolved: true, text: run('show', `${point}:${LEDGER}`) }; }
  catch { return { resolved: false }; } // present in the tree but unreadable → fail closed
}

/** The ledger content in the working tree ('' if absent). Reads the WORKING copy so an
 *  uncommitted deletion is caught too, not only a committed one. */
export function headLedgerText(read = readFileSync, exists = existsSync) {
  return exists(LEDGER) ? read(LEDGER, 'utf8') : '';
}

const nonEmptyLines = (text) => text.split('\n').filter((line) => line.trim() !== '');

/**
 * Return the list of append-only violations: `head` must be exactly `base` followed by
 * zero-or-more appended lines. An in-place rewrite of an existing finding and a removal of
 * any existing finding are both violations.
 */
export function appendOnlyViolations(baseText, headText) {
  const base = nonEmptyLines(baseText);
  const head = nonEmptyLines(headText);
  const violations = [];
  const common = Math.min(base.length, head.length);
  for (let i = 0; i < common; i++) {
    if (head[i] !== base[i]) {
      violations.push(
        `finding on line ${i + 1} was rewritten relative to the base — existing findings are immutable (append-only)`,
      );
      break; // the first divergence is enough to fail; more would be noise
    }
  }
  if (head.length < base.length) {
    violations.push(
      `the base ledger had ${base.length} finding(s); head has only ${head.length} — ` +
      `${base.length - head.length} removed (deletion or truncation)`,
    );
  }
  return violations;
}

export function guard(baseRef, { run = defaultGit, read = readFileSync, exists = existsSync } = {}) {
  const base = baseLedger(baseRef, run);
  if (!base.resolved) {
    // Fail CLOSED (operational error), never fall through to an empty-base pass: an
    // unresolvable base means we cannot verify the ledger at all, and treating that as
    // "nothing to protect" would let a deletion or rewrite slip through on a bad base.
    console.error(
      `guard-findings-ledger-append-only: base ref '${baseRef}' does not resolve to a commit ` +
      `(unfetched, misspelled, or deleted). Refusing to verify the ledger against an unknown ` +
      `base — fetch/spell the base ref correctly and re-run.`,
    );
    return 1;
  }
  const violations = appendOnlyViolations(base.text, headLedgerText(read, exists));
  if (violations.length > 0) {
    console.error(`guard-findings-ledger-append-only: ${LEDGER} is not append-only vs ${baseRef}:`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      `\nThe findings ledger is durable P5->P7 memory (ADR 0014): findings are only ever ` +
      `appended, and dropping one erases the trail that lets a repeated finding become a ` +
      `banked defense. Restore the base findings and append any new ones.`,
    );
    return 2;
  }
  console.log(`guard-findings-ledger-append-only: ${LEDGER} is append-only vs ${baseRef}.`);
  return 0;
}

// CLI entry — skipped when this module is imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error('usage: guard-findings-ledger-append-only.mjs <base-ref>');
    process.exitCode = 1;
  } else {
    process.exitCode = guard(baseRef);
  }
}
