import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { stepsFor } from '../lib/maintenance.mjs';

/** Minimal fake ctx/deps: createRunSteps is pure closures — no I/O runs until a returned method is called. */
function fixture() {
  const calls = { mirror: 0, workerDeps: 0 };
  const ctx = {
    config: { autopilot: {} },
    log: () => {},
    paths: { issueWorktree: (n) => `/wt/${n}` },
    records: { load: () => null, update: () => {} },
    git: {},
  };
  const deps = {
    mirror: { createWorkerMirror: async () => { calls.mirror++; return '/mirror.git'; } },
    deps: { buildWorkerDeps: async () => { calls.workerDeps++; return '/deps'; } },
    effects: {},
  };
  return { ctx, deps, calls };
}

export async function ac7_stepsForWiresTheRealRound() {
  const { ctx, deps, calls } = fixture();
  const record = { issue: 7, ticketId: 'T1', ticketCache: { scope: ['packages/x/**'] }, issueRevision: null };
  const steps = await stepsFor({ ctx, deps, record });
  // Not null, not a bare object — the actual createRunSteps composition (round/attestTail/pushAndOpen
  // are its documented surface). A silent `return null` here (2026-08-31 mutation-gate finding) would
  // crash conflictFixRound/retryRound OUTSIDE their own try/catch instead of returning {ok:false}.
  assert.equal(typeof steps, 'object');
  assert.notEqual(steps, null);
  assert.equal(typeof steps.round, 'function');
  assert.equal(typeof steps.attestTail, 'function');
  assert.equal(typeof steps.pushAndOpen, 'function');
  assert.equal(calls.mirror, 1, 'the worker mirror was actually created');
  assert.equal(calls.workerDeps, 1, 'worker deps were actually built');
}
test('AC7: stepsFor composes a REAL createRunSteps from a fresh worker mirror and worker deps for the retry protocols', ac7_stepsForWiresTheRealRound);
