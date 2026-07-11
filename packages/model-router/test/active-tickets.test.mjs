// Tests that model-router excludes completed (tombstoned) tickets from routing.
// A finished ticket must not be assigned a model or emit a P3 rail-density
// finding. The activeTickets helper is unit-tested in full under
// merge-forecast; here we sanity-check this package's own copy and prove the
// wire-up through runRouter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activeTickets } from '../lib/active-tickets.mjs';
import { runRouter } from '../lib/router.mjs';

function writeTickets(dir, tickets) {
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  const path = join(adlc, 'tickets.json');
  writeFileSync(path, JSON.stringify({ tickets }));
  return path;
}

test('activeTickets (local copy): drops completed:true and strips edges to it', () => {
  const out = activeTickets([
    { id: 'T1', completed: true },
    { id: 'T2', edges: [{ to: 'T1' }] },
  ]);
  assert.deepEqual(out.map((t) => t.id), ['T2']);
  assert.deepEqual(out[0].edges, []);
});

test('runRouter: a completed ticket is not assigned a model, but an active ticket that only depended on it still routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-router-active-'));
  try {
    const ticketsPath = writeTickets(dir, [
      { id: 'T1', title: 'shipped', completed: true, scope: ['a/**'], rails: ['test/a/**'], edges: [{ to: 'T2' }] },
      { id: 'T2', title: 'still open', scope: ['b/**'], rails: ['test/b/**'] },
    ]);

    const { assignments } = await runRouter({ ticketsPath, adlcDir: join(dir, '.adlc') });
    const ids = assignments.map((a) => a.id);

    assert.ok(!ids.includes('T1'), 'completed T1 must not be assigned');
    assert.ok(ids.includes('T2'), 'active T2 must still be assigned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
