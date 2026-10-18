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

import { pathToFileURL } from 'node:url';
import {
  LEDGER,
  baseLedger,
  headLedgerText,
  appendOnlyViolations,
  guardFindingsLedgerAppendOnly as guard,
} from '../packages/lesson-foundry/lib/ledger-guard.mjs';

export { LEDGER, baseLedger, headLedgerText, appendOnlyViolations, guard };

// CLI entry — skipped when this module is imported by a test.
// pathToFileURL, not a hand-built URL: import.meta.url is percent-encoded, so
// a raw `file://` + argv[1] never matches from a path containing a space.
if (Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error('usage: guard-findings-ledger-append-only.mjs <base-ref>');
    process.exitCode = 1;
  } else {
    process.exitCode = guard(baseRef);
  }
}
