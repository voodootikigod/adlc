// Unit tests for the pure watcher token planner — the decision-shaped core of
// refresh() that was previously untested (P5 tests-lens finding). Covers the
// multi-repo-per-workspace aggregation that the earlier last-writer-wins code
// got wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { planTokens, pendingWatchDirs, staleWatchDirs, deadWatchDirs, mapLimit, once } from '../lib/watch-plan.mjs';

const counts = (ready, inFlight, blocked) => ({ ready, inFlight, blocked });

test('per-pane tokens come from that pane repo state; workspace counts published', () => {
  const map = [{ paneId: 'w1:p1', workspaceId: 'w1', repoRoot: '/r1' }];
  const state = new Map([['/r1', { active: { state: 'active', id: 't-a' }, phase: 'P4', counts: counts(3, 1, 2) }]]);
  const { nextPane, nextWorkspace } = planTokens(map, state);
  assert.deepEqual(nextPane.get('w1:p1'), { ticket: 't-a', phase: 'P4' });
  assert.deepEqual(nextWorkspace.get('w1'), { adlc_ready: '3', adlc_active: '1', adlc_blocked: '2' });
});

test('a workspace spanning two repos SUMS their backlog counts (no last-writer-wins)', () => {
  const map = [
    { paneId: 'w1:p1', workspaceId: 'w1', repoRoot: '/main' },
    { paneId: 'w1:p2', workspaceId: 'w1', repoRoot: '/wt-fleet' },
  ];
  const state = new Map([
    ['/main', { active: { state: 'active', id: 't-a' }, phase: 'P4', counts: counts(10, 1, 0) }],
    ['/wt-fleet', { active: { state: 'absent' }, phase: null, counts: counts(2, 0, 3) }],
  ]);
  const { nextWorkspace } = planTokens(map, state);
  // 10+2 ready, 1+0 in-flight, 0+3 blocked — order-independent.
  assert.deepEqual(nextWorkspace.get('w1'), { adlc_ready: '12', adlc_active: '1', adlc_blocked: '3' });
});

test('multiple panes rooted in the SAME repo do not double-count that repo', () => {
  const map = [
    { paneId: 'w1:p1', workspaceId: 'w1', repoRoot: '/r1' },
    { paneId: 'w1:p2', workspaceId: 'w1', repoRoot: '/r1' },
  ];
  const state = new Map([['/r1', { active: { state: 'absent' }, phase: null, counts: counts(5, 0, 0) }]]);
  assert.deepEqual(planTokens(map, state).nextWorkspace.get('w1'), { adlc_ready: '5', adlc_active: '0', adlc_blocked: '0' });
});

test('the aggregate is independent of pane iteration order', () => {
  const a = [{ paneId: 'w1:p1', workspaceId: 'w1', repoRoot: '/x' }, { paneId: 'w1:p2', workspaceId: 'w1', repoRoot: '/y' }];
  const b = [a[1], a[0]];
  const state = new Map([
    ['/x', { active: { state: 'absent' }, phase: null, counts: counts(1, 0, 0) }],
    ['/y', { active: { state: 'absent' }, phase: null, counts: counts(0, 0, 7) }],
  ]);
  assert.deepEqual(planTokens(a, state).nextWorkspace.get('w1'), planTokens(b, state).nextWorkspace.get('w1'));
});

test('panes whose repo has no state, and repos with null counts, are skipped safely', () => {
  const map = [
    { paneId: 'w1:p1', workspaceId: 'w1', repoRoot: '/known' },
    { paneId: 'w1:p2', workspaceId: 'w1', repoRoot: '/unknown' },
  ];
  const state = new Map([['/known', { active: { state: 'absent' }, phase: null, counts: null }]]);
  const { nextPane, nextWorkspace } = planTokens(map, state);
  assert.equal(nextPane.size, 0); // absent state → no pane token
  assert.equal(nextWorkspace.size, 0); // null counts → no workspace token
});

test('planTokens fails soft on a non-array pane map', () => {
  assert.deepEqual(planTokens(null, new Map()), { nextPane: new Map(), nextWorkspace: new Map() });
});

// ---- pendingWatchDirs (the tickets-dir race) ----

test('pendingWatchDirs returns nothing when .adlc itself is absent', () => {
  assert.deepEqual(pendingWatchDirs('/repo', new Set(), () => false), []);
});

test('the tickets dir is attached on a LATER call once it appears, though .adlc is already watched', () => {
  const adlc = join('/repo', '.adlc');
  const tickets = join(adlc, 'tickets');
  const watched = new Set();
  // First pass: only .adlc exists.
  let exists = (p) => p === adlc;
  const first = pendingWatchDirs('/repo', watched, exists);
  assert.deepEqual(first, [adlc]);
  first.forEach((d) => watched.add(d)); // simulate the daemon attaching them

  // Later pass: tickets dir now exists — it must be returned even though
  // .adlc is already watched (the race the raw repoRoot guard would miss).
  exists = (p) => p === adlc || p === tickets;
  assert.deepEqual(pendingWatchDirs('/repo', watched, exists), [tickets]);

  // Steady state: nothing new to attach.
  watched.add(tickets);
  assert.deepEqual(pendingWatchDirs('/repo', watched, exists), []);
});

test('pendingWatchDirs works with the Map the daemon uses (has() semantics)', () => {
  const adlc = join('/repo', '.adlc');
  const watched = new Map([[adlc, { repoRoot: '/repo' }]]);
  const exists = (p) => p === adlc || p === join(adlc, 'tickets');
  assert.deepEqual(pendingWatchDirs('/repo', watched, exists), [join(adlc, 'tickets')]);
});

// ---- staleWatchDirs (the FD-leak cleanup) ----

test('staleWatchDirs returns dirs whose repo is no longer active', () => {
  const gone = join('/gone', '.adlc');
  const live = join('/live', '.adlc');
  const watched = new Map([
    [gone, { repoRoot: '/gone' }],
    [join('/gone', '.adlc', 'tickets'), { repoRoot: '/gone' }],
    [live, { repoRoot: '/live' }],
  ]);
  assert.deepEqual(
    staleWatchDirs(watched, new Set(['/live'])).sort(),
    [gone, join('/gone', '.adlc', 'tickets')].sort(),
  );
});

test('staleWatchDirs returns nothing when every watched repo is still active', () => {
  const watched = new Map([[join('/r', '.adlc'), { repoRoot: '/r' }]]);
  assert.deepEqual(staleWatchDirs(watched, new Set(['/r'])), []);
});

// ---- deadWatchDirs (directory-deletion self-heal, the round-7 HIGH) ----

test('deadWatchDirs returns watched dirs that no longer exist on disk', () => {
  const gone = join('/r', '.adlc');
  const live = join('/r', '.adlc', 'tickets');
  const watched = new Map([[gone, { repoRoot: '/r' }], [live, { repoRoot: '/r' }]]);
  // .adlc was `rm -rf`'d; its tickets child reports gone too, but say only the
  // parent is missing to prove per-dir granularity.
  const exists = (p) => p === live;
  assert.deepEqual(deadWatchDirs(watched, exists), [gone]);
});

test('deadWatchDirs returns nothing when every watched dir still exists', () => {
  const watched = new Map([[join('/r', '.adlc'), { repoRoot: '/r' }]]);
  assert.deepEqual(deadWatchDirs(watched, () => true), []);
});

// ---- mapLimit (bounded concurrency for backlog spawns) ----

test('mapLimit preserves order and applies fn to every item', async () => {
  const out = await mapLimit([1, 2, 3, 4], 2, async (n) => n * 10);
  assert.deepEqual(out, [10, 20, 30, 40]);
});

test('mapLimit never runs more than `limit` tasks at once', async () => {
  let inFlight = 0;
  let peak = 0;
  const fn = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(10);
    inFlight -= 1;
    return null;
  };
  await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, fn);
  assert.ok(peak <= 4, `peak concurrency ${peak} exceeded the limit of 4`);
  assert.ok(peak >= 2, 'the limiter should actually run tasks in parallel');
});

test('mapLimit handles the empty list and fails soft on a non-array', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  assert.deepEqual(await mapLimit(null, 4, async () => 1), []);
});

// ---- once (socket reconnect double-retry guard) ----

test('once runs the action a single time even when called from both error and close', () => {
  let calls = 0;
  const retry = once(() => { calls += 1; });
  retry(); // 'error'
  retry(); // 'close'
  retry(); // any further
  assert.equal(calls, 1);
});
