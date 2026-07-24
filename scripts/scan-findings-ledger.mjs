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

const LEDGER = process.argv[2] ?? '.adlc/findings.jsonl';

if (!existsSync(LEDGER)) {
  console.log(`scan-findings-ledger: no ledger at ${LEDGER} — nothing to scan.`);
  process.exit(0);
}

let text;
try {
  text = readFileSync(LEDGER, 'utf8');
} catch (err) {
  console.error(`scan-findings-ledger: cannot read ${LEDGER}: ${err.message}`);
  process.exit(1);
}

const lines = text.split('\n');
const violations = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (err) {
    // A malformed line is itself suspect in a committed, curated ledger. Scan the raw
    // text so a secret smuggled into un-parseable bytes is still caught.
    entry = { desc: line };
    void err;
  }
  try {
    assertPublishableFinding(entry);
  } catch (err) {
    violations.push({ line: i + 1, reason: err.message });
  }
}

if (violations.length > 0) {
  console.error(`scan-findings-ledger: ${violations.length} line(s) in ${LEDGER} are not publishable:`);
  for (const v of violations) console.error(`  line ${v.line}: ${v.reason}`);
  console.error('\nThis file is committed to git. Describe the failure class instead of quoting the value (ADR 0014).');
  process.exit(2);
}

console.log(`scan-findings-ledger: ${lines.filter((l) => l.trim()).length} ledger line(s) clean.`);
process.exit(0);
