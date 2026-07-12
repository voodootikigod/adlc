import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFleet } from '../lib/run.mjs';
import { resolveRunConfig } from '../lib/config.mjs';

const T = (id, scope) => ({ id, title: id, scope, edges: [] });

// A controllable dispatch: each ticket's build blocks until we release it, so we
// can observe how many workers are concurrently in the building phase.
function gate() {
  let release;
  const promise = new Promise((r) => { release = r; });
  return { promise, release };
}

test('two non-overlapping tickets build CONCURRENTLY under cap ≥ 2 (C4)', async () => {
  const t1 = gate();
  const t2 = gate();
  const building = new Set();
  let maxConcurrent = 0;

  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: async ({ ticket }) => {
      building.add(ticket.id);
      maxConcurrent = Math.max(maxConcurrent, building.size);
      await (ticket.id === 'T1' ? t1.promise : t2.promise);
      building.delete(ticket.id);
      return { exitCode: 0, output: 'TICKET-DONE' };
    },
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: () => ({ mergeSha: 'm', preMergeSha: 'p' }),
    postMergeGate: () => ({ ok: true }),
    revertMerge: () => ({ method: 'reset', ok: true }),
  };
  const config = { ...resolveRunConfig({}, { concurrency: 2 }), baseSha: 'BASE' };
  const all = [T('T1', ['src/a/**']), T('T2', ['src/b/**'])];

  const runP = runFleet({ all, runId: 'c', config, deps });
  // Let both builds start, then release them.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(building.size, 2, 'both non-overlapping tickets are in the building phase at once');
  t1.release(); t2.release();
  const summary = await runP;
  assert.equal(maxConcurrent, 2, 'the pool ran two workers concurrently');
  assert.deepEqual(Object.values(summary.results).sort(), ['merged', 'merged']);
});

test('scope-overlapping tickets do NOT build concurrently even under a high cap', async () => {
  const g = gate();
  const building = new Set();
  let maxConcurrent = 0;
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: async ({ ticket }) => {
      building.add(ticket.id);
      maxConcurrent = Math.max(maxConcurrent, building.size);
      if (ticket.id === 'T1') await g.promise;
      building.delete(ticket.id);
      return { exitCode: 0, output: 'TICKET-DONE' };
    },
    gate: () => ({ ok: true }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: () => ({ mergeSha: 'm', preMergeSha: 'p' }),
    postMergeGate: () => ({ ok: true }),
    revertMerge: () => ({ method: 'reset', ok: true }),
  };
  const config = { ...resolveRunConfig({}, { concurrency: 5 }), baseSha: 'BASE' };
  const all = [T('T1', ['src/shared/**']), T('T2', ['src/shared/x.js'])]; // overlap
  const runP = runFleet({ all, runId: 'c2', config, deps });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(building.size, 1, 'overlapping tickets are serialized despite spare slots');
  g.release();
  await runP;
  assert.equal(maxConcurrent, 1);
});
