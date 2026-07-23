// A fail-open must be observable (T64 / #309).
//
// checkFlail's §12 backstop is correct policy — an unverifiable signal must not
// cut a build's normal retry short. But `failedOpen` was returned and read by
// nobody, so an uninstalled detector, an unwritable statusDir, or schema drift
// all looked exactly like "this session is clean". That is the same failure
// class as #284: a supervision control that stops working while reporting
// normally.
//
// These tests pin the OBSERVABILITY, not a policy change. The build must still
// get its retry — asserted explicitly below, so this can never drift into
// fail-closed, which would let a missing detector kill real work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFlail } from '../lib/gates.mjs';
import { advanceTicket } from '../lib/scheduler.mjs';

const ticket = { id: 'T1', title: 'T1', scope: ['src/**'], edges: [] };

// ---------------------------------------------------------------------------
// AC1 — every fail-open branch names its own cause
// ---------------------------------------------------------------------------

test('fail-open reason: spawn-error when exec throws with no detector verdict', async () => {
  const r = checkFlail('/log', [], { exec: () => { throw new Error('adlc not found'); } });

  assert.equal(r.failedOpen, true);
  assert.equal(r.reason, 'spawn-error');
});

test('fail-open reason: operational-error when the detector exits non-zero (not 2)', async () => {
  const r = checkFlail('/log', [], {
    exec: () => { const e = new Error('boom'); e.status = 1; e.stdout = ''; throw e; },
  });

  assert.equal(r.failedOpen, true);
  assert.equal(r.reason, 'operational-error');
});

test('fail-open reason: unparseable when stdout is not JSON', async () => {
  const r = checkFlail('/log', [], { exec: () => 'not json at all' });

  assert.equal(r.failedOpen, true);
  assert.equal(r.reason, 'unparseable');
});

test('fail-open reason: unrecognized-verdict on schema drift', async () => {
  const r = checkFlail('/log', [], { exec: () => JSON.stringify({ verdict: 'inconclusive', signals: [] }) });

  assert.equal(r.failedOpen, true);
  assert.equal(r.reason, 'unrecognized-verdict');
});

test('fail-open reason: unrecognized-verdict when signals drifted to a non-array', async () => {
  const r = checkFlail('/log', [], { exec: () => JSON.stringify({ verdict: 'flail', signals: 'nope' }) });

  assert.equal(r.failedOpen, true);
  assert.equal(r.reason, 'unrecognized-verdict');
});

test('a real verdict carries no fail-open reason', async () => {
  const clean = checkFlail('/log', [], { exec: () => JSON.stringify({ verdict: 'clean', signals: [] }) });

  assert.equal(clean.failedOpen, undefined);
  assert.equal(clean.reason, undefined);
});

// ---------------------------------------------------------------------------
// AC2/AC3/AC4 — the scheduler makes it visible, without changing the policy
// ---------------------------------------------------------------------------

/** Effects whose build always fails, with a configurable flail verdict. */
function effectsWithFlail(flailResult, rec) {
  return {
    dispatch: async () => { rec.strikes += 1; return { exitCode: 1, timedOut: false, output: 'boom' }; },
    gate: async () => ({ ok: false, output: 'gate failed' }),
    prosecute: async () => ({ verdict: 'pass' }),
    merge: async () => ({ ok: true }),
    flail: async () => flailResult,
  };
}

const capture = () => { const lines = []; return { lines, log: (m) => lines.push(String(m)) }; };

test('a fail-open consultation is reported to the operator with ticket and reason', async () => {
  const rec = { strikes: 0 };
  const { lines, log } = capture();

  await advanceTicket(ticket, effectsWithFlail({ flail: false, signals: [], failedOpen: true, reason: 'operational-error' }, rec), { log });

  const warned = lines.filter((l) => /fail(ed)?[- ]open/i.test(l));
  assert.ok(warned.length > 0, `expected a fail-open warning, got:\n${lines.join('\n')}`);
  assert.ok(warned.some((l) => l.includes('T1')), 'the warning must name the ticket');
  assert.ok(warned.some((l) => l.includes('operational-error')), 'the warning must name the reason');
});

test('a fail-open does NOT cost the ticket its retry (policy unchanged)', async () => {
  const rec = { strikes: 0 };
  const { log } = capture();

  const r = await advanceTicket(ticket, effectsWithFlail({ flail: false, signals: [], failedOpen: true, reason: 'spawn-error' }, rec), { log });

  // The whole point of §12: an unverifiable signal must not cut the build short.
  // If this ever flips to fail-closed, a missing detector starts killing real work.
  assert.equal(rec.strikes, 2, 'both strikes must still be spent');
  assert.equal(r.state, 'failed');
  assert.doesNotMatch(r.reason ?? '', /genuine flail/, 'a fail-open is not a flail diagnosis');
});

test('a genuine clean verdict emits no fail-open warning (no crying wolf)', async () => {
  const rec = { strikes: 0 };
  const { lines, log } = capture();

  await advanceTicket(ticket, effectsWithFlail({ flail: false, signals: [] }, rec), { log });

  assert.equal(
    lines.filter((l) => /fail(ed)?[- ]open/i.test(l)).length, 0,
    `a clean verdict must stay quiet, got:\n${lines.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// The scheduler consults flail at TWO sites: after a failed build and after a
// failed gate. Everything above fails at dispatch, so it never reaches the
// second one — which left `canRetry() && consultFlail()` there mutable to
// `||` (i.e. "always flail while retries remain") with the suite still green.
// ---------------------------------------------------------------------------

/** Build SUCCEEDS, gate fails — drives the second consultation site. */
function effectsGateFails(flailResult, rec) {
  return {
    dispatch: async () => { rec.strikes += 1; return { exitCode: 0, timedOut: false, output: 'built ok' }; },
    gate: async () => { rec.gates += 1; return { ok: false, output: 'gate failed' }; },
    prosecute: async () => ({ verdict: 'pass' }),
    merge: async () => ({ ok: true }),
    flail: async () => flailResult,
  };
}

test('a gate-failure fail-open is reported and still costs no retry', async () => {
  const rec = { strikes: 0, gates: 0 };
  const { lines, log } = capture();

  const r = await advanceTicket(ticket, effectsGateFails({ flail: false, signals: [], failedOpen: true, reason: 'unparseable' }, rec), { log });

  assert.equal(rec.gates, 2, 'both strikes reached the gate');
  assert.equal(r.state, 'failed');
  assert.doesNotMatch(r.reason ?? '', /genuine flail/);
  const warned = lines.filter((l) => /fail(ed)?[- ]open/i.test(l));
  assert.ok(warned.some((l) => l.includes('unparseable')), 'the gate-path fail-open must be reported too');
});

test('a CLEAN gate-failure verdict does not short-circuit the second strike', async () => {
  const rec = { strikes: 0, gates: 0 };
  const { log } = capture();

  const r = await advanceTicket(ticket, effectsGateFails({ flail: false, signals: [] }, rec), { log });

  // Pins `&&` at the gate site: with `||` this returns after one strike.
  assert.equal(rec.strikes, 2, 'a clean verdict must not skip the retry');
  assert.doesNotMatch(r.reason ?? '', /genuine flail/);
});

test('a genuine gate-failure flail DOES short-circuit the second strike', async () => {
  const rec = { strikes: 0, gates: 0 };
  const { log } = capture();

  const r = await advanceTicket(ticket, effectsGateFails({ flail: true, signals: [{ type: 'edit-churn' }] }, rec), { log });

  assert.equal(rec.strikes, 1);
  assert.match(r.reason, /genuine flail/);
});

// ---------------------------------------------------------------------------
// AC5 — #284's behavior is untouched
// ---------------------------------------------------------------------------

test('a genuine flail still short-circuits the second strike (#284 preserved)', async () => {
  const rec = { strikes: 0 };
  const { lines, log } = capture();

  const r = await advanceTicket(ticket, effectsWithFlail({ flail: true, signals: [{ type: 'scope-violation' }] }, rec), { log });

  assert.equal(rec.strikes, 1, 'the second strike must be skipped');
  assert.match(r.reason, /genuine flail/);
  assert.equal(lines.filter((l) => /fail(ed)?[- ]open/i.test(l)).length, 0, 'a real verdict is not a fail-open');
});
