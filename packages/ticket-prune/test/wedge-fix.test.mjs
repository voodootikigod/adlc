// T75 — ticket-prune must not wedge the whole sweep on the first archive that
// fails closed (ARCHIVE_INBOUND_EDGE). Two guarantees:
//   (a) a batch with one inbound-edge-blocked ticket still archives the rest and
//       names the blocked one (skip-and-continue instead of a mid-batch return);
//   (b) archive candidates are ordered topologically — an in-batch edge SOURCE is
//       archived before its TARGET, so neither is falsely blocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTicketPrune } from '../lib/run.mjs';
import { orderArchiveCandidates } from '../lib/archive-order.mjs';
import { ticketFilename } from '@adlc/tickets';

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function setupScratchRepo(dir) {
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['commit', '-q', '--allow-empty', '-m', 'root'], dir);
}

function withScratchRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-prune-wedge-'));
  try {
    setupScratchRepo(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function shipScope(dir, rel) {
  mkdirSync(join(dir, rel), { recursive: true });
  writeFileSync(join(dir, rel, 'index.mjs'), '// shipped\n');
}

function writeDirectoryStore(dir, tickets) {
  const store = join(dir, '.adlc', 'tickets');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
  for (const t of tickets) writeFileSync(join(store, ticketFilename(t.id)), JSON.stringify(t));
}

// ── (b) pure topological ordering ──────────────────────────────────────────

test('orderArchiveCandidates puts an edge source before its target, even if the target is listed first', () => {
  const ticketsById = new Map([
    ['TGT', { id: 'TGT', edges: [] }],
    ['SRC', { id: 'SRC', edges: [{ to: 'TGT' }] }],
  ]);
  assert.deepEqual(orderArchiveCandidates(['TGT', 'SRC'], ticketsById), ['SRC', 'TGT']);
});

test('orderArchiveCandidates topologically sorts a chain A→B→C regardless of input order', () => {
  const ticketsById = new Map([
    ['A', { id: 'A', edges: [{ to: 'B' }] }],
    ['B', { id: 'B', edges: [{ to: 'C' }] }],
    ['C', { id: 'C', edges: [] }],
  ]);
  assert.deepEqual(orderArchiveCandidates(['C', 'B', 'A'], ticketsById), ['A', 'B', 'C']);
});

test('orderArchiveCandidates ignores edges to non-candidates (only in-batch edges constrain order)', () => {
  const ticketsById = new Map([
    ['X', { id: 'X', edges: [{ to: 'ACTIVE' }] }],
    ['Y', { id: 'Y', edges: [] }],
    ['ACTIVE', { id: 'ACTIVE', edges: [] }],
  ]);
  assert.deepEqual(orderArchiveCandidates(['X', 'Y'], ticketsById), ['X', 'Y']);
});

// ── (a) skip-and-continue on a genuinely blocked ticket ─────────────────────

test('a batch with one inbound-edge-blocked ticket still archives the rest and names the blocked one', () => {
  withScratchRepo((dir) => {
    shipScope(dir, join('packages', 'a2'));
    shipScope(dir, join('packages', 'b2'));
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'ship a2 b2'], dir);
    // AAA and BBB are both rails-less shipped (archivable). BBB is referenced by
    // ACTIVE ticket CCC (which is NOT a candidate), so archiveTicket rejects BBB
    // with ARCHIVE_INBOUND_EDGE — a genuine block no reordering can satisfy.
    writeDirectoryStore(dir, [
      { id: 'AAA', title: 'rails-less shipped', scope: ['packages/a2/**'] },
      { id: 'BBB', title: 'rails-less shipped', scope: ['packages/b2/**'] },
      { id: 'CCC', title: 'still building', scope: ['packages/never-built/**'], edges: [{ to: 'BBB' }] },
    ]);

    const result = runTicketPrune({ cwd: dir, write: true });

    // The blocked ticket no longer wedges the sweep: it is a report, not a hard failure.
    assert.equal(result.ok, true);
    assert.deepEqual((result.archived ?? []).map((a) => a?.id ?? a), ['AAA'], 'the eligible ticket still archives');
    assert.deepEqual((result.blocked ?? []).map((b) => b.id), ['BBB'], 'the blocked ticket is named, not swallowed');
    assert.match(result.blocked[0].error ?? '', /inbound|referenced|CCC/i);
    // The blocked entry carries the stale record's classification reason (from staleById),
    // not null — a report that dropped the reason would tell the operator nothing.
    assert.equal(typeof result.blocked[0].reason, 'string');
    assert.ok(result.blocked[0].reason.length > 0, 'the blocked entry names WHY it was stale');
    // AAA really left the active store; BBB's shard is still there (never archived).
    assert.ok(!existsSync(join(dir, '.adlc', 'tickets', ticketFilename('AAA'))));
    assert.ok(existsSync(join(dir, '.adlc', 'tickets', ticketFilename('BBB'))));
  });
});

test('an UNEXPECTED archive failure (not an inbound edge) fails the sweep — never reports ok:true', () => {
  withScratchRepo((dir) => {
    shipScope(dir, join('packages', 'c2'));
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'ship c2'], dir);
    writeDirectoryStore(dir, [
      { id: 'AAA', title: 'rails-less shipped', scope: ['packages/c2/**'] },
    ]);
    // Make the archive destination a FILE so archiveTicket hits a filesystem error
    // (ENOTDIR) — an unexpected, non-recoverable failure, NOT an inbound-edge block.
    // The old broad catch swallowed this into `blocked` and still returned ok:true;
    // a corrupt/unwritable store must fail the sweep so automation never reads a
    // broken store as clean.
    writeFileSync(join(dir, '.adlc', 'ticket-archive'), 'not a directory\n');

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, false, 'a genuine I/O failure must not report success');
    assert.equal(result.failedId, 'AAA');
    assert.notEqual(result.code, 'ARCHIVE_INBOUND_EDGE', 'this was not an inbound-edge block');
    // The ticket was NOT archived (the failure was real, not skipped).
    assert.ok(existsSync(join(dir, '.adlc', 'tickets', ticketFilename('AAA'))));
  });
});

test('an in-batch edge source is archived before its target, so neither is falsely blocked (topological write path)', () => {
  withScratchRepo((dir) => {
    shipScope(dir, join('packages', 'src2'));
    shipScope(dir, join('packages', 'tgt2'));
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'ship src2 tgt2'], dir);
    // SRC holds an edge to TGT; both are rails-less shipped. Archiving TGT first
    // would fail (SRC still references it) — only source-before-target archives both.
    writeDirectoryStore(dir, [
      { id: 'TGT', title: 'rails-less shipped', scope: ['packages/tgt2/**'] },
      { id: 'SRC', title: 'rails-less shipped', scope: ['packages/src2/**'], edges: [{ to: 'TGT' }] },
    ]);

    const result = runTicketPrune({ cwd: dir, write: true });

    assert.equal(result.ok, true);
    assert.deepEqual((result.blocked ?? []).map((b) => b.id), [], 'nothing is blocked when ordered topologically');
    assert.deepEqual((result.archived ?? []).map((a) => a?.id ?? a), ['SRC', 'TGT'], 'source archived before target');
    assert.ok(!existsSync(join(dir, '.adlc', 'tickets', ticketFilename('SRC'))));
    assert.ok(!existsSync(join(dir, '.adlc', 'tickets', ticketFilename('TGT'))));
  });
});
