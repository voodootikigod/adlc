// #994 — the causal wait primitive and the sequence fixture's dispatch signal.
//
// The pattern these replace was a bounded busy-wait: a `while` loop that awaited
// `setImmediate` until `fx.state.fleetRuns` moved OR a fixed 50,000 iterations
// had passed, followed by `assert.equal(fx.state.fleetRuns, 1, 'fleet was
// dispatched and is hanging')`. That ties the wait to an arbitrary iteration
// budget instead of to the event — and the budget is worth roughly 100ms of wall
// time, whatever it is waiting for. When it ran out first the assertion fired
// anyway, reporting the state the caller WANTED ('dispatched and is hanging')
// for a run in which the dispatch simply had not happened yet, so the failure
// meaning "too slow" was indistinguishable from the one the test exists to catch.
//
// These are regression tests for the bugfix, not spec criteria: they are
// deliberately absent from test/ac-registry.mjs (the #962 precedent).

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { createLatch, awaitSignal } from './helpers/signal.mjs';
import { createSequenceFixture } from './helpers/sequence-fixture.mjs';
import { FAKE } from './helpers/recover-fixture.mjs';

// A fleet fake that returns at once: the dispatch is the only thing under test here.
const instantFleet = () => ({ stdout: '{}', status: 0 });

test('the latch releases a waiter that was registered BEFORE the event fired', async () => {
  const latch = createLatch();
  let resolved = false;
  const waiting = latch.when().then(() => { resolved = true; });
  assert.equal(resolved, false, 'nothing has fired yet, so the waiter is still pending');
  latch.fire();
  await waiting;
  assert.equal(resolved, true);
  assert.equal(latch.count(), 1);
});

test('the latch releases a waiter registered AFTER the event fired — the already-happened case a create-on-demand helper would hang on', async () => {
  const latch = createLatch();
  latch.fire();
  // No await of any kind between the fire and the when(): if this hangs, every
  // caller that checks a condition already satisfied would hang with it.
  await awaitSignal(latch.when(), { timeoutMs: 1_000, message: 'the latch did not release an already-satisfied waiter' });
  assert.equal(latch.count(), 1);
});

test('the latch counts, so a caller can await the Nth occurrence and not merely the first', async () => {
  const latch = createLatch();
  let reachedThree = false;
  const waiting = latch.when(3).then(() => { reachedThree = true; });
  latch.fire();
  latch.fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(reachedThree, false, 'two occurrences do not satisfy a wait for three');
  latch.fire();
  await waiting;
  assert.equal(reachedThree, true);
  assert.equal(latch.count(), 3);
});

test('until() re-checks its predicate on every occurrence, so a caller can wait on state the latch does not itself hold', async () => {
  const latch = createLatch();
  const seen = [];
  const waiting = latch.until(() => seen.includes('deadline'));
  latch.fire();
  seen.push('other');
  latch.fire();
  seen.push('deadline');
  latch.fire();
  await waiting;
  assert.deepEqual(seen, ['other', 'deadline']);
});

test('awaitSignal rejects with the caller’s own message when the event never comes', async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    awaitSignal(never, { timeoutMs: 25, message: 'the thing never happened' }),
    (e) => { assert.equal(e.message, 'the thing never happened'); return true; },
  );
});

test('awaitSignal evaluates a lazy message AT the timeout, so it can report how far the run actually got', async () => {
  let progress = 0;
  const never = new Promise(() => {});
  const p = assert.rejects(
    awaitSignal(never, { timeoutMs: 25, message: () => `never happened (progress: ${progress})` }),
    (e) => { assert.equal(e.message, 'never happened (progress: 7)'); return true; },
  );
  progress = 7;
  await p;
});

test('awaitSignal refuses a message that does not name what failed to happen', () => {
  assert.throws(() => awaitSignal(Promise.resolve(), { timeoutMs: 25 }), /message/);
  assert.throws(() => awaitSignal(Promise.resolve(), { timeoutMs: 25, message: '' }), /message/);
});

test('AC2: the fixture’s dispatch signal resolves for a dispatch that happens AFTER the await begins, and for one that already happened BEFORE it', async () => {
  const fx = await createSequenceFixture({ fleet: instantFleet });
  try {
    // (a) await first, dispatch second.
    const waiting = fx.whenFleetDispatched({ timeoutMs: 5_000 });
    await fx.table[FAKE.adlc](['fleet', 'run'], { cwd: fx.repoRoot });
    await waiting;
    assert.equal(fx.state.fleetRuns, 1);

    // (b) dispatch first, await second — the same call must resolve immediately
    // rather than waiting for a SECOND dispatch that is never coming.
    await fx.whenFleetDispatched({ timeoutMs: 5_000 });
    assert.equal(fx.state.fleetRuns, 1, 'still one dispatch: the after-the-fact await consumed nothing');

    // (c) the count is addressable, so a caller can wait for a later round.
    const second = fx.whenFleetDispatched({ count: 2, timeoutMs: 5_000 });
    await fx.table[FAKE.adlc](['fleet', 'run'], { cwd: fx.repoRoot });
    await second;
    assert.equal(fx.state.fleetRuns, 2);
  } finally { fx.cleanup(); }
});

test('the wait survives a dispatch slower than the whole of the old iteration budget — the regression the budget could not survive', async () => {
  // The replaced budget was 50,000 `setImmediate` turns, measured at ~100ms of
  // wall time on an idle 16-core machine and less on a loaded one. A dispatch
  // that takes multiples of that exhausted it every time. The causal wait has no
  // budget at all, so the delay below is simply waited out.
  const fx = await createSequenceFixture({ fleet: instantFleet });
  try {
    const waiting = fx.whenFleetDispatched({ timeoutMs: 10_000 });
    setTimeout(() => { void fx.table[FAKE.adlc](['fleet', 'run'], { cwd: fx.repoRoot }); }, 400);
    await waiting;
    assert.equal(fx.state.fleetRuns, 1);
  } finally { fx.cleanup(); }
});

test('AC3: a dispatch that never happens fails saying the dispatch never happened — textually distinct from the assertion that it happened and hung', async () => {
  const fx = await createSequenceFixture({ fleet: instantFleet });
  try {
    await assert.rejects(
      fx.whenFleetDispatched({ timeoutMs: 25 }),
      (e) => {
        assert.match(e.message, /the fleet dispatch never happened/, 'the timeout names the thing that did not happen');
        assert.doesNotMatch(e.message, /dispatched and is hanging/, 'and never claims the state AC9 is testing for');
        return true;
      },
    );
    assert.equal(fx.state.fleetRuns, 0);
  } finally { fx.cleanup(); }
});
