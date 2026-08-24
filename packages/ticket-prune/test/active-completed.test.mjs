// #311 — the "Active tickets" listing must exclude completed tickets.
//
// The ADLC completion-lifecycle invariant: `completed: true` is THE ticket
// completion marker, and every backlog consumer must filter on it — it is
// already enforced in the rails union, in the backlog enumerators' activeTickets,
// and by ticket-prune's own tombstone write. The active-set computation was the
// one consumer that never consulted it: classifyTicket reads `status` (and, with
// no status, scope existence), so a completed ticket carrying no status — or a
// status that is not done-shaped — comes back `stale: false` and was reported as
// ACTIVE. On this repo after the 1.11.0 completion sweep that was 20 of 27 rows.
//
// The fix is a single point: the active set excludes `completed === true`. These
// tests pin the corrected set on BOTH backends and on both the dry-run and
// --write return paths, plus the two boundaries that a careless filter would get
// wrong (a completed+done ticket must still be reported STALE, and a deliberate
// `completed: false` must still be reported ACTIVE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTicketPrune } from '../lib/run.mjs';
import { renderReport } from '../lib/format.mjs';
import { ticketFilename } from '@adlc/tickets';

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Scratch repo with one shipped feature committed, so a ticket scoped to it
 * classifies stale and a ticket scoped elsewhere classifies not-stale. */
function setupScratchRepo(dir) {
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, 'plugins', 'adlc-widget'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'adlc-widget', 'index.mjs'), '// shipped\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'ship the widget'], dir);
}

function withScratchRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-active-'));
  try {
    setupScratchRepo(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTickets(dir, tickets) {
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
}

function writeDirectoryStore(dir, tickets) {
  const store = join(dir, '.adlc', 'tickets');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
  for (const t of tickets) writeFileSync(join(store, ticketFilename(t.id)), JSON.stringify(t));
}

/** The mixed set the issue describes: completed tickets that classifyTicket
 * cannot see (no status / non-done status / rails), plus one genuinely active
 * ticket. Every scope points at a path that does NOT exist on the base ref, so
 * `stale` is empty and the ONLY thing separating these rows is `completed`. */
function mixedTickets() {
  return [
    { id: 'DONE-NO-STATUS', title: 'completed, no status field', scope: ['packages/never-built/**'], completed: true },
    { id: 'DONE-WITH-STATUS', title: 'completed, non-done status', status: 'in-progress', scope: ['packages/never-built/**'], completed: true },
    { id: 'DONE-RAILED', title: 'completed, still declares rails', scope: ['packages/never-built/**'], rails: ['a', 'b'], completed: true },
    { id: 'STILL-ACTIVE', title: 'genuinely active', scope: ['packages/never-built/**'] },
  ];
}

test('#311 legacy store dry-run: completed tickets (with AND without a status field) are excluded from the active set', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, mixedTickets());

    const result = runTicketPrune({ cwd: dir });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.active.map((r) => r.id),
      ['STILL-ACTIVE'],
      'only the ticket without completed:true is active',
    );
    // Nothing was stale here, so a completed id appearing ANYWHERE in the
    // rendered report means it was reported as active.
    const text = renderReport(result);
    assert.match(text, /Active tickets \(1\)/);
    assert.doesNotMatch(text, /DONE-NO-STATUS/);
    assert.doesNotMatch(text, /DONE-WITH-STATUS/);
    assert.doesNotMatch(text, /DONE-RAILED/);
    assert.match(text, /- STILL-ACTIVE:/);
  });
});

test('#311 legacy store --write: the active set on the write return path excludes completed tickets too', () => {
  withScratchRepo((dir) => {
    // One rails-less shipped ticket so the write path actually runs (a --write
    // with nothing stale returns early through the dry-run branch).
    writeTickets(dir, [
      ...mixedTickets(),
      { id: 'SHIPPED', title: 'rails-less shipped', scope: ['plugins/adlc-widget/**'] },
    ]);

    // DONE-RAILED declares rails, so this store is a frozen trust root and the
    // write must be signable — incidental to the active-set exclusion asserted here.
    const result = runTicketPrune({ cwd: dir, write: true, key: 'test-manifest-key' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.tombstoned.map((t) => t.id), ['SHIPPED'], 'the write path ran');
    assert.deepEqual(result.active.map((r) => r.id), ['STILL-ACTIVE']);
  });
});

test('#311 directory store: the exclusion holds on the directory backend as well', () => {
  withScratchRepo((dir) => {
    writeDirectoryStore(dir, mixedTickets());

    const result = runTicketPrune({ cwd: dir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.active.map((r) => r.id), ['STILL-ACTIVE']);
  });
});

test('#311 boundary: a completed ticket whose scope IS shipped stays in the stale listing — the fix must not swallow it', () => {
  withScratchRepo((dir) => {
    writeTickets(dir, [
      { id: 'DONE-SHIPPED', title: 'completed and shipped', scope: ['plugins/adlc-widget/**'], completed: true },
    ]);

    const result = runTicketPrune({ cwd: dir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.stale.map((r) => r.id), ['DONE-SHIPPED'], 'still classified stale');
    assert.deepEqual(result.active, [], 'and never listed as active');
  });
});

test('#311 boundary: a deliberate `completed: false` is NOT completed and stays in the active set', () => {
  withScratchRepo((dir) => {
    // `completed: false` is a value someone set on purpose (e.g. to keep rails
    // frozen during follow-up work). The invariant marker is `=== true`, so this
    // ticket is still active and must keep being listed.
    writeTickets(dir, [
      { id: 'NOT-DONE', title: 'explicitly not completed', scope: ['packages/never-built/**'], completed: false },
      { id: 'DONE', title: 'completed', scope: ['packages/never-built/**'], completed: true },
    ]);

    const result = runTicketPrune({ cwd: dir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.active.map((r) => r.id), ['NOT-DONE']);
  });
});
