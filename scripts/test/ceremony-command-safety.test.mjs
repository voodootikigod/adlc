// ceremony-command-safety.test.mjs — no shipped doc may advertise the combined
// `--ceremony --write` invocation, and the completion command the reporter
// renders must be non-interactive.
//
// WHY THIS IS A REPO-WIDE GUARD RATHER THAN N EDITS
//
// `--ceremony --write` does not do only the ceremony. `--write` additionally
// tombstones rails-less stale tickets, which the preceding dry-run report does
// not list — so an operator following the instruction writes outside the set
// they just reviewed. Measured on a two-ticket fixture:
//
//   --ceremony --write  ->  railed=COMPLETED   rails-less=COMPLETED
//   --ceremony          ->  railed=COMPLETED   rails-less=untouched
//
// The instruction was duplicated across the four `/adlc:adlc-maintain` docs plus
// the package README and the sweep runbook. This guard asserts none of them
// advertise the unsafe form, and fails loudly if a new doc reintroduces it.
//
// (History: two of those files were once frozen by active tickets T51/T53, and
// this guard carried a self-cleaning `FROZEN_PENDING` exception for them. T51/T53
// completed, the rails expired, the files were fixed — so the exception is gone
// and the guard is now unconditional. If a future ticket ever freezes a doc that
// carries the unsafe command, reinstate a named, self-cleaning exception rather
// than a bare skip; see the git history of this file for the pattern.)
//
// If you are here because this test is red: remove `--write` from the
// `ticket-prune --ceremony` command in the listed file(s).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { detectTicketStore, shouldOfferLegacyMigration } from '../../packages/tickets/index.mjs';

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

// #208: no doc may show a RUNNABLE `ticket-prune --ceremony` command line (the
// flag is deprecated; completion is per-ticket via `adlc ticket complete`). This
// must fire ONLY on a command line, not on prose that mentions the flag (the
// deprecation notes do). A command line starts — after optional indent, a `$ `
// prompt, or an `ENV=val ` prefix — with the invocation token itself; a prose
// mention has a backtick or other text before `ticket-prune`. Anchoring at line
// start after those prefixes is what makes the distinction.
const RUNNABLE_CEREMONY =
  /^\s*(\$ )?([A-Z_]+=\S+ )*(node \S*|adlc )?ticket-prune(\.mjs)?\s[^\n]*--ceremony\b/;

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

// A line offends if it advertises the --ceremony --write combination OR shows a
// runnable `ticket-prune --ceremony` command (deprecated, #208). Both fire only
// on runnable lines, never on prose that mentions the flag.
const lineOffends = (line) => COMBINED.test(stripOptional(line)) || RUNNABLE_CEREMONY.test(line);

function offenders() {
  const hits = [];
  for (const file of trackedDocs()) {
    if (HISTORICAL.has(file)) continue;
    let text;
    try { text = readFileSync(join(REPO, file), 'utf8'); } catch { continue; }
    for (const [i, line] of text.split('\n').entries()) {
      if (lineOffends(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  }
  return hits;
}

// ---- the repo-wide guard (no exceptions) ----

test('no shipped doc advertises a runnable `ticket-prune --ceremony` command', () => {
  assert.deepEqual(offenders(), [],
    'these files show a runnable ticket-prune --ceremony command; it is deprecated ' +
    '(and --write also completes rails-less tickets outside the reviewed set). ' +
    'Complete per-ticket with `adlc ticket complete <id> --write --authorize --json`:\n  ' +
    offenders().join('\n  '));
});

// Guards the guard: if the patterns stop matching the shapes they target, the test
// above would pass vacuously across the whole repo.
test('the detector matches the runnable shapes it is meant to catch', () => {
  for (const line of [
    'ADLC_RAILS_BYPASS=1 adlc ticket-prune --ceremony --write --base-ref origin/main',
    'ADLC_RAILS_BYPASS=1 ticket-prune --write --ceremony',
    '  ADLC_RAILS_BYPASS=1 node packages/ticket-prune/bin/ticket-prune.mjs --ceremony --write',
    'ADLC_RAILS_BYPASS=1 adlc ticket-prune --ceremony --base-ref origin/main', // bare ceremony, still runnable
    '  ticket-prune --ceremony',
  ]) {
    assert.ok(lineOffends(line), `should have matched: ${line}`);
  }
});

test('the detector does not flag prose mentions, a usage synopsis, or lone --write', () => {
  for (const line of [
    // Prose mentions of the deprecated flag — must NOT be flagged.
    '`ticket-prune --ceremony` is deprecated; use `adlc ticket complete <id>` instead.',
    'the deprecated bulk `ticket-prune --ceremony` (evidence-less, legacy-store-only; #208).',
    '| `--ceremony` | **Deprecated (#208).** Fails closed and redirects. |',
    'ticket-prune --write', // tombstoning alone is a legitimate, separate operation
    'ticket-prune --base-ref origin/main --json',
    // Usage synopsis: lists flags as optional groups, does not invoke them.
    'ticket-prune [--tickets path] [--base-ref ref] [--write] [--json]',
  ]) {
    assert.ok(!lineOffends(line), `should NOT have matched: ${line}`);
  }
});

// ---- the reporter's completion command is non-interactive ----
//
// `adlc ticket complete <id> … --json`. The `--json` is load-bearing: on a legacy
// store the CLI otherwise offers an interactive migration before mutating, and an
// admin who accepted it would migrate the WHOLE store to complete one ticket.

test('--json suppresses the legacy-migration offer even when both streams are a TTY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-guard-legacy-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T7', title: 'x' }] }));
    const store = detectTicketStore({ root: dir });
    assert.equal(store.constructor.name, 'LegacyTicketStore');
    const tty = { input: { isTTY: true }, output: { isTTY: true } };
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
  assert.match(body, /adlc ticket complete T7 --write --authorize --json/);
});
