// runLive is the fleet CLI's live-run entry: preflight → resume-reconcile → runFleet →
// exit code. Its collaborators are injectable purely so this can drive the exit-code path
// without a real sandbox. The bin guards its top-level dispatch behind an entry-point check,
// so importing runLive here does NOT parse argv or exit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLive } from '../bin/fleet.mjs';
// NOTE: the entry-point-guard test lives in fleet-entry.test.mjs, NOT here — it must run in a
// file that does NOT import the bin, since an inverted guard makes the import itself dispatch.

const ARGS = { repo: '/repo', dir: '/repo/.adlc', all: [], config: { base: 'main' }, onlyIds: undefined };

// All collaborators faked; `run` returns the summary under test, preflight passes by default.
function overrides(summary, { preflightOk = true } = {}) {
  return {
    io: { git: () => () => 'SHA' },
    preflight: async () =>
      preflightOk
        ? { ok: true, warnings: [], sandboxSpec: { mode: 'sandbox' } }
        : { ok: false, warnings: [], reason: 'no sandbox', exitCode: 1 },
    build: () => ({}),
    run: async () => summary,
    loadPrior: () => null,
    reconcile: () => ({}),
    release: () => {},
  };
}

test('runLive returns 2 (quarantine) for a contaminated run', async () => {
  const code = await runLive(ARGS, overrides({ contaminated: true, results: {}, integrationBranch: 'fleet/run-x', contaminationReason: 'ungated commit' }));
  assert.equal(code, 2);
});

test('runLive returns 0 for a clean run (all merged, PR opened)', async () => {
  const code = await runLive(ARGS, overrides({ contaminated: false, results: { A: 'merged' }, merged: 1, prCount: 1, integrationBranch: 'fleet/run-x' }));
  assert.equal(code, 0);
});

test('runLive returns 2 when a ticket failed/blocked', async () => {
  const code = await runLive(ARGS, overrides({ contaminated: false, results: { A: 'failed', B: 'merged' }, merged: 1, prCount: 1, integrationBranch: 'fleet/run-x' }));
  assert.equal(code, 2);
});

test('runLive returns the preflight exit code when preflight fails (no run dispatched)', async () => {
  let ran = false;
  const ov = { ...overrides({}, { preflightOk: false }), run: async () => { ran = true; return {}; } };
  const code = await runLive(ARGS, ov);
  assert.equal(code, 1, 'a failed preflight returns its exit code');
  assert.equal(ran, false, 'and never dispatches the run');
});

test('the whole-run deadline is anchored at INVOCATION, before preflight: slow preflight spends the wall clock instead of resetting it (codex r2)', async () => {
  let t = 100_000;
  let seenConfig = null;
  const ov = {
    ...overrides({ contaminated: false, results: {}, merged: 0, prCount: 0, integrationBranch: 'fleet/run-x' }),
    // preflight spends 30 s of the 1-minute budget: the run proceeds with the ANCHORED deadline (not a fresh one).
    preflight: async () => { t += 30_000; return { ok: true, warnings: [], sandboxSpec: { mode: 'sandbox' } }; },
    run: async (cfg) => { seenConfig = cfg.config; return { contaminated: false, results: {}, merged: 0, prCount: 0, integrationBranch: 'fleet/run-x' }; },
    now: () => t,
  };
  await runLive({ ...ARGS, config: { ...ARGS.config, wallClockMinutes: 1 } }, ov);
  assert.ok(seenConfig, 'the run was dispatched');
  assert.equal(seenConfig.deadline, 100_000 + 60_000, 'deadline = invocation + wallClockMinutes, not after-preflight + wallClockMinutes');
});

import { canaryTimeout } from '../bin/fleet.mjs';
test('the preflight canary is bounded by the remaining wall clock, and a preflight that consumed the whole budget ends the run with reason wall-clock and no dispatch (codex r3)', async () => {
  assert.equal(canaryTimeout(null, 5), undefined, 'no deadline → no timeout');
  assert.equal(canaryTimeout(10_000, 4_000), 6_000, 'the exact remaining budget');
  assert.equal(canaryTimeout(10_000, 20_000), 1, 'an expired deadline yields the smallest positive timeout, never a negative one');
  let t = 100_000; let ran = false; let emitted = null;
  const ov = {
    ...overrides({ contaminated: false, results: {}, merged: 0, prCount: 0, integrationBranch: 'fleet/run-x' }),
    preflight: async () => { t += 2 * 60_000; return { ok: true, warnings: [], sandboxSpec: { mode: 'sandbox' } }; },
    run: async () => { ran = true; return { contaminated: false, results: {}, merged: 0, prCount: 0, integrationBranch: 'fleet/run-x' }; },
    now: () => t,
    emit: (doc) => { emitted = doc; },
  };
  const code = await runLive({ ...ARGS, json: true, config: { ...ARGS.config, wallClockMinutes: 1 } }, ov);
  assert.equal(ran, false, 'nothing is dispatched past the deadline');
  assert.equal(code, 2);
  assert.equal(emitted?.reason, 'wall-clock');
});

test('the post-preflight wall-clock exit releases the preflight-held lock (codex r4)', async () => {
  let t = 100_000; let released = 0;
  const ov = {
    ...overrides({ contaminated: false, results: {}, merged: 0, prCount: 0, integrationBranch: 'fleet/run-x' }),
    preflight: async () => { t += 2 * 60_000; return { ok: true, warnings: [], sandboxSpec: { mode: 'sandbox' } }; },
    run: async () => { throw new Error('must not run'); },
    now: () => t,
    release: () => { released++; },
  };
  const code = await runLive({ ...ARGS, config: { ...ARGS.config, wallClockMinutes: 1 } }, ov);
  assert.equal(code, 2);
  assert.equal(released, 1, 'the lock is released exactly once on the early exit');
});

test('--json is total for a THROWN preflight (reason preflight, no lock release when this process is not the owner) and for a thrown reconciliation (dispatch-refused, lock released) (codex r5)', async () => {
  let emitted = null; let released = 0;
  const ov = { ...overrides({}), preflight: async () => { throw new Error('preflight exploded'); }, emit: (d) => { emitted = d; }, release: () => { released++; } };
  const code = await runLive({ ...ARGS, json: true }, ov);
  assert.equal(code, 1); assert.equal(emitted?.reason, 'preflight'); assert.equal(released, 0, 'no lock is held after a thrown preflight');
  let emitted2 = null; let released2 = 0;
  const ov2 = { ...overrides({}), loadPrior: () => ({ runId: 'r-old' }), reconcile: () => { throw new Error('status corrupt'); }, emit: (d) => { emitted2 = d; }, release: () => { released2++; } };
  const code2 = await runLive({ ...ARGS, json: true }, ov2);
  assert.equal(code2, 1); assert.equal(emitted2?.reason, 'dispatch-refused'); assert.equal(released2, 1, 'the preflight-held lock is released');
});
