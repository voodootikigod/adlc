// fleet-ext: the scheduler's new policy edges — pre-strike pause (item 7),
// external wall clock (item 5), resumed strike counts (AC4), caller-supplied
// dead-end material (item 3), configurable strike cap (item 4), and the closed
// reasonCode vocabulary (item 9). Every effect is a deterministic stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceTicket, reconcileResume, REASON_CODES } from '../lib/scheduler.mjs';

const ticket = { id: 'T1', title: 'T1', scope: ['src/**'], edges: [] };
const ok = { ok: true };
function effects(over = {}) {
  const calls = { dispatch: [], preStrike: [], order: [] };
  return {
    calls,
    preStrike: over.preStrike ? (a) => { calls.order.push('preStrike'); calls.preStrike.push(a); return over.preStrike(a); } : undefined,
    // Snapshot deadEnds: the scheduler keeps ONE array it appends to, so a recorder
    // that stored the reference would see later strikes' material retroactively.
    dispatch: (a) => { calls.order.push('dispatch'); calls.dispatch.push({ ...a, deadEnds: [...(a.deadEnds ?? [])] }); return over.dispatch ? over.dispatch(a) : { exitCode: 0, output: 'TICKET-DONE', timedOut: false }; },
    gate: over.gate ?? (() => ok),
    prosecute: over.prosecute ?? (() => ({ verdict: 'pass', reason: 'clean', review: { provider: 'codex', verdict: 'approve', revision: 'R1' } })),
    merge: over.merge ?? (() => ok),
    flail: over.flail ?? (() => ({ flail: false })),
  };
}

test('a refused pre-strike PAUSES the ticket before the strike: state paused, reasonCode quota-paused, zero dispatches', async () => {
  const e = effects({ preStrike: () => ({ ok: false, reason: 'quota 52% used' }) });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3 });
  assert.equal(r.state, 'paused');
  assert.equal(r.reasonCode, REASON_CODES.QUOTA_PAUSED);
  assert.equal(r.strikes, 0, 'the refused strike was not consumed');
  assert.equal(e.calls.dispatch.length, 0);
  assert.deepEqual(e.calls.preStrike[0], { ticket, strike: 1 }, 'the helper is told which strike it gates');
  assert.match(r.reason, /quota 52%/);
});

test('an accepting pre-strike runs before EVERY strike, including a retry', async () => {
  let n = 0;
  const e = effects({
    preStrike: () => ({ ok: true }),
    dispatch: () => (++n === 1 ? { exitCode: 1, output: 'boom', timedOut: false } : { exitCode: 0, output: 'TICKET-DONE', timedOut: false }),
  });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3 });
  assert.equal(r.state, 'merged');
  assert.deepEqual(e.calls.preStrike.map((c) => c.strike), [1, 2]);
});

test('a pre-strike that returns nothing (not ok:true) is a refusal — fail closed', async () => {
  const e = effects({ preStrike: () => undefined });
  const r = await advanceTicket(ticket, e, { maxStrikes: 2 });
  assert.equal(r.state, 'paused');
  assert.equal(e.calls.dispatch.length, 0);
});

test('an expired deadline BEFORE a strike pauses with wall-clock and dispatches nothing', async () => {
  const e = effects();
  const r = await advanceTicket(ticket, e, { maxStrikes: 2, deadline: 1000, now: () => 1000 });
  assert.equal(r.state, 'paused');
  assert.equal(r.reasonCode, REASON_CODES.WALL_CLOCK);
  assert.equal(e.calls.dispatch.length, 0);
});

test('a strike cut short by the deadline (timed out while expired) pauses with wall-clock, not a failed strike', async () => {
  let t = 0;
  const e = effects({ dispatch: () => { t = 5000; return { exitCode: 124, output: '', timedOut: true }; } });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3, deadline: 4000, now: () => t });
  assert.equal(r.state, 'paused');
  assert.equal(r.reasonCode, REASON_CODES.WALL_CLOCK);
  assert.equal(r.strikes, 1, 'the interrupted strike is recorded so a resume continues after it');
  assert.equal(e.calls.dispatch.length, 1);
});

test('a strike that returns IN TIME but after which the deadline has passed is paused wall-clock — nothing is gated, prosecuted or merged past the clock', async () => {
  let t = 0;
  const calls = [];
  const e = effects({
    dispatch: () => { t = 5000; return { exitCode: 0, output: 'TICKET-DONE', timedOut: false }; },
    gate: () => { calls.push('gate'); return ok; },
  });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3, deadline: 4000, now: () => t });
  assert.equal(r.state, 'paused');
  assert.equal(r.reasonCode, REASON_CODES.WALL_CLOCK);
  assert.deepEqual(calls, [], 'the gate never ran');
  // …and the same before prosecution and before the merge.
  for (const [stage, over] of [['prosecute', { gate: () => { t = 5000; return ok; } }], ['merge', { prosecute: () => { t = 5000; return { verdict: 'pass', reason: 'clean' }; } }]]) {
    t = 0;
    const seen = [];
    const ee = effects({ ...over, merge: () => { seen.push('merge'); return ok; }, prosecute: over.prosecute ?? (() => { seen.push('prosecute'); return { verdict: 'pass', reason: 'clean' }; }) });
    const rr = await advanceTicket(ticket, ee, { maxStrikes: 3, deadline: 4000, now: () => t });
    assert.equal(rr.state, 'paused', stage);
    assert.equal(rr.reasonCode, REASON_CODES.WALL_CLOCK, stage);
    assert.ok(!seen.includes('merge'), `${stage}: nothing merged past the clock`);
  }
});

test('a per-dispatch timeout with the deadline still ahead is an ordinary failed strike (retries)', async () => {
  let n = 0;
  const e = effects({ dispatch: () => (++n === 1 ? { exitCode: 124, output: 'slow', timedOut: true } : { exitCode: 0, output: 'TICKET-DONE', timedOut: false }) });
  const r = await advanceTicket(ticket, e, { maxStrikes: 2, deadline: 10_000, now: () => 1 });
  assert.equal(r.state, 'merged');
  assert.equal(r.strikes, 2);
});

test('startStrikes resumes from the recorded count: maxStrikes 3 with 2 already used allows exactly one more dispatch', async () => {
  const e = effects({ dispatch: () => ({ exitCode: 1, output: 'still broken', timedOut: false }) });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3, startStrikes: 2 });
  assert.equal(e.calls.dispatch.length, 1);
  assert.equal(e.calls.dispatch[0].strike, 3, 'the resumed strike is numbered from the recorded count');
  assert.equal(r.state, 'failed');
  assert.equal(r.reasonCode, REASON_CODES.STRIKES_EXHAUSTED);
  assert.equal(r.strikes, 3);
});

test('startStrikes at the cap dispatches nothing and reports strikes-exhausted', async () => {
  const e = effects();
  const r = await advanceTicket(ticket, e, { maxStrikes: 2, startStrikes: 2 });
  assert.equal(e.calls.dispatch.length, 0);
  assert.equal(r.state, 'failed');
  assert.equal(r.reasonCode, REASON_CODES.STRIKES_EXHAUSTED);
});

test('initialDeadEnds reach the FIRST dispatch as prior-attempt material and are kept on retries', async () => {
  let n = 0;
  const e = effects({ dispatch: () => (++n === 1 ? { exitCode: 1, output: 'x', timedOut: false } : { exitCode: 0, output: 'TICKET-DONE', timedOut: false }) });
  await advanceTicket(ticket, e, { maxStrikes: 2, initialDeadEnds: ['<fenced prior round>'] });
  assert.deepEqual(e.calls.dispatch[0].deadEnds, ['<fenced prior round>']);
  assert.equal(e.calls.dispatch[1].deadEnds[0], '<fenced prior round>', 'the caller material stays first');
  assert.equal(e.calls.dispatch[1].deadEnds.length, 2, 'the captured strike-1 failure is appended after it');
});

test('maxStrikes is honoured verbatim (item 4): 5 failing strikes → 5 dispatches, then strikes-exhausted', async () => {
  const e = effects({ dispatch: () => ({ exitCode: 1, output: 'no', timedOut: false }) });
  const r = await advanceTicket(ticket, e, { maxStrikes: 5 });
  assert.equal(e.calls.dispatch.length, 5);
  assert.equal(r.reasonCode, REASON_CODES.STRIKES_EXHAUSTED);
  assert.match(r.reason, /5-strike cap/);
});

test('every failure path carries its closed-enum reasonCode', async () => {
  const cases = [
    ['ticket-blocked', effects({ dispatch: () => ({ exitCode: 0, output: 'TICKET-BLOCKED: nope', timedOut: false, blocked: true }) }), 'blocked'],
    ['flail', effects({ dispatch: () => ({ exitCode: 1, output: 'err', timedOut: false }), flail: () => ({ flail: true }) }), 'failed'],
    ['review-unavailable', effects({ prosecute: () => ({ verdict: 'unavailable', reason: 'no provider' }) }), 'failed'],
    ['strikes-exhausted', effects({ prosecute: () => ({ verdict: 'block', reason: '1 high' }) }), 'failed'],
    ['mirror-fetch-failed', effects({ dispatch: () => ({ exitCode: 1, output: 'non-ff', timedOut: false, mirrorFetchFailed: true }) }), 'failed'],
  ];
  for (const [code, e, state] of cases) {
    const r = await advanceTicket(ticket, e, { maxStrikes: 2 });
    assert.equal(r.state, state, code);
    assert.equal(r.reasonCode, code, `${code}: reasonCode`);
    assert.ok(Object.values(REASON_CODES).includes(r.reasonCode), 'the code is in the closed enum');
  }
  // mirror-fetch-failed is terminal on the FIRST strike — no retry can help.
  const m = cases[4][1];
  assert.equal(m.calls.dispatch.length, 1);
});

test('review meta accumulates rounds and carries provider/verdict/revision from the prosecution', async () => {
  let n = 0;
  const e = effects({ prosecute: () => (++n === 1 ? { verdict: 'block', reason: '1 medium', review: { provider: 'codex', verdict: 'needs-attention', revision: 'R1' } } : { verdict: 'pass', reason: 'clean', review: { provider: 'codex', verdict: 'approve', revision: 'R2' } }) });
  const r = await advanceTicket(ticket, e, { maxStrikes: 2 });
  assert.equal(r.state, 'merged');
  assert.deepEqual(r.review, { provider: 'codex', verdict: 'approve', revision: 'R2', rounds: 2 });
});

test('reconcileResume returns a PAUSED ticket to pending with its strikes intact (resumable), merged-by-ancestry still wins', () => {
  const status = { integrationBranch: 'fleet/run-1', tickets: { T1: { state: 'paused', strikes: 1, branch: 'fleet/t1', reasonCode: 'quota-paused' }, T2: { state: 'paused', strikes: 2, branch: 'fleet/t2' } } };
  const r = reconcileResume([], status, { isAncestor: (b) => b === 'fleet/t2', integrationBranch: 'fleet/run-1' });
  assert.equal(r.tickets.T1.state, 'pending');
  assert.equal(r.tickets.T1.strikes, 1, 'strike count preserved across the resume');
  assert.equal(r.tickets.T2.state, 'merged');
});

test('every awaited phase receives the REMAINING wall clock: gate, prosecute and merge get remainingMs ≤ deadline − now, and null without a deadline (codex r2)', async () => {
  let t = 1000;
  const seen = {};
  const e = effects({
    gate: ({ remainingMs }) => { seen.gate = remainingMs; t += 100; return ok; },
    prosecute: ({ remainingMs }) => { seen.prosecute = remainingMs; t += 100; return { verdict: 'pass', reason: 'clean' }; },
    merge: ({ remainingMs }) => { seen.merge = remainingMs; return ok; },
  });
  const r = await advanceTicket(ticket, e, { maxStrikes: 1, deadline: 2000, now: () => t });
  assert.equal(r.state, 'merged');
  assert.equal(seen.gate, 1000);
  assert.equal(seen.prosecute, 900);
  assert.equal(seen.merge, 800);
  const e2 = effects({ gate: ({ remainingMs }) => { seen.unbounded = remainingMs; return ok; } });
  await advanceTicket(ticket, e2, { maxStrikes: 1 });
  assert.equal(seen.unbounded, null, 'no deadline → null, never a fabricated bound');
});

test('a pre-strike command that consumes the budget → paused wall-clock (not quota-paused), zero dispatches; a merge that reports expiry → paused wall-clock (codex r4)', async () => {
  let t = 0;
  const e = effects({ preStrike: () => { t = 5000; return { ok: true }; } });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3, deadline: 1000, now: () => t });
  assert.equal(r.state, 'paused'); assert.equal(r.reasonCode, REASON_CODES.WALL_CLOCK);
  assert.equal(e.calls.dispatch.length, 0);
  const e2 = effects({ merge: () => ({ ok: false, expired: true, output: 'external wall clock expired before the merge' }) });
  const r2 = await advanceTicket(ticket, e2, { maxStrikes: 3, deadline: 10_000, now: () => 0 });
  assert.equal(r2.state, 'paused'); assert.equal(r2.reasonCode, REASON_CODES.WALL_CLOCK);
});

test('deadline-caused timeouts pause wall-clock instead of becoming strikes/flail/review-unavailable: a timed-out gate and a timed-out prosecution past the deadline (codex r5)', async () => {
  let t = 0; const flail = [];
  const e = effects({ gate: () => { t = 5000; return { ok: false, output: 'timed out', timedOut: true }; }, flail: () => { flail.push(1); return { flail: true }; } });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3, deadline: 1000, now: () => t });
  assert.equal(r.state, 'paused'); assert.equal(r.reasonCode, REASON_CODES.WALL_CLOCK);
  assert.equal(flail.length, 0, 'no flail consultation'); assert.equal(e.calls.dispatch.length, 1, 'no retry strike');
  let t2 = 0;
  const e2 = effects({ prosecute: () => { t2 = 5000; return { verdict: 'unavailable', reason: 'adversarial-review timed out', timedOut: true }; } });
  const r2 = await advanceTicket(ticket, e2, { maxStrikes: 3, deadline: 1000, now: () => t2 });
  assert.equal(r2.state, 'paused'); assert.equal(r2.reasonCode, REASON_CODES.WALL_CLOCK);
  // the same failures WITHOUT an expired deadline keep their ordinary meaning
  const e3 = effects({ gate: () => ({ ok: false, output: 'timed out', timedOut: true }) });
  const r3 = await advanceTicket(ticket, e3, { maxStrikes: 1, deadline: 1_000_000, now: () => 0 });
  assert.equal(r3.state, 'failed');
});

test('the scheduler hands the strike back on a policy mismatch and marks the outcome (codex r7)', async () => {
  const e = effects({ dispatch: () => ({ exitCode: 1, output: 'sandbox policy: unsupported adapter', timedOut: false, policyMismatch: true }) });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3 });
  assert.equal(r.state, 'paused', 'a deterministic, operator-fixable refusal is PAUSED (resumable), never terminal (codex r24 #1)'); assert.equal(r.reasonCode, null, 'no §14 code: policyMismatch is the marker'); assert.equal(r.policyMismatch, true); assert.equal(r.strikes, 0);
  const { reconcileResume } = await import('../lib/scheduler.mjs');
  const rec = reconcileResume([ticket], { integrationBranch: 'adlc/x', tickets: { [ticket.id]: { state: r.state, strikes: r.strikes, reasonCode: r.reasonCode } } }, { isAncestor: () => false });
  assert.equal(rec.tickets[ticket.id].state, 'pending', 'resume reconciliation re-dispatches it once the operator fixed the policy');
  assert.equal(e.calls.dispatch.length, 1);
});

test('a flail consultation that consumes the budget → paused wall-clock, never a flail verdict (codex r10)', async () => {
  let t = 0;
  const e = effects({ dispatch: () => ({ exitCode: 1, output: 'boom', timedOut: false }), flail: () => { t = 5000; return { flail: true }; } });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3, deadline: 1000, now: () => t });
  assert.equal(r.state, 'paused'); assert.equal(r.reasonCode, REASON_CODES.WALL_CLOCK);
});

test('a FAILED strike (exit≠0, not timed out) after the deadline passed pauses with wall-clock — the expiry outranks the strike verdict and never counts toward the cap', async () => {
  let t = 0;
  const e = effects({ dispatch: () => { t = 5000; return { exitCode: 1, output: 'boom', timedOut: false }; } });
  const r = await advanceTicket(ticket, e, { maxStrikes: 1, deadline: 4000, now: () => t });
  assert.equal(r.state, 'paused', JSON.stringify(r));
  assert.equal(r.reasonCode, REASON_CODES.WALL_CLOCK, 'not strikes-exhausted');
  assert.equal(e.calls.dispatch.length, 1);
  // A failed GATE after the deadline pauses too.
  let t2 = 0;
  const e2 = effects({ gate: () => { t2 = 5000; return { ok: false, output: 'gate red', timedOut: false }; } });
  const r2 = await advanceTicket(ticket, e2, { maxStrikes: 1, deadline: 4000, now: () => t2 });
  assert.equal(r2.state, 'paused'); assert.equal(r2.reasonCode, REASON_CODES.WALL_CLOCK);
});

test('a wall-clock pause after the worker returned but before its verdict (gate cut short, or nothing gated yet) hands the strike back — a pause on the LAST strike can still resume and run it', async () => {
  let t = 0;
  const e = effects({ gate: () => { t = 5000; return { ok: false, output: '', timedOut: true }; } });
  const r = await advanceTicket(ticket, e, { maxStrikes: 1, deadline: 4000, now: () => t });
  assert.equal(r.state, 'paused'); assert.equal(r.reasonCode, REASON_CODES.WALL_CLOCK);
  assert.equal(r.strikes, 0, 'the strike whose verdict never landed is handed back');
  // And a resume with that count dispatches again.
  let t2 = 0;
  const e2 = effects();
  const r2 = await advanceTicket(ticket, e2, { maxStrikes: 1, deadline: 4000, now: () => t2, startStrikes: r.strikes });
  assert.equal(e2.calls.dispatch.length, 1, 'the resumed run could still run its one strike');
  assert.equal(r2.state === 'merged' || r2.state === 'done' || r2.state === 'built', true, JSON.stringify(r2).slice(0, 120));
  // A genuinely FAILED gate after the deadline still consumes the strike (its verdict landed).
  let t3 = 0;
  const e3 = effects({ gate: () => { t3 = 5000; return { ok: false, output: 'red', timedOut: false }; } });
  const r3 = await advanceTicket(ticket, e3, { maxStrikes: 1, deadline: 4000, now: () => t3 });
  assert.equal(r3.state, 'paused'); assert.equal(r3.strikes, 1);
});

test('the pre-strike command runs BEFORE every dispatch, in order (never after, never skipped for a later strike)', async () => {
  let n = 0;
  const e = effects({ preStrike: () => ({ ok: true }), dispatch: () => ({ exitCode: ++n < 2 ? 1 : 0, output: n < 2 ? 'boom' : 'TICKET-DONE', timedOut: false }) });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3 });
  assert.equal(e.calls.dispatch.length, 2);
  assert.deepEqual(e.calls.order, ['preStrike', 'dispatch', 'preStrike', 'dispatch'], 'pre-strike precedes each dispatch');
  assert.ok(r.state);
});

test('a strike that timed out on a DEADLINE-TRUNCATED budget is handed back (paused wall-clock, strike unconsumed); one that had its full budget keeps its verdict (codex r23 #3)', async () => {
  let t = 0;
  const e = effects({ dispatch: () => { t = 5000; return { exitCode: 124, output: '', timedOut: true, deadlineTruncated: true }; } });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3, deadline: 4000, now: () => t });
  assert.equal(r.state, 'paused'); assert.equal(r.reasonCode, REASON_CODES.WALL_CLOCK);
  assert.equal(r.strikes, 0, 'the truncated strike is handed back so a resume on the last strike can still run it');
  // On the LAST strike: without the hand-back the resume would exit through the strike cap.
  let t2 = 0;
  const e2 = effects({ dispatch: () => { t2 = 5000; return { exitCode: 124, output: '', timedOut: true, deadlineTruncated: true }; } });
  const r2 = await advanceTicket(ticket, e2, { maxStrikes: 3, startStrikes: 2, deadline: 4000, now: () => t2 });
  assert.equal(r2.state, 'paused'); assert.equal(r2.strikes, 2, 'still one strike left for the resume');
  let t3 = 0;
  const e3 = effects({ dispatch: () => { t3 = 5000; return { exitCode: 124, output: '', timedOut: true, deadlineTruncated: false }; } });
  const r3 = await advanceTicket(ticket, e3, { maxStrikes: 3, deadline: 4000, now: () => t3 });
  assert.equal(r3.state, 'paused'); assert.equal(r3.strikes, 1, 'a full-budget timeout is the worker\'s verdict and stays consumed');
});

test('a merge that reports expiredAfterMerge is a MERGED ticket carrying wall-clock, so the run publishes nothing past the deadline (codex r23 #4)', async () => {
  const e = effects({ merge: () => ({ ok: true, completed: false, expiredAfterMerge: true, output: 'external wall clock expired during completion' }) });
  const r = await advanceTicket(ticket, e, { maxStrikes: 3 });
  assert.equal(r.state, 'merged'); assert.equal(r.reasonCode, REASON_CODES.WALL_CLOCK); assert.equal(r.strikes, 1);
  assert.match(r.reason, /wall clock expired/);
});
