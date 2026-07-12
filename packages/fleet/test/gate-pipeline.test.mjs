import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGatePipeline, collectProtectedCandidates } from '../lib/gate-pipeline.mjs';
import { runFleet } from '../lib/run.mjs';
import { resolveRunConfig } from '../lib/config.mjs';
import { Sandbox, SANDBOX_MODES } from '../lib/sandbox.mjs';

const okSandbox = () => new Sandbox({
  mode: SANDBOX_MODES.SANDBOX, backend: { name: 'bubblewrap' }, worktree: '/wt', syntheticHome: '/wt/.home',
  exec: () => 'ok',
});
const ticket = { id: 'T1', scope: ['packages/fleet/**'] };
const templates = () => new Map([['.adlc/tickets.json', '{"tickets":[{"id":"T1"}]}']]);

test('gate pipeline passes when build/scope/protected-paths are clean', async () => {
  const r = await runGatePipeline(ticket, {
    sandbox: okSandbox(),
    gate: { build: 'true', test: 'true' },
    env: {},
    changedPaths: ['packages/fleet/lib/x.mjs'],
    templates: templates(),
    listProtected: () => ['.adlc/tickets.json'],
    readBytes: () => '{"tickets":[{"id":"T1"}]}', // matches template
  });
  assert.equal(r.ok, true, r.output);
});

test('gate pipeline FAILS at protected-paths on a tampered tickets.json (C1 wired)', async () => {
  const r = await runGatePipeline(ticket, {
    sandbox: okSandbox(),
    gate: { build: 'true' },
    env: {},
    changedPaths: ['packages/fleet/lib/x.mjs'],
    templates: templates(),
    listProtected: () => ['.adlc/tickets.json'],
    readBytes: () => '{"tickets":[{"id":"T1","rails":[]}]}', // worker dropped the rail
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'protected-paths');
  assert.match(r.output, /tickets\.json/);
});

test('gate pipeline FAILS at scope on an out-of-scope change', async () => {
  const r = await runGatePipeline(ticket, {
    sandbox: okSandbox(), gate: {}, env: {},
    changedPaths: ['packages/core/index.mjs'], // outside T1 scope
    templates: templates(), listProtected: () => [], readBytes: () => undefined,
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'scope');
});

test('collectProtectedCandidates checks git-surfaced protected files, skips inert logs', async () => {
  const cands = collectProtectedCandidates({
    listProtected: () => ['.adlc/tickets.json', '.adlc/fleet-logs/T1.log', 'src/app.js'],
    readBytes: (p) => `bytes-of-${p}`,
  });
  const paths = cands.map((c) => c.path);
  assert.ok(paths.includes('.adlc/tickets.json'), 'a git-surfaced trust-root mutation is a candidate');
  assert.ok(!paths.includes('.adlc/fleet-logs/T1.log'), 'inert logs are skipped');
  assert.ok(!paths.includes('src/app.js'), 'non-protected paths are skipped');
});

test('integration: a worker tampering .adlc/tickets.json cannot merge (C1 end-to-end)', async () => {
  const merges = [];
  // Wire the REAL gate pipeline as runFleet's gate effect; the worker "tampered"
  // the trust root, which git-diff (tracked) never sees but the scan catches.
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => {},
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'tip' }),
    dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
    gate: async ({ ticket }) => runGatePipeline(ticket, {
      sandbox: okSandbox(), gate: {}, env: {},
      changedPaths: ['packages/fleet/lib/x.mjs'],
      templates: templates(),
      listProtected: () => ['.adlc/tickets.json'],
      readBytes: () => '{"tickets":[{"id":"T1","rails":[]}]}', // tampered
    }),
    prosecute: () => ({ verdict: 'pass' }),
    flail: () => ({ flail: false }),
    mergeToIntegration: (a) => { merges.push(a); return { mergeSha: 'm', preMergeSha: 'p' }; },
    postMergeGate: () => ({ ok: true }),
    revertMerge: () => ({ method: 'reset', ok: true }),
  };
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all: [{ id: 'T1', title: 'T1', scope: ['packages/fleet/**'], edges: [] }], runId: 'x', config, deps });
  assert.equal(summary.results.T1, 'failed', 'a tampered trust root must fail the ticket');
  assert.equal(merges.length, 0, 'a tampered ticket must never reach merge');
});
