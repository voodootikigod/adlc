import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo } from '@adlc/core/test-kit';
import { LegacyTicketStore } from '../lib/stores/legacy.mjs';
import { TicketService } from '../lib/service.mjs';

function makeTicket(id, extra = {}) {
  return {
    id,
    title: `Ticket ${id}`,
    category: 'feature',
    duration: 1,
    scope: ['src/**'],
    rails: [],
    edges: [],
    completed: false,
    ...extra,
  };
}

test('planReconciliation enforces #assertNoManifestRails and #assertRailsExist on newly introduced rails', (t) => {
  const { dir: root, g } = gitRepo(t, { prefix: 'adlc-reconcile-rails-' });
  mkdirSync(join(root, 'packages/demo/lib'), { recursive: true });
  writeFileSync(join(root, 'packages/demo/package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  writeFileSync(join(root, 'packages/demo/lib/app.mjs'), 'export const ok = true;\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');

  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc/tickets.json'), JSON.stringify({ tickets: [makeTicket('A')] }, null, 2));
  const store = new LegacyTicketStore(join(root, '.adlc/tickets.json'));
  const service = new TicketService(store, { root });

  assert.throws(
    () => service.planReconciliation([makeTicket('A'), makeTicket('B', { rails: ['packages/demo/**'] })], { authorized: true }),
    (err) => err.code === 'RAIL_COVERS_MANIFEST',
  );

  assert.throws(
    () => service.planReconciliation([makeTicket('A'), makeTicket('B', { rails: ['packages/does-not-exist/**'] })], { authorized: true }),
    (err) => err.code === 'RAIL_MATCHES_NOTHING',
  );

  // Valid existing non-manifest rail passes cleanly
  const validPlan = service.planReconciliation(
    [makeTicket('A'), makeTicket('B', { rails: ['packages/demo/lib/**'] })],
    { authorized: true },
  );
  assert.equal(validPlan.validation, 'valid');
  assert.equal(validPlan.evidenceRequired, false);
});

test('planReconciliation requires manifest evidence when deleting an existing ticket', (t) => {
  const { dir: root, g } = gitRepo(t, { prefix: 'adlc-reconcile-delete-' });
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');

  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc/tickets.json'), JSON.stringify({ tickets: [makeTicket('A'), makeTicket('B')] }, null, 2));
  const store = new LegacyTicketStore(join(root, '.adlc/tickets.json'));
  const service = new TicketService(store, { root });

  const deletePlan = service.planReconciliation([makeTicket('A')], { authorized: true });
  assert.equal(deletePlan.evidenceRequired, true);
  assert.deepEqual(deletePlan.fileOperations, [{ action: 'delete', id: 'B' }]);

  const after = service.apply(deletePlan);
  const manifestPath = join(root, '.adlc/manifest.jsonl');
  assert.equal(existsSync(manifestPath), true);
  const lines = readFileSync(manifestPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.data.operation, 'remote-reconciliation');
  assert.equal(entry.data.storeHash, after.hash);
});
