// ceremony-command-safety.test.mjs — no shipped doc may advertise the combined
// `--ceremony --write` invocation.
//
// WHY THIS IS A REPO-WIDE GUARD RATHER THAN FOUR EDITS
//
// `--ceremony --write` does not do only the ceremony. `--write` additionally
// tombstones rails-less stale tickets, which the preceding dry-run report does
// not list — so an operator following the instruction writes outside the set
// they just reviewed. Measured on a two-ticket fixture:
//
//   --ceremony --write  ->  railed=COMPLETED   rails-less=COMPLETED
//   --ceremony          ->  railed=COMPLETED   rails-less=untouched
//
// The instruction was duplicated across four shipped integrations plus the
// package README, and two of those copies are currently frozen by ACTIVE tickets
// (T51 owns plugins/adlc-claude-code/commands/**, T53 owns
// plugins/adlc-opencode/**). rails-guard correctly denies editing them, and
// ADLC_RAILS_BYPASS would mean overwriting files someone is building against
// right now — the bypass is for stale rails, not live ones.
//
// So instead of forcing those edits, the invariant is asserted here, with the two
// frozen files carried as EXPLICIT, TICKETED exceptions rather than silently
// skipped. The guard is live for every other shipped doc immediately, and the
// remaining debt is named, attributed, and visible in a test rather than living
// only in a PR description nobody re-reads.
//
// The exception list is SELF-CLEANING: a second test asserts every entry is still
// necessary, so the moment T51/T53 correct their file the exception itself starts
// failing and must be deleted. It cannot quietly become permanent.
//
// If you are here because this test is red: fix the listed file(s) by removing
// `--write` from the ceremony command. Add an exception ONLY if the path is
// frozen by an active ticket, and name that ticket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Tracked text files that could carry operator instructions. */
function trackedDocs() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split('\0').filter((f) => /\.(md|mdx|txt)$/.test(f));
}

// Matches the flags in either order, tolerating other flags between them, but
// only within a single command line — so prose *describing* the combination
// (e.g. a historical acceptance criterion) is not caught, only runnable lines.
const COMBINED = /^[^\n]*\bticket-prune\b[^\n]*(--ceremony[^\n]*--write|--write[^\n]*--ceremony)/;

// A usage synopsis lists every flag as an optional group:
//   ticket-prune [--tickets path] [--base-ref ref] [--write] [--ceremony] [--json]
// That is a flag LISTING, not an invocation combining them, and matching it would
// make the guard fire on every doc that documents the tool at all. Bracketed
// groups are removed before matching; a real command never brackets its flags.
const stripOptional = (line) => line.replace(/\[[^\]]*\]/g, '');

// Documents that intentionally record the combination as history rather than
// instructing anyone to run it. Narrow and explicit: a path only earns a place
// here if the mention is a record of what was verified, not a runnable step.
const HISTORICAL = new Set([
  'docs/specs/ticket-completion-rail-cleanup.md', // AC3 records the verified invocation
]);

// Known-bad files whose paths are frozen by an ACTIVE ticket, so the fix cannot
// land here. Each entry names the blocking ticket. Remove the entry with the fix.
const FROZEN_PENDING = new Map([
  ['plugins/adlc-claude-code/commands/adlc-maintain.md', 'T51 (active; rails plugins/adlc-claude-code/commands/**)'],
  ['plugins/adlc-opencode/command/adlc-maintain.md', 'T53 (active; rails plugins/adlc-opencode/**)'],
]);

const scanFor = (predicate) => {
  const hits = [];
  for (const file of trackedDocs()) {
    if (HISTORICAL.has(file)) continue;
    if (!predicate(file)) continue;
    let text;
    try { text = readFileSync(join(REPO, file), 'utf8'); } catch { continue; }
    for (const [i, line] of text.split('\n').entries()) {
      if (COMBINED.test(stripOptional(line))) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  }
  return hits;
};

test('no shipped doc advertises `ticket-prune --ceremony --write`', () => {
  const offenders = scanFor((f) => !FROZEN_PENDING.has(f));
  assert.deepEqual(offenders, [],
    'these files instruct an operator to run the ceremony with --write, which also ' +
    'completes rails-less tickets outside the reviewed set:\n  ' + offenders.join('\n  '));
});

// SELF-CLEANING. If a frozen file no longer carries the pattern, the exception has
// served its purpose and must go — otherwise the allowance outlives the problem
// and silently weakens the guard for that path forever.
test('every frozen-pending exception is still necessary', () => {
  const stale = [];
  for (const [file, ticket] of FROZEN_PENDING) {
    if (scanFor((f) => f === file).length === 0) stale.push(`${file} (was blocked by ${ticket})`);
  }
  assert.deepEqual(stale, [],
    'these files are fixed — delete their FROZEN_PENDING entries so the guard covers ' +
    'them again:\n  ' + stale.join('\n  '));
});

// Guards the guard: if the pattern stops matching the shape it is meant to catch,
// the test above would pass vacuously across the whole repo.
test('the detector matches the shapes it is meant to catch', () => {
  for (const line of [
    'ADLC_RAILS_BYPASS=1 adlc ticket-prune --ceremony --write --base-ref origin/main',
    'ADLC_RAILS_BYPASS=1 ticket-prune --write --ceremony',
    '  ADLC_RAILS_BYPASS=1 node packages/ticket-prune/bin/ticket-prune.mjs --ceremony --write',
  ]) {
    assert.ok(COMBINED.test(line), `should have matched: ${line}`);
  }
});

test('the detector does not flag the safe command, a usage synopsis, or lone --write', () => {
  for (const line of [
    'ADLC_RAILS_BYPASS=1 adlc ticket-prune --ceremony --base-ref origin/main',
    'ticket-prune --write', // tombstoning alone is a legitimate, separate operation
    'ticket-prune --base-ref origin/main --json',
    // Usage synopsis: lists both flags as optional, does not invoke them together.
    'ticket-prune [--tickets path] [--base-ref ref] [--write] [--ceremony] [--json]',
  ]) {
    assert.ok(!COMBINED.test(stripOptional(line)), `should NOT have matched: ${line}`);
  }
});
