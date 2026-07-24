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

import { readFileSync, existsSync } from 'node:fs';
import { assertPublishableFinding } from '@adlc/core';

// Set process.exitCode and RETURN — never process.exit() here. process.exit terminates
// before buffered stdout/stderr is flushed, so a caller capturing our diagnostics (our
// own tests, or a CI log) can see empty output on failure. Setting exitCode lets the
// process end naturally once the streams drain.
export function scan(ledger) {
  if (!existsSync(ledger)) {
    console.log(`scan-findings-ledger: no ledger at ${ledger} — nothing to scan.`);
    return 0;
  }

  let text;
  try {
    text = readFileSync(ledger, 'utf8');
  } catch (err) {
    console.error(`scan-findings-ledger: cannot read ${ledger}: ${err.message}`);
    return 1;
  }

  const lines = text.split('\n');
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A malformed line is a violation on its own, not merely a secret risk. The ledger
      // is committed and curated, and `readEntries` SILENTLY SKIPS an unparseable line —
      // so a corrupt record would pass the gate while starving lesson-foundry of that
      // finding. Fail on it. Also scan the raw text so a secret hidden in the corrupt
      // bytes is named too.
      violations.push({ line: i + 1, reason: 'malformed JSONL record — a committed ledger must be valid JSON (readEntries silently skips this, starving lesson-foundry)' });
      try { assertPublishableFinding({ desc: line }); } catch (err) { violations.push({ line: i + 1, reason: err.message }); }
      continue;
    }
    try {
      assertPublishableFinding(entry);
    } catch (err) {
      violations.push({ line: i + 1, reason: err.message });
    }
  }

  if (violations.length > 0) {
    console.error(`scan-findings-ledger: ${violations.length} line(s) in ${ledger} are not publishable:`);
    for (const v of violations) console.error(`  line ${v.line}: ${v.reason}`);
    console.error('\nThis file is committed to git. Describe the failure class instead of quoting the value (ADR 0014).');
    return 2;
  }

  console.log(`scan-findings-ledger: ${lines.filter((l) => l.trim()).length} ledger line(s) clean.`);
  return 0;
}

// CLI entry — skipped when this module is imported (so a unit test can assert scan()'s
// exact return value without the top-level call scanning the importer's real ledger).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = scan(process.argv[2] ?? '.adlc/findings.jsonl');
}
