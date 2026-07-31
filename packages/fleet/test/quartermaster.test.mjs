// The fleet ↔ quartermaster seam (operating-stack §4c, §5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFloat } from '@adlc/core';
import { assertAdapterCanForceModel, assertNoArgvOverride, planSeats, previewArgv, quartermasterEngaged } from '../lib/quartermaster.mjs';
import { loadPlan, activeTickets } from '../lib/plan.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
import { HARNESS_DEFAULT_ALIAS } from '../lib/adapters/_shared.mjs';
import { HARNESS_DEFAULT_MODEL, REGISTRY_ENV } from '@adlc/quartermaster';

test('the default-model sentinel is the SAME string on both sides of the seam', () => {
  // quartermaster's validator exempts this value from the force rule; fleet's
  // adapters treat it as "do not put a model on the command line". If the two
  // ever diverged, one side would force a literal `default` while the other
  // believed nothing was forced — and validation would be exempting a value
  // dispatch never special-cases.
  assert.equal(HARNESS_DEFAULT_ALIAS, HARNESS_DEFAULT_MODEL);
});

test('a wholesale argv override cannot coexist with a registry seat', () => {
  // The override replaces the adapter's whole argv, dropping the forced `-m`.
  // A worker would then run the harness default while the records claimed the
  // registry model — silent substitution, which §4c forbids.
  assert.throws(() => assertNoArgvOverride({ adapterArgs: ['--custom'] }), /would drop the model the registry forces/);
  assert.throws(() => assertNoArgvOverride({ adapterArgs: [] }), /cannot both decide the command line/);
});

test('a global binary override cannot coexist with per-ticket registry adapters', () => {
  // --adapter-command is ONE binary, but the registry picks an adapter per
  // ticket: the override would run one harness's binary with another harness's
  // arguments (/opt/codex executing `run -m zai/glm-5.2`), and previewArgv
  // cannot see it, so the dry-run would report a command the live run never uses.
  assert.throws(() => assertNoArgvOverride({ adapterCommand: '/opt/codex' }), /selects an adapter PER TICKET/);
  assert.throws(() => assertNoArgvOverride({ adapterCommand: '/opt/codex' }), /dry-run could not see it/);
});

test('no override, no complaint', () => {
  assert.doesNotThrow(() => assertNoArgvOverride({}));
  assert.doesNotThrow(() => assertNoArgvOverride({ adapterArgs: null, adapterCommand: null }));
  assert.doesNotThrow(() => assertNoArgvOverride());
});

test('engagement keys on operator-local signals only', () => {
  const repoDir = '/repo';
  // An explicitly configured path engages the layer even when it is invalid,
  // so a path pointing inside the repo fails closed instead of falling back.
  assert.equal(quartermasterEngaged({ env: { [REGISTRY_ENV]: '/repo/quartermaster.json' }, repoDir }), true);
  assert.equal(quartermasterEngaged({ env: { [REGISTRY_ENV]: 'relative.json' }, repoDir }), true);
  // Nothing configured and no default file → not engaged.
  assert.equal(quartermasterEngaged({ env: { XDG_CONFIG_HOME: '/nowhere' }, repoDir, exists: () => false }), false);
  // Nothing configured but the default file exists → engaged.
  assert.equal(quartermasterEngaged({ env: { XDG_CONFIG_HOME: '/nowhere' }, repoDir, exists: () => true }), true);
});

test('a DISABLED default path engages the layer rather than falling back to legacy dispatch', () => {
  // The repo cannot be allowed to suppress the guard by making it refuse to
  // look: a wrapper exporting XDG_CONFIG_HOME inside the candidate tree must
  // route into loadRegistry (which fails closed and says why), not skip it.
  const repoDir = '/repo';
  assert.equal(
    quartermasterEngaged({ env: { XDG_CONFIG_HOME: '/repo/.config' }, repoDir, exists: () => false }),
    true,
    'an in-repo default path must ENGAGE so loading fails closed'
  );
});

// §4c on the legacy path: --model must not be silently discarded.
test('a model an adapter cannot force is rejected before dispatch', () => {
  for (const adapterName of ['cursor', 'pi', 'copilot']) {
    assert.throws(
      () => assertAdapterCanForceModel({ adapter: adapterName, model: 'vendor/frontier' }),
      /cannot be honoured by the "(cursor|pi|copilot)" adapter/,
      `${adapterName} must reject an explicit model it cannot pass on`
    );
  }
});

test('--model plus a wholesale argv override is rejected on the legacy path too', () => {
  // The engaged path already refuses this pairing; the legacy path must too.
  // `args ?? [...]` means a custom argv never builds the model flag, so the
  // model is discarded exactly as if the adapter could not carry it.
  assert.throws(
    () => assertAdapterCanForceModel({ adapter: 'opencode', model: 'zai/glm-5.2', adapterArgs: ['run', 'x'] }),
    /never renders the model flag/
  );
  // Without a model there is nothing to discard, so an override is fine.
  assert.doesNotThrow(() => assertAdapterCanForceModel({ adapter: 'opencode', adapterArgs: ['run', 'x'] }));
  assert.doesNotThrow(() => assertAdapterCanForceModel({ adapter: 'opencode', model: 'default', adapterArgs: ['run', 'x'] }));
});

test('a model an adapter CAN force is accepted, and the default sentinel is always fine', () => {
  for (const adapterName of ['claude-code', 'codex', 'opencode', 'agy']) {
    assert.doesNotThrow(() => assertAdapterCanForceModel({ adapter: adapterName, model: 'vendor/frontier' }));
  }
  // No model, or the sentinel, asks for the ambient default — honest everywhere.
  for (const adapterName of ['cursor', 'pi', 'copilot']) {
    assert.doesNotThrow(() => assertAdapterCanForceModel({ adapter: adapterName, model: 'default' }));
    assert.doesNotThrow(() => assertAdapterCanForceModel({ adapter: adapterName, model: null }));
    assert.doesNotThrow(() => assertAdapterCanForceModel({ adapter: adapterName }));
  }
});

// Completed tickets are removed from the backlog, but fleet's own activeTickets
// deliberately KEEPS edges pointing at them (its scheduler treats a completed
// prerequisite as satisfied). computeFloat cannot: it indexes predecessors by
// edge target and dereferences a missing one. This repo's real store carries
// four such edges, so getting this wrong means enabling a registry crashes
// planning on the project's own backlog before a single seat resolves.
test('the repo\'s own ticket store routes without crashing (completed-target edges)', () => {
  const all = loadPlan(join(REPO_ROOT, '.adlc', 'tickets.json'));
  const tickets = all.tickets ?? all;

  // Precondition: the fixture is only meaningful while such edges exist.
  const active = activeTickets(tickets);
  const activeIds = new Set(active.map((t) => t.id));
  const dangling = active.flatMap((t) => (t.edges ?? []).filter((e) => !activeIds.has(e.to)).map((e) => `${t.id}->${e.to}`));
  assert.ok(dangling.length > 0, `precondition: the store must contain completed-target edges (found ${dangling.length})`);

  // The raw active list is exactly what used to be passed in — prove it still breaks.
  assert.throws(() => computeFloat(active), TypeError, 'precondition: the un-normalized list really does crash computeFloat');

  // planSeats normalizes internally, so routing the FULL store succeeds. It
  // throws RegistryLoadError (no registry here), never a TypeError from CPM.
  try {
    planSeats({ tickets, repoDir: REPO_ROOT, env: { ADLC_QUARTERMASTER_REGISTRY: '/nonexistent/quartermaster.json' }, adlcDir: join(REPO_ROOT, '.adlc') });
    assert.fail('expected a registry load failure');
  } catch (e) {
    assert.ok(!(e instanceof TypeError), `planning must not crash on the DAG: ${e.stack}`);
    assert.match(e.message, /no registry at|registry/i);
    assert.doesNotMatch(e.message, /edges to unknown tickets/);
  }
});

test('an edge to a genuinely unknown ticket fails with a diagnosable error, not a TypeError', () => {
  const tickets = [
    { id: 'A', category: 'feature', duration: 1, edges: [{ to: 'GHOST' }], rails: [], scope: [] },
  ];
  assert.throws(
    () => planSeats({ tickets, repoDir: REPO_ROOT, env: { ADLC_QUARTERMASTER_REGISTRY: '/nonexistent/quartermaster.json' }, adlcDir: join(REPO_ROOT, '.adlc') }),
    /no registry at|edges to unknown tickets/
  );
});

test('previewArgv renders the argv through the adapter itself, spawning nothing', async () => {
  const argv = await previewArgv({
    seat: { adapter: 'opencode', model: 'zai/glm-5.2', transport: 'gateway:opencode-go', provider: 'zai' },
    prompt: 'build T1',
  });
  assert.equal(argv.cmd, 'opencode');
  assert.deepEqual(argv.args, ['run', '--format', 'json', '-m', 'zai/glm-5.2', 'build T1']);
});

test('previewArgv honours the default sentinel exactly as dispatch would', async () => {
  const argv = await previewArgv({
    seat: { adapter: 'claude-code', model: 'default', transport: 'subscription:anthropic-max', provider: 'anthropic' },
    prompt: 'build T1',
  });
  assert.equal(argv.cmd, 'claude');
  assert.ok(!argv.args.includes('--model'), 'the sentinel is not forced onto the command line');
});
