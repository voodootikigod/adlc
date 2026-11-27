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

const TEST_REGISTRY_PATH = '/operator/quartermaster.json';
const TEST_REGISTRY = {
  version: 3,
  channels: {
    frontier: { adapter: 'claude-code', model: 'claude-opus-5', transport: 'subscription:anthropic-max', provider: 'anthropic' },
    'frontier-metered': { adapter: 'claude-code', model: 'claude-opus-5', transport: 'api:anthropic-batch', provider: 'anthropic' },
    mid: { adapter: 'opencode', model: 'zai/glm-5.2', transport: 'gateway:opencode-go', provider: 'zai' },
    cheap: { adapter: 'opencode', model: 'deepseek/v4-flash', transport: 'gateway:opencode-go', provider: 'deepseek' },
  },
  reviewerGroups: {
    'cross-model-routine': { quorum: 1, members: [{ adapter: 'opencode', model: 'qwen/qwen3.7-coder', transport: 'gateway:opencode-go', provider: 'alibaba' }] },
    'cross-model-trust-root': {
      quorum: 2,
      members: [
        { adapter: 'opencode', model: 'moonshot/kimi-k3', transport: 'gateway:opencode-go', provider: 'moonshot' },
        { adapter: 'codex', model: 'gpt-5.3-codex', transport: 'subscription:chatgpt-plus', provider: 'openai', directAuth: true },
      ],
    },
  },
  modelProviders: {
    opencode: { 'zai/glm-5.2': 'zai', 'deepseek/v4-flash': 'deepseek', 'qwen/qwen3.7-coder': 'alibaba', 'moonshot/kimi-k3': 'moonshot' },
    'claude-code': { 'claude-opus-5': 'anthropic' },
    codex: { 'gpt-5.3-codex': 'openai' },
  },
};

function planWithTestRegistry(tickets) {
  return planSeats({
    tickets,
    repoDir: REPO_ROOT,
    adlcDir: join(REPO_ROOT, '.adlc'),
    env: { [REGISTRY_ENV]: TEST_REGISTRY_PATH },
    exists: (p) => p === TEST_REGISTRY_PATH,
    readFile: (p) => {
      if (p !== TEST_REGISTRY_PATH) throw new Error(`unexpected registry read: ${p}`);
      return JSON.stringify(TEST_REGISTRY);
    },
  });
}

// Completed tickets are removed from the backlog, but fleet's own activeTickets
// deliberately KEEPS edges pointing at them (its scheduler treats a completed
// prerequisite as satisfied). computeFloat cannot: it indexes predecessors by
// edge target and dereferences a missing one. Route both the live repository
// store as-is (even when every ticket is completed) and a DAG layered onto a
// real completed ticket from the store that mixes completed-target edges with a
// live critical-path / slack dependency, asserting exact float and channel routing.
test('the repo\'s own ticket store routes without crashing and preserves live DAG float alongside completed-target edges', () => {
  const all = loadPlan(join(REPO_ROOT, '.adlc', 'tickets.json'));
  const tickets = all.tickets ?? all;

  const liveActive = activeTickets(tickets);
  const liveRouted = planWithTestRegistry(tickets);
  assert.equal(liveRouted.seats.size, liveActive.length);

  const completedTarget = tickets.find((t) => t.completed === true);
  assert.ok(completedTarget, 'precondition: repo store must contain at least one completed ticket');

  const mixedDag = [
    ...tickets,
    {
      id: '__QM_CRIT_A__',
      title: 'critical prerequisite with live edge + completed-target edge',
      category: 'feature',
      duration: 100,
      body: 'x',
      edges: [{ to: '__QM_SINK_C__' }, { to: completedTarget.id }],
      rails: ['pkg-a/rail.test.mjs'],
      scope: ['pkg-a/impl.mjs'],
    },
    {
      id: '__QM_SLACK_B__',
      title: 'side-branch prerequisite whose float depends on live edge preservation',
      category: 'feature',
      duration: 1,
      body: 'x',
      edges: [{ to: '__QM_SINK_C__' }],
      rails: ['pkg-b/rail.test.mjs'],
      scope: ['pkg-b/impl.mjs'],
    },
    {
      id: '__QM_SINK_C__',
      title: 'critical sink with completed-target edge',
      category: 'feature',
      duration: 1,
      body: 'x',
      edges: [{ to: completedTarget.id }],
      rails: ['pkg-c/rail.test.mjs'],
      scope: ['pkg-c/impl.mjs'],
    },
  ];

  const active = activeTickets(mixedDag);
  const activeIds = new Set(active.map((t) => t.id));
  const dangling = active.flatMap((t) => (t.edges ?? []).filter((e) => !activeIds.has(e.to)).map((e) => `${t.id}->${e.to}`));
  assert.ok(dangling.length >= 2, `precondition: mixed DAG must carry completed-target edges (found ${dangling.length})`);

  // Un-normalized activeTickets retains completed-target edges and crashes computeFloat.
  assert.throws(() => computeFloat(active), TypeError, 'precondition: the un-normalized list really does crash computeFloat');

  // planSeats drops completed-target edges while keeping live edges intact:
  // __QM_CRIT_A__ (dur 100) -> __QM_SINK_C__ (dur 1) dominates makespan (float 0),
  // while __QM_SLACK_B__ (dur 1) -> __QM_SINK_C__ gets slack float 99 (non-frontier).
  const routed = planWithTestRegistry(mixedDag);
  assert.equal(routed.seats.size, active.length);
  assert.equal(routed.seats.get('__QM_CRIT_A__')?.assignment.float, 0);
  assert.equal(routed.seats.get('__QM_SINK_C__')?.assignment.float, 0);
  assert.equal(routed.seats.get('__QM_SLACK_B__')?.assignment.float, 99);
  assert.equal(routed.seats.get('__QM_CRIT_A__')?.route.channel, 'frontier');
  assert.notEqual(routed.seats.get('__QM_SLACK_B__')?.route.channel, 'frontier');
});

test('an edge to a genuinely unknown ticket fails with a diagnosable error, not a TypeError', () => {
  const tickets = [
    { id: 'A', category: 'feature', duration: 1, edges: [{ to: 'GHOST' }], rails: [], scope: [] },
  ];
  assert.throws(
    () => planWithTestRegistry(tickets),
    /edges to unknown tickets: A -> GHOST/
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
