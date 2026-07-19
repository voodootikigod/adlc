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
import { detectTicketStore, shouldOfferLegacyMigration } from '../../packages/tickets/index.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
// land here. Keyed by file → the ticket id whose rails freeze it. The exception
// is valid ONLY while that ticket is genuinely active; the self-cleaning test
// below verifies that against the live store, not just the file text.
const FROZEN_PENDING = new Map([
  ['plugins/adlc-claude-code/commands/adlc-maintain.md', 'T51'],
  ['plugins/adlc-opencode/command/adlc-maintain.md', 'T53'],
]);

/**
 * Load the active ticket set through the canonical store detector, which handles
 * BOTH backends. Reading `.adlc/tickets.json` directly (as an earlier version
 * did) throws ENOENT the moment the repo migrates to the directory store
 * (`.adlc/tickets/`) — and the completion command this very branch advertises can
 * trigger that migration — which would turn this guard into a red wall on every
 * subsequent PR. Going through detectTicketStore keeps it backend-agnostic.
 */
function loadTickets() {
  return detectTicketStore({ root: REPO }).load().tickets ?? [];
}

/** A ticket is active iff it is present in the store and not `completed`. */
function activeTicketIds() {
  return new Set(loadTickets().filter((t) => t?.completed !== true).map((t) => t?.id));
}

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

test('no shipped doc advertises `ticket-prune --ceremony --write` (except the two rail-frozen files tracked in FROZEN_PENDING)', () => {
  const offenders = scanFor((f) => !FROZEN_PENDING.has(f));
  assert.deepEqual(offenders, [],
    'these files instruct an operator to run the ceremony with --write, which also ' +
    'completes rails-less tickets outside the reviewed set:\n  ' + offenders.join('\n  '));
});

// SELF-CLEANING, on TWO independent conditions — either dissolves the exception:
//
//   (a) the file no longer carries the unsafe command (someone fixed it), or
//   (b) the blocking ticket is no longer active (its rails expired, so the file
//       is now editable and the exception has no justification left).
//
// A previous version checked only (a). That let the exception outlive its
// blocker: once T51/T53 completed, the file stayed editable and unsafe, yet the
// suite stayed green because the bad text was still there and still excused. An
// exception that survives the removal of its own justification is not a temporary
// allowance, it is a permanent hole. Failing on (b) forces the fix the moment the
// rail unfreezes.
test('every frozen-pending exception is still justified (file unfixed AND blocker active)', () => {
  const active = activeTicketIds();
  const invalid = [];
  for (const [file, ticket] of FROZEN_PENDING) {
    const stillUnsafe = scanFor((f) => f === file).length > 0;
    if (!stillUnsafe) {
      invalid.push(`${file}: fixed — remove its FROZEN_PENDING entry so the guard covers it again`);
    } else if (!active.has(ticket)) {
      invalid.push(`${file}: blocking ticket ${ticket} is no longer active — the rail has expired, ` +
        `so fix the file (remove --write) and delete this exception`);
    }
  }
  assert.deepEqual(invalid, [], 'stale FROZEN_PENDING exceptions:\n  ' + invalid.join('\n  '));
});

// The exception file names two ticket ids; if a typo or rename made them
// unresolvable, `activeTicketIds()` would never contain them and (b) would fire —
// but assert presence explicitly so the failure reads as "unknown ticket" rather
// than "blocker completed".
test('every frozen-pending blocker id exists in the ticket store', () => {
  const known = new Set(loadTickets().map((t) => t?.id));
  for (const ticket of FROZEN_PENDING.values()) {
    assert.ok(known.has(ticket), `FROZEN_PENDING names ${ticket}, which is not in the ticket store`);
  }
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


// ---- F3: the guard loads through the canonical detector, so a directory-store
// migration does not turn it into a red wall ----

test('the ticket loader works on a directory-store fixture (no ENOENT after migration)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-guard-dir-'));
  try {
    mkdirSync(join(dir, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets', '.store.json'),
      JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    // A directory store keyed by the canonical hashed shard name.
    const store = detectTicketStore({ root: dir });
    // Loading must not throw (the old readFileSync('.adlc/tickets.json') did).
    assert.doesNotThrow(() => store.load());
    assert.equal(store.constructor.name, 'DirectoryTicketStore');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F4: the advertised command carries --json, which suppresses the
// interactive legacy->directory migration even in an administrator's TTY ----

test('--json suppresses the legacy-migration offer even when both streams are a TTY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-guard-legacy-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T7', title: 'x' }] }));
    const store = detectTicketStore({ root: dir });
    assert.equal(store.constructor.name, 'LegacyTicketStore');
    const tty = { input: { isTTY: true }, output: { isTTY: true } };
    // The exact gate the advertised command relies on: with --json it does NOT
    // offer migration; without it (the hazard) it would.
    assert.equal(shouldOfferLegacyMigration(store, { json: true }, tty), false,
      '--json must suppress the migration prompt, so the one-ticket command stays one-ticket');
    assert.equal(shouldOfferLegacyMigration(store, { json: false }, tty), true,
      'sanity: without --json the offer is what would fire');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The advertised command must actually contain --json, or the suppression above
// is moot. Cross-checks the reporter against this guard.
test('the reporter renders the completion command WITH --json', async () => {
  const { renderIssueBody } = await import('../ceremony-drift.mjs');
  const body = renderIssueBody([{ id: 'T7', reason: 'explicit status: "done"', rails: ['a/**'], blocker: 'rails-freeze' }]);
  assert.match(body, /adlc-tickets complete T7 --write --authorize --json/);
});
