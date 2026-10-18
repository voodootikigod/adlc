#!/usr/bin/env node
// Independent secret/dump scan of the COMMITTED findings ledger.
//
// The write-time boundary in `appendEntries` (assertPublishableFinding) only sees
// entries that go THROUGH the append API. Now that `.adlc/findings.jsonl` is tracked
// (ADR 0014), it can also be modified by a manual edit, a merge/conflict resolution, a
// script that writes the file directly, or a plain `git add` of a hand-crafted line —
// none of which touch that API. This scan re-reads the whole committed ledger and
// applies the SAME publishability rule to every line, independent of how it got there.
// It is the git-boundary backstop the ADR calls for; run it in preflight and CI.
//
// Exit codes: 0 = clean (or no ledger), 2 = a line is not publishable, 1 = read error.

import { pathToFileURL } from 'node:url';
import { LEDGER, scanFindingsLedger as scan } from '../packages/lesson-foundry/lib/ledger-guard.mjs';

export { LEDGER, scan };

// CLI entry — skipped when this module is imported (so a unit test can assert scan()'s
// exact return value without the top-level call scanning the importer's real ledger).
// pathToFileURL, not a hand-built URL: import.meta.url is percent-encoded, so
// a raw `file://` + argv[1] never matches from a path containing a space.
if (Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = scan(process.argv[2] ?? LEDGER);
}
