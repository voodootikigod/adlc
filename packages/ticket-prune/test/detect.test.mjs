import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExplicitlyDone,
  scopeShipped,
  classifyTicket,
  classifyTickets,
  ceremonyDisposition,
} from '../lib/detect.mjs';

// ── explicit status field (preferred signal when present) ───────────────────

test('isExplicitlyDone recognizes known done-shaped status values', () => {
  assert.equal(isExplicitlyDone({ id: 'T1', status: 'done' }), true);
  assert.equal(isExplicitlyDone({ id: 'T1', status: 'DONE' }), true);
  assert.equal(isExplicitlyDone({ id: 'T1', status: 'closed' }), true);
  assert.equal(isExplicitlyDone({ id: 'T1', status: 'shipped' }), true);
});

test('isExplicitlyDone is false for open/active status or no status field', () => {
  assert.equal(isExplicitlyDone({ id: 'T1', status: 'open' }), false);
  assert.equal(isExplicitlyDone({ id: 'T1', status: 'active' }), false);
  assert.equal(isExplicitlyDone({ id: 'T1' }), false);
});

// ── scope-existence inference (fallback when no explicit status) ────────────

test('scopeShipped is true only when every declared scope glob matches a tracked file', () => {
  const tracked = ['plugins/adlc-opencode/index.mjs', 'docs/integrations/opencode.md'];
  const shipped = { id: 'T1', scope: ['plugins/adlc-opencode/**', 'docs/integrations/opencode.md'] };
  const partial = { id: 'T2', scope: ['plugins/adlc-opencode/**', 'packages/never-built/**'] };
  assert.equal(scopeShipped(shipped, tracked), true);
  assert.equal(scopeShipped(partial, tracked), false);
});

test('scopeShipped is false (never inferred stale) when a ticket declares no scope', () => {
  assert.equal(scopeShipped({ id: 'T3' }, ['anything']), false);
  assert.equal(scopeShipped({ id: 'T3', scope: [] }, ['anything']), false);
});

// ── classifyTicket: the combined decision used by the CLI ───────────────────

test('classifyTicket: explicit done status wins regardless of scope', () => {
  const result = classifyTicket({ id: 'T1', status: 'done', scope: ['nowhere/**'] }, []);
  assert.equal(result.stale, true);
  assert.match(result.reason, /status/i);
});

test('classifyTicket: explicit non-done status blocks inference even if scope looks shipped', () => {
  const tracked = ['plugins/adlc-opencode/index.mjs'];
  const result = classifyTicket(
    { id: 'T1', status: 'active', scope: ['plugins/adlc-opencode/**'] },
    tracked
  );
  assert.equal(result.stale, false);
  assert.match(result.reason, /status/i);
});

test('classifyTicket: no status field falls back to scope-on-base-ref inference (stale)', () => {
  const tracked = ['plugins/adlc-opencode/index.mjs', 'docs/integrations/opencode.md'];
  const result = classifyTicket(
    { id: 'T1', scope: ['plugins/adlc-opencode/**', 'docs/integrations/opencode.md'] },
    tracked
  );
  assert.equal(result.stale, true);
  assert.match(result.reason, /scope/i);
});

test('classifyTicket: no status field + scope not fully shipped is active (not stale)', () => {
  const tracked = ['plugins/adlc-opencode/index.mjs'];
  const result = classifyTicket(
    { id: 'T2', scope: ['plugins/adlc-opencode/**', 'packages/never-built/**'] },
    tracked
  );
  assert.equal(result.stale, false);
});

test('classifyTickets maps a whole ticket array', () => {
  const tracked = ['plugins/adlc-opencode/index.mjs'];
  const tickets = [
    { id: 'T1', scope: ['plugins/adlc-opencode/**'] },
    { id: 'T2', scope: ['packages/never-built/**'] },
    { id: 'T3', status: 'done' },
  ];
  const results = classifyTickets(tickets, tracked);
  assert.deepEqual(
    results.map((r) => [r.id, r.stale]),
    [
      ['T1', true],
      ['T2', false],
      ['T3', true],
    ]
  );
});

// ── ceremonyDisposition — the shared tombstone/ceremony/done split (#198) ────

test('ceremonyDisposition: an already-completed stale ticket is "done" (nothing to do)', () => {
  assert.deepEqual(
    ceremonyDisposition({ id: 'T1', completed: true, rails: ['x/**'] }, 'r'),
    { disposition: 'done' },
  );
});

test('ceremonyDisposition: a rails-less pristine stale ticket is "tombstone" (ordinary PR may complete it)', () => {
  assert.deepEqual(
    ceremonyDisposition({ id: 'T1', title: 'x' }, 'r'),
    { disposition: 'tombstone' },
  );
});

test('ceremonyDisposition: a railed ticket with NO completed field is rails-freeze', () => {
  assert.deepEqual(
    ceremonyDisposition({ id: 'T1', rails: ['test/a/**'] }, 'r'),
    { disposition: 'ceremony', entry: { id: 'T1', reason: 'r', rails: ['test/a/**'], blocker: 'rails-freeze' } },
  );
});

test('ceremonyDisposition: a railed ticket with completed:false is preexisting-completed-field, NOT rails-freeze', () => {
  // A deliberately-set `completed: false` (kept incomplete to hold rails during
  // follow-up work) must route to manual review — completing it would overwrite
  // the value and expire rails the author kept on purpose. The completed-field
  // check runs BEFORE the rails check. The blocker still carries the rails so the
  // report shows them; it is just never advertised as safe to bulk-complete.
  assert.deepEqual(
    ceremonyDisposition({ id: 'T1', rails: ['test/a/**'], completed: false }, 'r'),
    { disposition: 'ceremony', entry: { id: 'T1', reason: 'r', rails: ['test/a/**'], blocker: 'preexisting-completed-field' } },
  );
});

test('ceremonyDisposition: a rails-less ticket that already carries a completed field needs the ceremony (blocker preexisting-completed-field)', () => {
  assert.deepEqual(
    ceremonyDisposition({ id: 'T1', completed: false }, 'r'),
    { disposition: 'ceremony', entry: { id: 'T1', reason: 'r', rails: [], blocker: 'preexisting-completed-field' } },
  );
});
