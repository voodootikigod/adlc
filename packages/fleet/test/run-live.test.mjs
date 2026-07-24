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
